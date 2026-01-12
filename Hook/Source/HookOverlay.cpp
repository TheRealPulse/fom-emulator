/** Minimal admin HUD overlay rendered via D3D9 backbuffer GDI. */
#include "HookOverlay.h"
#include "HookLogging.h"
#include "HookState.h"

#include <d3d9.h>
#include <stdio.h>
#include <fstream>
#include <string>
#include <vector>

namespace
{
static bool GOverlayVisible = false;
static bool GOverlayKeyDown = false;
static HFONT GOverlayFont = nullptr;
static DWORD GOverlayLastKeyLog = 0;
static bool GOverlayFirstRender = true;
static HWND GOverlayWnd = nullptr;
static HANDLE GOverlayThread = nullptr;
static HANDLE GOverlayStopEvent = nullptr;
static DWORD GOverlayThreadId = 0;
static const char* GOverlayClassName = "FoMHookOverlayWnd";
static std::string GWorldInput;
static std::string GWorldStatus;
static bool GInputKeyDown[256] = {};
static DWORD GWorldLastAction = 0;
static DWORD GOverlayStartTick = 0;
static DWORD GWorldInfoLastRefresh = 0;
static int GCurrentWorldId = 0;
static std::string GCurrentWorldName;
static bool GWindowOverlayActive = false;
static HWND GTargetWindow = nullptr;
static DWORD GTargetLastScan = 0;
static const bool GUseD3DOverlay = false;
static HANDLE GOverlayMutex = nullptr;

static bool IsGameProcess()
{
    char path[MAX_PATH] = {0};
    if (!GetModuleFileNameA(nullptr, path, MAX_PATH))
    {
        return false;
    }
    const char* name = strrchr(path, '\\');
    name = name ? name + 1 : path;
    if (_stricmp(name, "fom_client.exe") == 0)
    {
        return true;
    }
    return false;
}

static bool IsWindowCandidate(HWND hwnd)
{
    if (!hwnd || hwnd == GOverlayWnd)
    {
        return false;
    }
    if (!IsWindowVisible(hwnd))
    {
        return false;
    }
    LONG exStyle = GetWindowLongA(hwnd, GWL_EXSTYLE);
    if (exStyle & WS_EX_TOOLWINDOW)
    {
        return false;
    }
    char className[128] = {0};
    GetClassNameA(hwnd, className, sizeof(className));
    if (_stricmp(className, "ConsoleWindowClass") == 0)
    {
        return false;
    }
    char title[256] = {0};
    GetWindowTextA(hwnd, title, sizeof(title));
    if (title[0] == '\0')
    {
        return false;
    }
    if (_stricmp(title, "FoM Hook Log") == 0 || _stricmp(title, "FoM Admin HUD") == 0)
    {
        return false;
    }
    return true;
}

static HWND FindBestProcessWindow()
{
    HWND best = nullptr;
    RECT bestRect = {};
    DWORD pid = GetCurrentProcessId();
    for (HWND hwnd = GetTopWindow(nullptr); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT))
    {
        DWORD hwndPid = 0;
        GetWindowThreadProcessId(hwnd, &hwndPid);
        if (hwndPid != pid)
        {
            continue;
        }
        if (!IsWindowCandidate(hwnd))
        {
            continue;
        }
        RECT rect = {};
        if (!GetWindowRect(hwnd, &rect))
        {
            continue;
        }
        int w = rect.right - rect.left;
        int h = rect.bottom - rect.top;
        if (w <= 0 || h <= 0)
        {
            continue;
        }
        const int area = w * h;
        const int bestArea = (bestRect.right - bestRect.left) * (bestRect.bottom - bestRect.top);
        if (!best || area > bestArea)
        {
            best = hwnd;
            bestRect = rect;
        }
    }
    return best;
}

static HWND FindTargetWindow()
{
    HWND best = FindBestProcessWindow();
    if (best)
    {
        return best;
    }
    HWND hwnd = GetForegroundWindow();
    if (!hwnd)
    {
        return nullptr;
    }
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId())
    {
        return nullptr;
    }
    if (!IsWindowCandidate(hwnd))
    {
        return nullptr;
    }
    return hwnd;
}

