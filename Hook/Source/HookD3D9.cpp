/** D3D9 manager/CreateDevice hook. */
#include "HookD3D9.h"
#include "HookDetours.h"
#include "HookLogging.h"
#include "HookOverlay.h"
#include "HookState.h"

#include <atomic>
#include <d3d9.h>

namespace
{
// RVA uses the PE image base (0x00400000).
constexpr uint32_t kRva_D3D9Mgr_Init = 0x0020AE90;
constexpr uint32_t kRva_D3D9Mgr_Ptr = 0x00342970;
constexpr uint8_t kD3D9MgrInitPrologue[] = {0x56, 0x8B, 0xF1, 0x8B, 0x06};
constexpr size_t kD3D9MgrInitLen = sizeof(kD3D9MgrInitPrologue);
constexpr size_t kD3D9CreateDeviceIndex = 16; // IDirect3D9::CreateDevice

using D3D9MgrInitFn = char(__thiscall*)(void* ThisPtr);
using Direct3DCreate9Fn = IDirect3D9* (WINAPI *)(UINT);
using Direct3DCreate9ExFn = HRESULT(WINAPI *)(UINT, IDirect3D9Ex**);
using GetProcAddressFn = FARPROC (WINAPI *)(HMODULE, LPCSTR);
using D3D9CreateDeviceFn = HRESULT(WINAPI *)(IDirect3D9* Self, UINT Adapter, D3DDEVTYPE DeviceType,
                                            HWND FocusWindow, DWORD BehaviorFlags,
                                            D3DPRESENT_PARAMETERS* Params,
                                            IDirect3DDevice9** OutDevice);
using D3D9CreateDeviceExFn = HRESULT(WINAPI *)(IDirect3D9Ex* Self, UINT Adapter, D3DDEVTYPE DeviceType,
                                               HWND FocusWindow, DWORD BehaviorFlags,
                                               D3DPRESENT_PARAMETERS* Params,
                                               D3DDISPLAYMODEEX* FullscreenDisplayMode,
                                               IDirect3DDevice9Ex** OutDevice);
using D3D9PresentFn = HRESULT(WINAPI *)(IDirect3DDevice9* Self, const RECT* SourceRect,
                                        const RECT* DestRect, HWND DestWindowOverride,
                                        const RGNDATA* DirtyRegion);
using D3D9EndSceneFn = HRESULT(WINAPI *)(IDirect3DDevice9* Self);

static D3D9MgrInitFn D3D9MgrInit_Orig = nullptr;
static D3D9CreateDeviceFn D3D9CreateDevice_Orig = nullptr;
static Direct3DCreate9Fn Direct3DCreate9_Orig = nullptr;
static Direct3DCreate9ExFn Direct3DCreate9Ex_Orig = nullptr;
static D3D9CreateDeviceExFn D3D9CreateDeviceEx_Orig = nullptr;
static D3D9PresentFn D3D9Present_Orig = nullptr;
static D3D9EndSceneFn D3D9EndScene_Orig = nullptr;
static GetProcAddressFn GetProcAddress_Orig = nullptr;

static std::atomic<bool> GD3D9MgrHookInstalled{false};
static std::atomic<bool> GD3D9VtableHooked{false};
static std::atomic<bool> GD3D9DeviceLogged{false};
static std::atomic<bool> GD3D9RescanStarted{false};
static std::atomic<bool> GD3D9DeviceHooked{false};
static std::atomic<bool> GD3D9ExportHooked{false};
static std::atomic<bool> GD3D9VtableProbeLogged{false};
static std::atomic<bool> GD3D9RescanLogged{false};
static std::atomic<bool> GD3D9EndSceneLogged{false};
static std::atomic<bool> GD3D9DummyPatched{false};
static std::atomic<bool> GD3D9MgrLogged{false};
static std::atomic<bool> GD3D9RescanNullLogged{false};

static IDirect3D9* WINAPI HookDirect3DCreate9(UINT SdkVersion);
static HRESULT WINAPI HookDirect3DCreate9Ex(UINT SdkVersion, IDirect3D9Ex** OutD3D9);
static void HookD3D9DeviceVtable(IDirect3DDevice9* Device);

// Present hook drives the debug HUD overlay each frame.
static HRESULT WINAPI HookD3D9Present(IDirect3DDevice9* Self, const RECT* SourceRect,
                                      const RECT* DestRect, HWND DestWindowOverride,
                                      const RGNDATA* DirtyRegion)
{
    OverlayRender(Self);
    return D3D9Present_Orig ? D3D9Present_Orig(Self, SourceRect, DestRect, DestWindowOverride, DirtyRegion) : D3D_OK;
}

// EndScene hook as a fallback if Present is bypassed (e.g., PresentEx paths).
static HRESULT WINAPI HookD3D9EndScene(IDirect3DDevice9* Self)
{
    if (!GD3D9EndSceneLogged.exchange(true))
    {
        LOG("[Hook] D3D9 EndScene hook active");
    }
    OverlayRender(Self);
    return D3D9EndScene_Orig ? D3D9EndScene_Orig(Self) : D3D_OK;
}

static void PatchDeviceVtableFromDummy()
{
    if (GD3D9DummyPatched.exchange(true))
    {
        return;
    }

    HMODULE D3D9 = GetModuleHandleA("d3d9.dll");
    if (!D3D9)
    {
        LOG("[Hook] D3D9 dummy device: d3d9.dll not loaded");
        return;
    }
    auto Create9 = reinterpret_cast<Direct3DCreate9Fn>(GetProcAddress(D3D9, "Direct3DCreate9"));
    auto Create9Ex = reinterpret_cast<Direct3DCreate9ExFn>(GetProcAddress(D3D9, "Direct3DCreate9Ex"));

    WNDCLASSA wc = {};
    wc.lpfnWndProc = DefWindowProcA;
    wc.hInstance = GetModuleHandleA(nullptr);
    wc.lpszClassName = "FoMHookDummyD3D9";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowExA(0, wc.lpszClassName, "FoMHookDummyD3D9", WS_OVERLAPPEDWINDOW,
                                0, 0, 16, 16, nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd)
    {
        LOG("[Hook] D3D9 dummy device: window create failed (err=%lu)", GetLastError());
        return;
    }

    if (Create9Ex)
    {
        IDirect3D9Ex* d3dEx = nullptr;
        HRESULT exHr = Create9Ex(D3D_SDK_VERSION, &d3dEx);
        if (SUCCEEDED(exHr) && d3dEx)
        {
            D3DDISPLAYMODEEX modeEx = {};
            modeEx.Size = sizeof(modeEx);
            HRESULT modeExHr = d3dEx->GetAdapterDisplayModeEx(D3DADAPTER_DEFAULT, &modeEx, nullptr);
            if (FAILED(modeExHr))
            {
                LOG("[Hook] D3D9 dummy device: GetAdapterDisplayModeEx failed (hr=0x%08lx)", static_cast<unsigned long>(modeExHr));
                modeEx.Format = D3DFMT_X8R8G8B8;
                modeEx.Width = 16;
                modeEx.Height = 16;
            }

            D3DPRESENT_PARAMETERS ppEx = {};
            ppEx.Windowed = TRUE;
            ppEx.SwapEffect = D3DSWAPEFFECT_DISCARD;
            ppEx.hDeviceWindow = hwnd;
            ppEx.BackBufferFormat = modeEx.Format;
            ppEx.BackBufferWidth = 16;
            ppEx.BackBufferHeight = 16;
            ppEx.BackBufferCount = 1;
            ppEx.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;

            IDirect3DDevice9Ex* deviceEx = nullptr;
            HRESULT devExHr = d3dEx->CreateDeviceEx(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hwnd,
                                                    D3DCREATE_SOFTWARE_VERTEXPROCESSING, &ppEx,
                                                    nullptr, &deviceEx);
            if (SUCCEEDED(devExHr) && deviceEx)
            {
                HookD3D9DeviceVtable(deviceEx);
                LOG("[Hook] D3D9 dummy device (Ex) patched vtable");
                deviceEx->Release();
            }
            else
            {
                LOG("[Hook] D3D9 dummy device: CreateDeviceEx failed (hr=0x%08lx)", static_cast<unsigned long>(devExHr));
            }

            d3dEx->Release();
        }
        else
        {
            LOG("[Hook] D3D9 dummy device: Direct3DCreate9Ex failed (hr=0x%08lx)", static_cast<unsigned long>(exHr));
        }
    }

    if (!Create9)
    {
        LOG("[Hook] D3D9 dummy device: Direct3DCreate9 missing");
        DestroyWindow(hwnd);
        return;
    }

    IDirect3D9* d3d = Create9(D3D_SDK_VERSION);
    if (!d3d)
    {
        LOG("[Hook] D3D9 dummy device: Direct3DCreate9 returned null");
        DestroyWindow(hwnd);
        return;
    }

    D3DDISPLAYMODE mode = {};
    HRESULT modeHr = d3d->GetAdapterDisplayMode(D3DADAPTER_DEFAULT, &mode);
    if (FAILED(modeHr))
    {
        LOG("[Hook] D3D9 dummy device: GetAdapterDisplayMode failed (hr=0x%08lx)", static_cast<unsigned long>(modeHr));
        mode.Format = D3DFMT_X8R8G8B8;
    }

    D3DPRESENT_PARAMETERS pp = {};
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.hDeviceWindow = hwnd;
    pp.BackBufferFormat = mode.Format;
    pp.BackBufferWidth = 16;
    pp.BackBufferHeight = 16;
    pp.BackBufferCount = 1;
    pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;

    IDirect3DDevice9* device = nullptr;
    HRESULT hr = d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hwnd,
                                   D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &device);
    if (FAILED(hr))
    {
        LOG("[Hook] D3D9 dummy device: HAL CreateDevice failed (hr=0x%08lx)", static_cast<unsigned long>(hr));
        hr = d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_REF, hwnd,
                               D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &device);
    }
    if (SUCCEEDED(hr) && device)
    {
        HookD3D9DeviceVtable(device);
        LOG("[Hook] D3D9 dummy device patched vtable");
        device->Release();
    }
    else
    {
        LOG("[Hook] D3D9 dummy device: REF CreateDevice failed (hr=0x%08lx)", static_cast<unsigned long>(hr));
    }
    d3d->Release();
    DestroyWindow(hwnd);
}

