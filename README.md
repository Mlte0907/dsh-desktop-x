# dsh-desktop-x

Codex-style desktop shell for `dsh web`: a frameless window that loads the
local DeepSeek Harness web UI, lives in the system tray, and keeps the
backend running independently of the frontend.

## Why this exists

The web GUI is a remote page on `http://127.0.0.1:3080`. A browser tab is
fine for a one-off task, but a long-running agent deserves its own window
that does not vanish when you close the lid and that does not interrupt the
backend when you click the × button. This shell is that window, plus a tray
icon that reports backend health while the window is hidden.

## Capabilities

| Requirement | How |
|---|---|
| **Instant window, Codex-like chrome** | Local HTML loads before any backend connection; the backend `<iframe>` (inheriting the window's `persist:dsh` session) takes over once the backend answers. Frameless; deep `#0b0d12` background to suppress white flash. |
| **Backend survives frontend close** | `spawn({ detached: true, stdio: 'pipe', env: { DSH_HOME } })` + `child.unref()` — closing the window only hides it, the backend process is in its own process group. |
| **Double-click opens front, brings up backend if not running** | On launch: `probeBackend` (HTTP `GET /`); `401` ⇒ alive but unauthenticated, ECONNREFUSED ⇒ start one. Spawn is shared (`BackendManager._` Promise) — concurrent retries don't double-start. |
| **If backend is already running, connect without spinning one up** | The probe path runs first; a live backend returns `{ reused: true }` and is never restarted. Verified with the running backend: outcome `reused: true, ownership: external`. |
| **Tray icon reflects backend status** | Four tray PNGs (`online / starting / offline / error`) are recomposited on every `BackendManager` status change; the menu shows "后端：在线 · 外部进程" plus actions. |
| **DeepSeek whale icon** | Path lifted verbatim from `apps/web/public/favicon.svg`, rendered into `build/app-icon*.png` and the tray badge via `sharp`. |
| **Global toggle shortcut** | `Super+Shift+D` (override with `DSH_TOGGLE_ACCEL`) shows/hides the window. Registered via `globalShortcut` at boot; this is the backstop that makes hide-to-tray safe even where the tray never renders. Not `Ctrl+Alt+D` — XFCE binds that to show-desktop. |

Measured memory, window visible vs hidden in tray (same instance, PSS):

| State | PSS |
|---|---:|
| Window visible | 398 MB |
| Window hidden (tray-resident) | 394 MB |

Hiding saves almost nothing — Chromium keeps the webview's renderer alive
either way (torn-down on show would lose scroll position and form state). The
dip from first-load readings (~480 MB) to steady state (~395 MB) is GC
settle, not hiding.

## Architecture

```
src/main/
  config.ts   — paths, ports, partition name (persist:dsh)
  net.ts     — probe + entryUrlOpens (401 = alive; 303/200 = entry opens)
  backend.ts — BackendManager: probe → reuse / spawn-detached / systemctl
  window.ts  — ShellWindow: frameless BrowserWindow, webview auth-wall watch
  tray.ts   — ShellTray: icon-per-state, menu, backend ownership label
  index.ts  — entry; parallel backend probe + window construction
src/preload/index.ts — contextBridge: connect / restart / stop / window action / snapshot / events
src/renderer/       — local Codex-style chrome that loads first
scripts/
  build-icons.mjs   — sharp renders tray states + app icons
  copy-assets.mjs   — copy dist/assets + dist/renderer
  install-system.sh — writes .desktop + hicolor icons + systemd user unit
```

### Authentication & cookie reuse

`dsh web` enforces a one-shot token exchange the first time the index route
is requested with no cookie. The shell solves this without asking the user:

1. **Read the token from the backend log.** `BackendManager.recoverEntryUrls`
   reads the shell's own `~/.dsh/desktop/backend.log` (written by both the
   shell and the systemd unit), then scans `/proc/*/fd/1` for any `dsh web`
   process whose stdout was redirected by hand (`nohup dsh web > X.log &`).
2. **Validate.** Each candidate URL is probed; only `303` (token accepted,
   cookie set) or `200` (cookie accepted) qualifies.