static std::string GetModuleDir()
{
    char path[MAX_PATH] = {0};
    HMODULE self = reinterpret_cast<HMODULE>(&__ImageBase);
    DWORD len = GetModuleFileNameA(self, path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH)
    {
        return "";
    }
    char* slash = strrchr(path, '\\');
    if (!slash)
    {
        return "";
    }
    slash[1] = '\0';
    return std::string(path);
}

static std::string GetRepoRoot()
{
    std::string moduleDir = GetModuleDir();
    if (moduleDir.empty())
    {
        return "";
    }
    const char* needle = "\\Client\\Client_FoM\\";
    auto pos = moduleDir.find(needle);
    if (pos == std::string::npos)
    {
        return "";
    }
    return moduleDir.substr(0, pos);
}

static std::string FormatUptime(DWORD ms)
{
    const DWORD totalSeconds = ms / 1000;
    const DWORD hours = totalSeconds / 3600;
    const DWORD minutes = (totalSeconds / 60) % 60;
    const DWORD seconds = totalSeconds % 60;
    char buf[64] = {0};
    _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%02lu:%02lu:%02lu",
                static_cast<unsigned long>(hours),
                static_cast<unsigned long>(minutes),
                static_cast<unsigned long>(seconds));
    return std::string(buf);
}

static int ReadWorldIdFromEnv()
{
    std::string root = GetRepoRoot();
    if (root.empty())
    {
        return 0;
    }
    std::string envPath = root + "\\Server\\apps\\master\\.env";
    std::ifstream in(envPath, std::ios::in | std::ios::binary);
    if (!in)
    {
        return 0;
    }
    std::string line;
    while (std::getline(in, line))
    {
        if (line.rfind("WORLD_ID=", 0) == 0)
        {
            return atoi(line.c_str() + 9);
        }
    }
    return 0;
}

static std::string ReadWorldNameFromRegistry(int worldId)
{
    if (worldId <= 0)
    {
        return "";
    }
    std::string root = GetRepoRoot();
    if (root.empty())
    {
        return "";
    }
    std::string registryPath = root + "\\Server\\apps\\master\\src\\world\\WorldRegistry.ts";
    std::ifstream in(registryPath, std::ios::in | std::ios::binary);
    if (!in)
    {
        return "";
    }
    std::string line;
    const std::string needle = "id: " + std::to_string(worldId);
    while (std::getline(in, line))
    {
        if (line.find(needle) == std::string::npos)
        {
            continue;
        }
        const std::string displayKey = "display:";
        size_t displayPos = line.find(displayKey);
        if (displayPos == std::string::npos)
        {
            continue;
        }
        size_t quoteStart = line.find('\'', displayPos);
        size_t quoteEnd = line.find('\'', quoteStart + 1);
        if (quoteStart == std::string::npos || quoteEnd == std::string::npos)
        {
            continue;
        }
        return line.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
    }
    return "";
}

static void RefreshWorldInfo()
{
    const DWORD now = GetTickCount();
    if (now - GWorldInfoLastRefresh < 1000)
    {
        return;
    }
    GWorldInfoLastRefresh = now;
    const int worldId = ReadWorldIdFromEnv();
    if (worldId != GCurrentWorldId)
    {
        GCurrentWorldId = worldId;
        GCurrentWorldName = ReadWorldNameFromRegistry(worldId);
    }
}

static bool UpdateWorldIdEnv(int worldId, std::string& err)
{
    std::string root = GetRepoRoot();
    if (root.empty())
    {
        err = "repo root not found";
        return false;
    }
    std::string envPath = root + "\\Server\\apps\\master\\.env";
    std::ifstream in(envPath, std::ios::in | std::ios::binary);
    std::string content;
    if (in)
    {
        content.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        in.close();
    }
    bool replaced = false;
    std::string out;
    size_t start = 0;
    while (start < content.size())
    {
        size_t end = content.find('\n', start);
        if (end == std::string::npos)
        {
            end = content.size();
        }
        std::string line = content.substr(start, end - start);
        if (line.rfind("WORLD_ID=", 0) == 0)
        {
            line = "WORLD_ID=" + std::to_string(worldId);
            replaced = true;
        }
        out += line;
        out += '\n';
        start = end + 1;
    }
    if (!replaced)
    {
        out += "WORLD_ID=" + std::to_string(worldId) + "\n";
    }
    std::ofstream outFile(envPath, std::ios::out | std::ios::binary | std::ios::trunc);
    if (!outFile)
    {
        err = "failed to write .env";
        return false;
    }
    outFile << out;
    outFile.close();
    return true;
}