// Patch the device vtable once so we can draw on Present.
static void HookD3D9DeviceVtable(IDirect3DDevice9* Device)
{
    if (!Device || GD3D9DeviceHooked.load())
    {
        return;
    }
    void** Vtbl = *reinterpret_cast<void***>(Device);
    if (!Vtbl)
    {
        return;
    }
    constexpr size_t kD3D9PresentIndex = 17; // IDirect3DDevice9::Present
    constexpr size_t kD3D9EndSceneIndex = 42; // IDirect3DDevice9::EndScene
    void* Target = Vtbl[kD3D9PresentIndex];
    if (!Target)
    {
        return;
    }
    DWORD OldProt = 0;
    if (!VirtualProtect(&Vtbl[kD3D9PresentIndex], sizeof(void*), PAGE_EXECUTE_READWRITE, &OldProt))
    {
        return;
    }
    if (!D3D9Present_Orig)
    {
        D3D9Present_Orig = reinterpret_cast<D3D9PresentFn>(Target);
    }
    Vtbl[kD3D9PresentIndex] = reinterpret_cast<void*>(&HookD3D9Present);
    VirtualProtect(&Vtbl[kD3D9PresentIndex], sizeof(void*), OldProt, &OldProt);
    FlushInstructionCache(GetCurrentProcess(), &Vtbl[kD3D9PresentIndex], sizeof(void*));
    LOG("[Hook] D3D9 Device::Present vtbl patched");

    if (Vtbl[kD3D9EndSceneIndex])
    {
        DWORD OldProtEnd = 0;
        if (VirtualProtect(&Vtbl[kD3D9EndSceneIndex], sizeof(void*), PAGE_EXECUTE_READWRITE, &OldProtEnd))
        {
            if (!D3D9EndScene_Orig)
            {
                D3D9EndScene_Orig = reinterpret_cast<D3D9EndSceneFn>(Vtbl[kD3D9EndSceneIndex]);
            }
            Vtbl[kD3D9EndSceneIndex] = reinterpret_cast<void*>(&HookD3D9EndScene);
            VirtualProtect(&Vtbl[kD3D9EndSceneIndex], sizeof(void*), OldProtEnd, &OldProtEnd);
            FlushInstructionCache(GetCurrentProcess(), &Vtbl[kD3D9EndSceneIndex], sizeof(void*));
            LOG("[Hook] D3D9 EndScene vtbl patched");
        }
    }

    GD3D9DeviceHooked.store(true);
}