3. **Persist.** The webview uses the `persist:dsh` partition, so the 30-day
   authority-bound cookie lands on disk. The next launch — even after a
   backend restart — reconnects with one request instead of a token exchange.

This was validated live: the cookie file appears at
`~/.config/dsh-desktop-x/Partitions/dsh/Cookies` after the first
successful connect.

### Why an `<iframe>` and not a `<webview>` — and the cookie it would not send

The first implementation used Electron's `<webview>` (OOPIF, its own process).
Under software rendering its compositor intermittently presented a black frame
forever — DOM loaded, skeleton dismissed, nothing painted, unfixable by
reload or invalidate. The backend frame is now a plain `<iframe>` rendered in
the chrome's own process, which eliminated the black screens entirely.

That swap surfaced a second trap: the chrome is a `file://` page, so the
`http://127.0.0.1:3080` frame is a **cross-site context, and Chromium refuses
to send the backend's `SameSite=Strict` cookie** there — every request 401s
even though the session holds a valid cookie (verifiable with `curl -b`:
200). `window.watchWebview` therefore injects the cookie into each request's
headers via `session.webRequest.onBeforeSendHeaders` — the cookie is stored,
it just never travelled on its own. The same watcher reports 401s to the UI
as the auth wall.

### Backend lifecycle