static void RequestWorldChange(int worldId)
{
    if (worldId <= 0)
    {
        GWorldStatus = "Invalid world id";
        return;
    }
    std::string err;
    if (!UpdateWorldIdEnv(worldId, err))
    {
        GWorldStatus = "World change failed: " + err;
        LOG("[Overlay] World change failed: %s", err.c_str());
        return;
    }

    std::string root = GetRepoRoot();
    if (root.empty())
    {
        GWorldStatus = "World change failed: repo root not found";
        return;
    }

    std::string cmd =
        "cmd.exe /c \"cd /d \\\"" + root + "\\\" && taskkill /f /im bun.exe >nul 2>&1 && "
        "start start_server.bat && start start_world.bat && start launch_fom_with_log.bat\"";

    STARTUPINFOA si = {};
    PROCESS_INFORMATION pi = {};
    si.cb = sizeof(si);
    std::string mutableCmd = cmd;
    BOOL ok = CreateProcessA(nullptr, mutableCmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    if (ok)
    {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        GWorldStatus = "Restarting servers + client...";
        LOG("[Overlay] World change requested -> WORLD_ID=%d", worldId);
        Sleep(500);
        ExitProcess(0);
    }
    else
    {
        GWorldStatus = "World change failed: launch error";
        LOG("[Overlay] World change launch failed (err=%lu)", GetLastError());
    }
}

// Use a fixed font to keep the HUD readable against varied backgrounds.
static void EnsureOverlayFont()
{
    if (GOverlayFont)
    {
        return;
    }
    GOverlayFont = CreateFontA(16, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                               OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                               DEFAULT_PITCH | FF_DONTCARE, "Consolas");
    if (!GOverlayFont)
    {
        LOG("[Overlay] Failed to create font (err=%lu)", GetLastError());
    }
}

// GDI text render to the backbuffer DC (no layout or wrapping).
static void DrawLine(HDC Hdc, int X, int Y, const char* Text)
{
    if (!Text || !Text[0])
    {
        return;
    }
    TextOutA(Hdc, X, Y, Text, static_cast<int>(strlen(Text)));
}

static void DrawOverlayGdi(HDC Hdc)
{
    RECT targetRect = {};
    if (!GTargetWindow || !GetWindowRect(GTargetWindow, &targetRect))
    {
        targetRect.left = 0;
        targetRect.top = 0;
        targetRect.right = GetSystemMetrics(SM_CXSCREEN);
        targetRect.bottom = GetSystemMetrics(SM_CYSCREEN);
    }
    const int screenW = targetRect.right - targetRect.left;
    const int screenH = targetRect.bottom - targetRect.top;
    RECT rect = {};
    rect.left = 0;
    rect.top = 0;
    rect.right = screenW;
    rect.bottom = screenH;
    FillRect(Hdc, &rect, reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));

    SetBkMode(Hdc, TRANSPARENT);
    SetTextColor(Hdc, RGB(96, 255, 160));
    if (GOverlayFont)
    {
        SelectObject(Hdc, GOverlayFont);
    }

    char Line[256] = {0};
    const int LineH = 18;
    std::vector<std::string> lines;

    snprintf(Line, sizeof(Line), "FoM Admin HUD (VK %d toggle)", GConfig.OverlayKey);
    lines.emplace_back(Line);

    snprintf(Line, sizeof(Line), "Recv: %llu packets (%llu bytes)", GRecvCount, GRecvBytes);
    lines.emplace_back(Line);

    snprintf(Line, sizeof(Line), "Send: %llu packets (%llu bytes)", GSendCount, GSendBytes);
    lines.emplace_back(Line);

    snprintf(Line, sizeof(Line), "Last recv: %d bytes   Last send: %d bytes", GLastRecv, GLastSend);
    lines.emplace_back(Line);

    RefreshWorldInfo();
    if (GCurrentWorldId > 0)
    {
        if (!GCurrentWorldName.empty())
        {
            snprintf(Line, sizeof(Line), "World: %d (%s)", GCurrentWorldId, GCurrentWorldName.c_str());
        }
        else
        {
            snprintf(Line, sizeof(Line), "World: %d", GCurrentWorldId);
        }
        lines.emplace_back(Line);
    }

    const DWORD uptimeMs = GetTickCount() - GOverlayStartTick;
    const std::string uptime = FormatUptime(uptimeMs);
    snprintf(Line, sizeof(Line), "Uptime: %s", uptime.c_str());
    lines.emplace_back(Line);

    snprintf(Line, sizeof(Line), "World ID: %s (Enter to restart)", GWorldInput.empty() ? "-" : GWorldInput.c_str());
    lines.emplace_back(Line);

    if (!GWorldStatus.empty())
    {
        lines.emplace_back(GWorldStatus);
    }

    int maxWidth = 0;
    std::vector<std::string> widthSamples = {
        "FoM Admin HUD (VK 255 toggle)",
        "Recv: 999999999 packets (9999999999 bytes)",
        "Send: 999999999 packets (9999999999 bytes)",
        "Last recv: 999999 bytes   Last send: 999999 bytes",
        "World: 999 (Placeholder World Name)",
        "Uptime: 99:59:59",
        "World ID: 999999 (Enter to restart)",
        "Restarting servers + client...",
    };
    for (const auto& text : widthSamples)
    {
        SIZE size = {};
        if (GetTextExtentPoint32A(Hdc, text.c_str(), static_cast<int>(text.size()), &size))
        {
            if (size.cx > maxWidth)
            {
                maxWidth = size.cx;
            }
        }
    }

    const int totalHeight = static_cast<int>(lines.size()) * LineH;
    int X = (screenW - maxWidth) / 2;
    int Y = (screenH - totalHeight) / 2 - 40;
    if (X < 10) X = 10;
    if (Y < 10) Y = 10;

    for (const auto& text : lines)
    {
        DrawLine(Hdc, X, Y, text.c_str());
        Y += LineH;
    }
}