// Fallback: detour D3D9 exports if the client resolves them dynamically.
static bool TryHookD3D9Exports()
{
    if (GD3D9ExportHooked.load())
    {
        return true;
    }
    HMODULE D3D9 = GetModuleHandleA("d3d9.dll");
    if (!D3D9)
    {
        return false;
    }
    bool HookedAny = false;
    FARPROC Create9 = GetProcAddress(D3D9, "Direct3DCreate9");
    if (Create9)
    {
        if (InstallDetourAt(reinterpret_cast<void*>(Create9), 5, reinterpret_cast<void*>(&HookDirect3DCreate9),
                            reinterpret_cast<void**>(&Direct3DCreate9_Orig), "Direct3DCreate9"))
        {
            HookedAny = true;
            LOG("[Hook] Direct3DCreate9 export detoured");
        }
    }
    FARPROC Create9Ex = GetProcAddress(D3D9, "Direct3DCreate9Ex");
    if (Create9Ex)
    {
        if (InstallDetourAt(reinterpret_cast<void*>(Create9Ex), 5, reinterpret_cast<void*>(&HookDirect3DCreate9Ex),
                            reinterpret_cast<void**>(&Direct3DCreate9Ex_Orig), "Direct3DCreate9Ex"))
        {
            HookedAny = true;
            LOG("[Hook] Direct3DCreate9Ex export detoured");
        }
    }
    if (HookedAny)
    {
        GD3D9ExportHooked.store(true);
    }
    return HookedAny;
}