| Source of truth | How `BackendManager` decides |
|---|---|
| State file `~/.dsh/desktop/backend.json` (this shell's spawn) | `pid` checked with `kill -0`. |
| systemd user unit `dsh-desktop-x.service` | `systemctl --user is-enabled` and `is-active`. |
| Anything else | Falls through to `external`. |

Stop is symmetric: only a backend the shell can account for is touched
(process-group `kill -PID` for desktop, `systemctl stop` for systemd). A
backend the user started themselves is never killed.

## Build & run

```bash
cd /home/xiaoxin/dsh-desktop-x
npm install                    # Electron downloads via npmmirror (set ELECTRON_MIRROR)
npm run build                  # tsc + assets copy
npm start                      # build + launch
```

`npm run launch` runs the prebuilt app without rebuilding.

## Install to the system

```bash
bash scripts/install-system.sh --enable
```

Writes (no sudo required):

| Path | Purpose |
|---|---|
| `~/.local/share/applications/dsh-desktop-x.desktop` | XFCE menu / file-manager launcher |
| `~/.local/share/icons/hicolor/{48,64,128,256,512}x*/apps/dsh-desktop-x.png` | hicolor icon theme |
| `~/.config/systemd/user/dsh-desktop-x.service` | `dsh web` backend, auto-start on login, appends to `~/.dsh/desktop/backend.log` |

`--enable` additionally runs `systemctl --user enable --now dsh-desktop-x.service`
so the backend is up before the shell ever opens. To uninstall:

```bash
bash scripts/install-system.sh --uninstall
```

## Measured timings (ARM / XFCE / X11)

| Stage | Cold |
|---|---|
| Shell window first paint | < 300 ms (local HTML, no network) |
| Backend cold boot | ~5.1 s (loaded once; systemd-warmed runs are sub-second) |
| Backend already running, no cookie | ~1 s (token recovered from log + one redirect) |
| Backend already running, cookie present | < 500 ms (no network round-trip needed) |

## Configuration (environment variables)

| Variable | Default | Effect |
|---|---|---|
| `DSH_HARNESS_ROOT` | `/home/xiaoxin/deepseek-harness` | checkout the shell wraps |
| `DSH_NODE_BIN` | `/home/xiaoxin/.hermes/node/bin/node` | Node used to launch `dsh web` |
| `DSH_HOME` | `~/.dsh` | **must match the backend's** — cookie secret lives here |
| `DSH_WEB_PORT` | `3080` | fixed port (the cookie is authority-bound) |
| `DSH_WEB_HOST` | `127.0.0.1` | bound host |
| `DSH_DISABLE_GPU` | unset | set `1` if GPU init fails on the host |

## Memory footprint

Measured on this host (ARM / XFCE / X11), PSS via `/proc/<pid>/smaps_rollup`
(shared pages divided; RSS double-counts them and reads far higher):

| Configuration | Steady state (UI loaded) |
|---|---:|
| Hardware acceleration on (llvmpipe fallback) | ~398 MB — **but webview black-screens after restart** |
| Hardware acceleration off (default) | ~547 MB, stable |
| Window hidden to tray | same as visible (±5 MB) — Chromium keeps the renderer alive either way |
| Frontend quit via tray / `--quit` | **0 processes**; only the systemd backend remains |
| The `dsh web` backend itself | ~358 MB PSS (its plugin tree; unrelated to the shell) |

Hardware acceleration is **off by default**: on a machine without a real GPU,
Chromium falls back to llvmpipe and the llvmpipe compositor black-screens the
`<webview>` after a restart (the local chrome keeps painting; the remote page
never returns). Pure software rendering is stable but moves rasterisation into
CPU memory, hence the ~150 MB premium. On a machine with a working GPU, set
`DSH_ENABLE_GPU=1` to regain the lower footprint and hardware compositing.

## Background mode (headless)

Run the shell without UI — only the backend process and tray (optional) are
started. Saves ~395 MB of Chromium renderer memory while keeping the backend
alive for MCP clients, CLI tools, or remote access.

```bash
npm run background
# or
DSH_BACKGROUND_MODE=1 npm run launch
```

| Variable | Default | Effect |
|---|---|---|
| `DSH_BACKGROUND_MODE` | unset | Set to `1` to skip window + tray creation |
| `DSH_ENABLE_SHORTCUT` | `1` | Set to `0` to disable global shortcut in background mode |

**Memory comparison:**

| Mode | PSS |
|---|---|
| Full UI (window + tray) | ~547 MB |
| Background mode (backend only) | ~358 MB |
| **Savings** | **~189 MB (35%)** |

In background mode, the backend starts immediately (same as normal mode) but
the Electron window and tray are never created. The global shortcut
(`Super+Shift+D`) is still registered by default — useful if you want a hotkey
to launch the UI on demand. Disable with `DSH_ENABLE_SHORTCUT=0`.

To show the UI later, run `npm start` or `electron .` — it will connect to the
already-running backend (no restart, no token exchange).

## Quitting the frontend only (tight-memory mode)

The tray item "退出前端并释放内存（后端继续运行）" — or from any shell:

```bash
/path/to/dsh-desktop-x/node_modules/electron/dist/electron \
  /path/to/dsh-desktop-x --quit
```

terminates the whole Electron tree (measured: 9 processes → 0, ~550 MB
reclaimed) while the systemd backend keeps serving. The next launch reuses it:
window in ~900 ms, cookie direct-connect, zero 401s.

Note that `SIGTERM` is **not** a reliable exit path on Linux: Chromium
installs its own handler, which merely tries to close the window, and the
close handler hides to tray — leaving the process tree stalled. Use the tray
item or `--quit`.

## Known limitations

- **XFCE needs the `sntray` plugin, or the tray icon stays invisible.**
  Electron's `Tray` speaks StatusNotifierItem over D-Bus; the default XFCE
  `systray` item is XEmbed and cannot render it. The item *is* registered
  (check: `gdbus call --session --dest org.freedesktop.DBus --object-path
  /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames | grep
  StatusNotifierItem`), so this is purely a panel-side gap. On Ubuntu noble /
  Armbian the package is **`xfce4-sntray-plugin`** (there is no
  `xfce4-statusnotifier-plugin` in noble):
  ```bash
  sudo apt install -y xfce4-sntray-plugin
  DISPLAY=:0 xfce4-panel --add=sntray
  DISPLAY=:0 xfce4-panel -r
  ```
  (`DISPLAY=:0` matters when the panel commands run from a non-graphical
  shell.) Without the plugin everything else still works — close hides the
  window and `Super+Shift+D` brings it back — only the tray entry is missing.
- GNOME requires the `AppIndicator` extension (no native tray API).
- Linux arm64 Electron is downloaded via `npmmirror.com` (set
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`).