static LRESULT CALLBACK OverlayWndProc(HWND Hwnd, UINT Msg, WPARAM Wparam, LPARAM Lparam)
{
    switch (Msg)
    {
    case WM_PAINT: {
        PAINTSTRUCT ps = {};
        HDC hdc = BeginPaint(Hwnd, &ps);
        if (hdc)
        {
            EnsureOverlayFont();
            DrawOverlayGdi(hdc);
        }
        EndPaint(Hwnd, &ps);
        return 0;
    }
    case WM_ERASEBKGND:
        return 1;
    case WM_DESTROY:
        return 0;
    default:
        return DefWindowProcA(Hwnd, Msg, Wparam, Lparam);
    }
}

static DWORD WINAPI OverlayThread(LPVOID)
{
    EnsureOverlayFont();

    WNDCLASSA wc = {};
    wc.lpfnWndProc = OverlayWndProc;
    wc.hInstance = GetModuleHandleA(nullptr);
    wc.lpszClassName = GOverlayClassName;
    RegisterClassA(&wc);

    const int width = GetSystemMetrics(SM_CXSCREEN);
    const int height = GetSystemMetrics(SM_CYSCREEN);
    DWORD exStyle = WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    GOverlayWnd = CreateWindowExA(
        exStyle,
        GOverlayClassName,
        "FoM Admin HUD",
        WS_POPUP,
        0,
        0,
        width,
        height,
        nullptr,
        nullptr,
        wc.hInstance,
        nullptr);

    if (!GOverlayWnd)
    {
        LOG("[Overlay] Window create failed (err=%lu)", GetLastError());
        return 0;
    }

    SetLayeredWindowAttributes(GOverlayWnd, RGB(0, 0, 0), 0, LWA_COLORKEY);
    GWindowOverlayActive = true;
    ShowWindow(GOverlayWnd, GOverlayVisible ? SW_SHOWNOACTIVATE : SW_HIDE);
    SetWindowPos(GOverlayWnd, HWND_TOPMOST, 0, 0, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);

    LOG("[Overlay] Window overlay thread started");

    MSG msg = {};
    while (WaitForSingleObject(GOverlayStopEvent, 0) != WAIT_OBJECT_0)
    {
        while (PeekMessageA(&msg, nullptr, 0, 0, PM_REMOVE))
        {
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }

        // Capture digits/backspace/enter when HUD is visible.
        if (GOverlayVisible)
        {
            for (int vk = '0'; vk <= '9'; vk += 1)
            {
                const bool down = (GetAsyncKeyState(vk) & 0x8000) != 0;
                if (down && !GInputKeyDown[vk])
                {
                    if (GWorldInput.size() < 6)
                    {
                        GWorldInput.push_back(static_cast<char>(vk));
                    }
                }
                GInputKeyDown[vk] = down;
            }

            const bool backspaceDown = (GetAsyncKeyState(VK_BACK) & 0x8000) != 0;
            if (backspaceDown && !GInputKeyDown[VK_BACK])
            {
                if (!GWorldInput.empty())
                {
                    GWorldInput.pop_back();
                }
            }
            GInputKeyDown[VK_BACK] = backspaceDown;

            const bool enterDown = (GetAsyncKeyState(VK_RETURN) & 0x8000) != 0;
            if (enterDown && !GInputKeyDown[VK_RETURN])
            {
                if (!GWorldInput.empty())
                {
                    GWorldStatus = "Applying world change...";
                    GWorldLastAction = GetTickCount();
                    RequestWorldChange(atoi(GWorldInput.c_str()));
                }
            }
            GInputKeyDown[VK_RETURN] = enterDown;
        }

        const short keyState = GetAsyncKeyState(GConfig.OverlayKey);
        const bool KeyDown = (keyState & 0x8000) != 0;
        if (KeyDown && !GOverlayKeyDown)
        {
            GOverlayVisible = !GOverlayVisible;
            LOG("[Overlay] Toggle key press -> visible=%d", GOverlayVisible ? 1 : 0);
            ShowWindow(GOverlayWnd, GOverlayVisible ? SW_SHOWNOACTIVATE : SW_HIDE);
        }
        GOverlayKeyDown = KeyDown;

        const DWORD now = GetTickCount();
        if (!GTargetWindow || now - GTargetLastScan > 1000)
        {
            GTargetWindow = FindTargetWindow();
            GTargetLastScan = now;
        }
        if (GTargetWindow)
        {
            RECT rect = {};
            if (GetWindowRect(GTargetWindow, &rect))
            {
                int w = rect.right - rect.left;
                int h = rect.bottom - rect.top;
                if (w > 0 && h > 0)
                {
                    const UINT flags = SWP_NOACTIVATE | (GOverlayVisible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW);
                    SetWindowPos(GOverlayWnd, HWND_TOPMOST, rect.left, rect.top, w, h, flags);
                }
            }
        }

        if (GOverlayVisible && GOverlayWnd)
        {
            InvalidateRect(GOverlayWnd, nullptr, TRUE);
        }
        Sleep(16);
    }

    if (GOverlayWnd)
    {
        DestroyWindow(GOverlayWnd);
        GOverlayWnd = nullptr;
    }
    UnregisterClassA(GOverlayClassName, wc.hInstance);
    return 0;
}
} // namespace