// D3D9 CreateDevice hook captures the device and installs Present.
static HRESULT WINAPI HookD3D9CreateDevice(IDirect3D9* Self, UINT Adapter, D3DDEVTYPE DeviceType,
                                          HWND FocusWindow, DWORD BehaviorFlags,
                                          D3DPRESENT_PARAMETERS* Params,
                                          IDirect3DDevice9** OutDevice)
{
    LOG("[Hook] Direct3D9::CreateDevice called");
    HRESULT Result = D3D9CreateDevice_Orig
        ? D3D9CreateDevice_Orig(Self, Adapter, DeviceType, FocusWindow, BehaviorFlags, Params, OutDevice)
        : E_FAIL;
    if (SUCCEEDED(Result) && OutDevice && *OutDevice)
    {
        GD3D9Device = *OutDevice;
        HookD3D9DeviceVtable(*OutDevice);
        if (!GD3D9DeviceLogged.exchange(true))
        {
            LOG("[Hook] D3D9 CreateDevice -> %p (behavior=0x%lx)", *OutDevice, static_cast<unsigned long>(BehaviorFlags));
        }
    }
    return Result;
}

// D3D9Ex CreateDeviceEx hook captures the device and installs Present.
static HRESULT WINAPI HookD3D9CreateDeviceEx(IDirect3D9Ex* Self, UINT Adapter, D3DDEVTYPE DeviceType,
                                             HWND FocusWindow, DWORD BehaviorFlags,
                                             D3DPRESENT_PARAMETERS* Params,
                                             D3DDISPLAYMODEEX* FullscreenDisplayMode,
                                             IDirect3DDevice9Ex** OutDevice)
{
    LOG("[Hook] Direct3D9Ex::CreateDeviceEx called");
    HRESULT Result = D3D9CreateDeviceEx_Orig
        ? D3D9CreateDeviceEx_Orig(Self, Adapter, DeviceType, FocusWindow, BehaviorFlags,
                                  Params, FullscreenDisplayMode, OutDevice)
        : E_FAIL;
    if (SUCCEEDED(Result) && OutDevice && *OutDevice)
    {
        GD3D9Device = *OutDevice;
        HookD3D9DeviceVtable(*OutDevice);
        if (!GD3D9DeviceLogged.exchange(true))
        {
            LOG("[Hook] D3D9 CreateDeviceEx -> %p (behavior=0x%lx)", *OutDevice,
                static_cast<unsigned long>(BehaviorFlags));
        }
    }
    return Result;
}

// Catch dynamic D3D9 loading via GetProcAddress and redirect to our hooks.
static FARPROC WINAPI HookGetProcAddress(HMODULE Module, LPCSTR Name)
{
    FARPROC Proc = GetProcAddress_Orig ? GetProcAddress_Orig(Module, Name) : nullptr;
    if (!Name)
    {
        return Proc;
    }
    if (strcmp(Name, "Direct3DCreate9") == 0)
    {
        if (!Direct3DCreate9_Orig && Proc)
        {
            Direct3DCreate9_Orig = reinterpret_cast<Direct3DCreate9Fn>(Proc);
        }
        return reinterpret_cast<FARPROC>(&HookDirect3DCreate9);
    }
    if (strcmp(Name, "Direct3DCreate9Ex") == 0)
    {
        if (!Direct3DCreate9Ex_Orig && Proc)
        {
            Direct3DCreate9Ex_Orig = reinterpret_cast<Direct3DCreate9ExFn>(Proc);
        }
        return reinterpret_cast<FARPROC>(&HookDirect3DCreate9Ex);
    }
    return Proc;
}

