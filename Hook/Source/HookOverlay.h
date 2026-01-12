/** Overlay hook helpers. */
#pragma once

struct IDirect3DDevice9;

/** Starts the admin HUD overlay thread (toggle via ini Overlay.ToggleKey). */
void OverlayStartup();
/** Renders the admin HUD overlay (D3D9 path). */
void OverlayRender(IDirect3DDevice9* Device);
/** Shuts down the overlay resources. */
void OverlayShutdown();