void OverlayStartup()
{
    if (!GConfig.bOverlay || GOverlayThread)
    {
        return;
    }
    if (!IsGameProcess())
    {
        LOG("[Overlay] Skipping overlay startup (non-game process)");
        return;
    }
    if (!GOverlayMutex)
    {
        GOverlayMutex = CreateMutexA(nullptr, TRUE, "FoMHookOverlaySingleton");
        if (GOverlayMutex && GetLastError() == ERROR_ALREADY_EXISTS)
        {
            CloseHandle(GOverlayMutex);
            GOverlayMutex = nullptr;
            LOG("[Overlay] Singleton already active; skipping overlay startup");
            return;
        }
    }
    GOverlayStartTick = GetTickCount();
    GOverlayStopEvent = CreateEventA(nullptr, TRUE, FALSE, nullptr);
    if (!GOverlayStopEvent)
    {
        LOG("[Overlay] Stop event create failed (err=%lu)", GetLastError());
        return;
    }
    GOverlayThread = CreateThread(nullptr, 0, OverlayThread, nullptr, 0, &GOverlayThreadId);
    if (!GOverlayThread)
    {
        LOG("[Overlay] Thread create failed (err=%lu)", GetLastError());
        CloseHandle(GOverlayStopEvent);
        GOverlayStopEvent = nullptr;
    }
}