static void HookD3D9Vtable(IDirect3D9* D3D9)
{
    if (!D3D9)
    {
        if (!GD3D9VtableProbeLogged.exchange(true))
        {
            LOG("[Hook] D3D9 vtable probe saw null device");
        }
        return;
    }
    if (!GD3D9VtableProbeLogged.exchange(true))
    {
        LOG("[Hook] D3D9 vtable probe: %p", D3D9);
    }
    if (!D3D9 || GD3D9VtableHooked.load())
    {
        return;
    }
    void** Vtbl = *reinterpret_cast<void***>(D3D9);
    if (!Vtbl)
    {
        return;
    }
    void* Target = Vtbl[kD3D9CreateDeviceIndex];
    if (!Target)
    {
        return;
    }
    DWORD OldProt = 0;
    if (!VirtualProtect(&Vtbl[kD3D9CreateDeviceIndex], sizeof(void*), PAGE_EXECUTE_READWRITE, &OldProt))
    {
        return;
    }
    if (!D3D9CreateDevice_Orig)
    {
        D3D9CreateDevice_Orig = reinterpret_cast<D3D9CreateDeviceFn>(Target);
    }
    Vtbl[kD3D9CreateDeviceIndex] = reinterpret_cast<void*>(&HookD3D9CreateDevice);
    VirtualProtect(&Vtbl[kD3D9CreateDeviceIndex], sizeof(void*), OldProt, &OldProt);
    FlushInstructionCache(GetCurrentProcess(), &Vtbl[kD3D9CreateDeviceIndex], sizeof(void*));
    GD3D9VtableHooked.store(true);
    LOG("[Hook] D3D9 CreateDevice vtbl patched");

    constexpr size_t kD3D9CreateDeviceExIndex = 20; // IDirect3D9Ex::CreateDeviceEx
    if (Vtbl[kD3D9CreateDeviceExIndex])
    {
        DWORD OldProtEx = 0;
        if (VirtualProtect(&Vtbl[kD3D9CreateDeviceExIndex], sizeof(void*), PAGE_EXECUTE_READWRITE, &OldProtEx))
        {
            if (!D3D9CreateDeviceEx_Orig)
            {
                D3D9CreateDeviceEx_Orig = reinterpret_cast<D3D9CreateDeviceExFn>(Vtbl[kD3D9CreateDeviceExIndex]);
            }
            Vtbl[kD3D9CreateDeviceExIndex] = reinterpret_cast<void*>(&HookD3D9CreateDeviceEx);
            VirtualProtect(&Vtbl[kD3D9CreateDeviceExIndex], sizeof(void*), OldProtEx, &OldProtEx);
            FlushInstructionCache(GetCurrentProcess(), &Vtbl[kD3D9CreateDeviceExIndex], sizeof(void*));
            LOG("[Hook] D3D9 CreateDeviceEx vtbl patched");
        }
    }
}

static IDirect3D9* WINAPI HookDirect3DCreate9(UINT SdkVersion)
{
    LOG("[Hook] Direct3DCreate9 called (sdk=%u)", SdkVersion);
    IDirect3D9* D3D9 = Direct3DCreate9_Orig ? Direct3DCreate9_Orig(SdkVersion) : nullptr;
    HookD3D9Vtable(D3D9);
    return D3D9;
}

static HRESULT WINAPI HookDirect3DCreate9Ex(UINT SdkVersion, IDirect3D9Ex** OutD3D9)
{
    LOG("[Hook] Direct3DCreate9Ex called (sdk=%u)", SdkVersion);
    HRESULT Result = Direct3DCreate9Ex_Orig ? Direct3DCreate9Ex_Orig(SdkVersion, OutD3D9) : E_FAIL;
    if (SUCCEEDED(Result) && OutD3D9 && *OutD3D9)
    {
        HookD3D9Vtable(*OutD3D9);
    }
    return Result;
}

static char __fastcall HookD3D9Mgr_Init(void* ThisPtr, void* Edx)
{
    (void)Edx;
    char Result = D3D9MgrInit_Orig ? D3D9MgrInit_Orig(ThisPtr) : 0;
    IDirect3D9* D3D9 = nullptr;
    if (ThisPtr)
    {
        D3D9 = *reinterpret_cast<IDirect3D9**>(ThisPtr);
    }
    HookD3D9Vtable(D3D9);
    if (!GD3D9MgrLogged.exchange(true))
    {
        LOG("[Hook] D3D9Mgr_Init called (mgr=%p d3d=%p)", ThisPtr, D3D9);
    }
    return Result;
}