// Render a lightweight debug HUD without touching the device state.
void OverlayRender(IDirect3DDevice9* Device)
{
    if (!GUseD3DOverlay)
    {
        return;
    }
    if (!Device || !GConfig.bOverlay)
    {
        return;
    }
    if (GWindowOverlayActive)
    {
        return;
    }

    if (GOverlayFirstRender)
    {
        LOG("[Overlay] Render hook active");
        GOverlayFirstRender = false;
    }

    const short keyState = GetAsyncKeyState(GConfig.OverlayKey);
    const bool KeyDown = (keyState & 0x8000) != 0;
    if (KeyDown)
    {
        const DWORD now = GetTickCount();
        if (now - GOverlayLastKeyLog > 500)
        {
            LOG("[Overlay] Toggle key down (vk=%d state=0x%04x)", GConfig.OverlayKey, static_cast<unsigned short>(keyState));
            GOverlayLastKeyLog = now;
        }
    }
    if (KeyDown && !GOverlayKeyDown)
    {
        GOverlayVisible = !GOverlayVisible;
        LOG("[Overlay] Toggle key press -> visible=%d", GOverlayVisible ? 1 : 0);
    }
    GOverlayKeyDown = KeyDown;
    if (!GOverlayVisible)
    {
        return;
    }

    EnsureOverlayFont();

    IDirect3DSurface9* BackBuffer = nullptr;
    if (FAILED(Device->GetBackBuffer(0, 0, D3DBACKBUFFER_TYPE_MONO, &BackBuffer)) || !BackBuffer)
    {
        return;
    }

    HDC Hdc = nullptr;
    if (FAILED(BackBuffer->GetDC(&Hdc)) || !Hdc)
    {
        BackBuffer->Release();
        return;
    }

    SetBkMode(Hdc, TRANSPARENT);
    SetTextColor(Hdc, RGB(96, 255, 160));
    if (GOverlayFont)
    {
        SelectObject(Hdc, GOverlayFont);
    }

    char Line[256] = {0};
    int X = 12;
    int Y = 12;
    const int LineH = 18;

    snprintf(Line, sizeof(Line), "FoM Admin HUD (VK %d toggle)", GConfig.OverlayKey);
    DrawLine(Hdc, X, Y, Line);
    Y += LineH;

    snprintf(Line, sizeof(Line), "Recv: %llu packets (%llu bytes)", GRecvCount, GRecvBytes);
    DrawLine(Hdc, X, Y, Line);
    Y += LineH;

    snprintf(Line, sizeof(Line), "Send: %llu packets (%llu bytes)", GSendCount, GSendBytes);
    DrawLine(Hdc, X, Y, Line);
    Y += LineH;

    snprintf(Line, sizeof(Line), "Last recv: %d bytes   Last send: %d bytes", GLastRecv, GLastSend);
    DrawLine(Hdc, X, Y, Line);

    BackBuffer->ReleaseDC(Hdc);
    BackBuffer->Release();
}

void OverlayShutdown()
{
    if (GOverlayMutex)
    {
        ReleaseMutex(GOverlayMutex);
        CloseHandle(GOverlayMutex);
        GOverlayMutex = nullptr;
    }
    if (GOverlayStopEvent)
    {
        SetEvent(GOverlayStopEvent);
    }
    if (GOverlayThread)
    {
        WaitForSingleObject(GOverlayThread, 2000);
        CloseHandle(GOverlayThread);
        GOverlayThread = nullptr;
    }
    if (GOverlayStopEvent)
    {
        CloseHandle(GOverlayStopEvent);
        GOverlayStopEvent = nullptr;
    }
    if (GOverlayFont)
    {
        DeleteObject(GOverlayFont);
        GOverlayFont = nullptr;
    }
}