// Rescan for the D3D9 manager in case we miss the initial creation path.
static DWORD WINAPI D3D9RescanThread(LPVOID)
{
    DWORD DelayMs = GConfig.RescanMs ? GConfig.RescanMs : 1000;
    for (;;)
    {
        if (GD3D9VtableHooked.load())
        {
            return 0;
        }
        TryHookD3D9Exports();
        IDirect3D9* D3D9 = nullptr;
        if (GExeBase)
        {
            __try
            {
                auto Slot = reinterpret_cast<IDirect3D9**>(GExeBase + kRva_D3D9Mgr_Ptr);
                D3D9 = Slot ? *Slot : nullptr;
            }
            __except (EXCEPTION_EXECUTE_HANDLER)
            {
                D3D9 = nullptr;
            }
        }
        if (!D3D9 && !GD3D9RescanNullLogged.exchange(true))
        {
            LOG("[Hook] D3D9 rescan: manager device slot empty");
        }
        if (D3D9 && !GD3D9RescanLogged.exchange(true))
        {
            LOG("[Hook] D3D9 rescan found manager device: %p", D3D9);
        }
        if (D3D9)
        {
            HookD3D9Vtable(D3D9);
        }
        Sleep(DelayMs);
    }
}
} // namespace

void EnsureD3D9Hooks()
{
    if (GD3D9MgrHookInstalled.load() && GD3D9RescanStarted.load())
    {
        return;
    }
    if (!GExeBase)
    {
        return;
    }
    bool DetourOk = InstallDetourChecked("D3D9Mgr_Init", kRva_D3D9Mgr_Init, kD3D9MgrInitLen,
                                         kD3D9MgrInitPrologue, reinterpret_cast<void*>(&HookD3D9Mgr_Init),
                                         reinterpret_cast<void**>(&D3D9MgrInit_Orig));
    if (DetourOk)
    {
        GD3D9MgrHookInstalled.store(true);
        LOG("[Hook] D3D9Mgr_Init detoured");
    }
    else
    {
        LOG("[Hook] D3D9Mgr_Init detour failed");
    }

    if (PatchIat(GetModuleHandleA(nullptr), "d3d9.dll", "Direct3DCreate9",
                 reinterpret_cast<void*>(&HookDirect3DCreate9),
                 reinterpret_cast<void**>(&Direct3DCreate9_Orig)))
    {
        LOG("[Hook] Direct3DCreate9 IAT hooked");
    }
    else
    {
        LOG("[Hook] Direct3DCreate9 IAT hook failed");
    }

    if (PatchIat(GetModuleHandleA(nullptr), "d3d9.dll", "Direct3DCreate9Ex",
                 reinterpret_cast<void*>(&HookDirect3DCreate9Ex),
                 reinterpret_cast<void**>(&Direct3DCreate9Ex_Orig)))
    {
        LOG("[Hook] Direct3DCreate9Ex IAT hooked");
    }
    else
    {
        LOG("[Hook] Direct3DCreate9Ex IAT hook failed");
    }

    if (PatchIat(GetModuleHandleA(nullptr), "kernel32.dll", "GetProcAddress",
                 reinterpret_cast<void*>(&HookGetProcAddress),
                 reinterpret_cast<void**>(&GetProcAddress_Orig)))
    {
        LOG("[Hook] GetProcAddress IAT hooked");
    }
    else
    {
        LOG("[Hook] GetProcAddress IAT hook failed");
    }

    if (PatchIat(GetModuleHandleA(nullptr), "kernelbase.dll", "GetProcAddress",
                 reinterpret_cast<void*>(&HookGetProcAddress),
                 reinterpret_cast<void**>(&GetProcAddress_Orig)))
    {
        LOG("[Hook] GetProcAddress (kernelbase) IAT hooked");
    }
    else
    {
        LOG("[Hook] GetProcAddress (kernelbase) IAT hook failed");
    }

    TryHookD3D9Exports();
    if (!GD3D9DeviceHooked.load())
    {
        PatchDeviceVtableFromDummy();
    }

    if (!GD3D9RescanStarted.exchange(true))
    {
        CreateThread(nullptr, 0, D3D9RescanThread, nullptr, 0, nullptr);
    }
}
