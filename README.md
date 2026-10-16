# Motion Studio

A personal, **local-first** screen recorder. Record your screen, and it
auto-zooms on the cursor with smooth framing, lets you trim non-destructively,
and exports shareable H.264/WebM videos — plus a poster frame, transcript and
Markdown summary. Built with Tauri 2, React, TypeScript, ffmpeg and SQLite.

Everything runs on your machine. There are **no accounts, no billing, no
telemetry, no analytics, and no hosted control plane**. Saving exports to
Google Drive is an optional, opt-in extra.

---

## Quick start (one command)

Prerequisites, installed once:

- **Node 20+**
- **ffmpeg** on your `PATH`
  - Windows: `winget install --id Gyan.FFmpeg -e`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
- **Rust toolchain** (to build the desktop shell): <https://rustup.rs>
  - On Windows also install the **MSVC C++ build tools** (Desktop development with C++).

Then:

```bash
pnpm first-run
```

`pnpm first-run` runs `scripts/bootstrap.mjs` (checks the tools above and
installs JavaScript dependencies), then launches the desktop app.

Other useful scripts:

```bash
pnpm dev         # UI only, in a browser (no recording/export — desktop app needed)
pnpm test        # unit tests + real-ffmpeg end-to-end tests
pnpm typecheck   # TypeScript type checking
pnpm build       # typecheck + production web build
```

> The browser dev server is for UI work. Recording, saving, and export require
> the desktop app. In the browser the missing pieces surface as clear,
> recoverable messages instead of failing silently.

---

## How it works

```
React webview (capture + edit UI)
        │  MediaPorts / Transcriber
        ▼
Pure TypeScript core  (src/core)         ← all media planning logic
        │  ffmpeg argv, no OS access
        ▼
Tauri (Rust) platform layer (src-tauri)  ← OS integration
   • SQLite project store        • runs local ffmpeg/ffprobe (validated argv)
   • recording session + timer    • cursor sampling
   • system tray (stop)           • filesystem + clipboard + reveal
```

- **UI**: React + TypeScript. Screen/window capture uses the browser
  `getDisplayMedia` (the OS shows its own picker) and `MediaRecorder`.
- **`src/core`**: pure, dependency-free logic — trim math, cursor clustering,
  auto-zoom keyframes, the ffmpeg filtergraph, presets, Markdown, validation.
  It is the single source of truth and is fully unit-tested.
- **Pipeline**: `src/core/pipeline.ts` orchestrates the render, poster,
  transcript and summary. It runs identically against the Rust ports (in the
  app) and the Node ports (in tests).
- **`src-tauri`**: Rust owns everything the webview must not: SQLite, process
  execution, tray, and cursor sampling. The webview can only ask it to run
  `ffmpeg`/`ffprobe` with argv that passes validation.

### The render graph (single source of truth)

`trim → fps → optional crop → optional cursor highlight overlay → smooth
zoompan (output at canvas size, so no aspect distortion) → scale-to-fit →
pad + rounded framing → optional callouts → yuv420p`, then packaged by the
chosen preset (H.264/MP4 or VP9/WebM). Poster, transcript and Markdown are
written next to the video.

---

## Configuration

Copy `.env.example` to `.env` (gitignored) to override defaults:

| Variable | Purpose |
| --- | --- |
| `FFMPEG_PATH` | Explicit ffmpeg binary (otherwise auto-detected: env → PATH → winget) |
| `FFPROBE_PATH` | Explicit ffprobe binary |
| `WHISPER_CPP_BIN` | Path to a local `whisper.cpp` binary (enables transcription) |
| `WHISPER_MODEL` | Path to a local whisper model (e.g. `ggml-base.en.bin`) |
| `GOOGLE_CLIENT_ID` | Optional alternative to entering the Google Drive OAuth client in the app |
| `GOOGLE_CLIENT_SECRET` | Secret for the same OAuth client |

Secrets and machine-specific paths live only in `.env`, which is never
committed. Transcription is entirely local and optional: if it is not
configured, exports still succeed and simply skip the transcript.

### Google Drive (optional)

Exported videos can be saved to your Google Drive with one click. Everything is
set up from the **Google Drive** tab in the app, which walks through the steps
below with an "Open page" button for each one. It takes about five minutes,
once. You use your own free Google OAuth client, so no shared app or server
is involved.

1. **Create a project** — <https://console.cloud.google.com/projectcreate>
   (any name, e.g. "Motion Studio"; make sure it is selected afterwards).
2. **Enable the Google Drive API** —
   <https://console.cloud.google.com/apis/library/drive.googleapis.com> → *Enable*.
3. **Configure the consent screen** — <https://console.cloud.google.com/auth/overview>
   → *Get started*: app name, support email, audience **External**, agree and
   create.
4. **Add yourself as a test user** — <https://console.cloud.google.com/auth/audience>
   → *Test users* → *Add users* → the Google account you will upload with.
   Skipping this step makes sign-in fail with `Error 403: access_denied`.
5. **Create the OAuth client** — <https://console.cloud.google.com/auth/clients>
   → *Create client* → application type **Desktop app** → copy the
   *Client ID* and *Client secret*.
6. **Paste both into the Google Drive tab**, click **Save credentials**, then
   **Connect Google Drive**. Your browser opens the Google sign-in. Google
   warns that the app is unverified (expected for a personal client):
   choose *Continue*, allow access, and the page confirms
   "Google Drive connected".

After that, every export shows **Save to Drive** next to the video (upload
progress is shown inline), and uploaded exports switch to **Open in Drive**.
If Drive isn't set up yet, clicking **Save to Drive** opens the setup tab.

How it works and what is stored:

- OAuth uses the installed-app loopback flow with PKCE: the app listens once on
  `127.0.0.1:<random port>` for the redirect.
- Only the `drive.file` scope is requested (plus `openid email` to show which
  account is connected). The app can only see files it uploaded itself, and
  they go into a **Motion Studio** folder in your Drive.
- Uploads use Drive's resumable protocol in 8 MB chunks, so large exports
  don't have to fit in memory. Only files inside the app's recordings
  directory can be uploaded.
- The OAuth client is stored in `google-drive-client.json` and the refresh
  token in `google-drive.json`. Both are in the app-data directory and readable
  only by your user (`0600`). **Disconnect** revokes the token and deletes it,
  and **Remove credentials** also deletes the client.
- `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.env` still work as an
  alternative; a client saved in the app takes precedence.

---

## Where your data lives

Recordings, exports and the SQLite database are stored in the OS app-data
directory:

- **Windows**: `%APPDATA%\com.local.motionstudio`
- **macOS**: `~/Library/Application Support/com.local.motionstudio`
- **Linux**: `~/.local/share/com.local.motionstudio`

```
com.local.motionstudio/
  motion-studio.sqlite       # project records (paths, trims, zoom, callouts)
  google-drive-client.json   # only if you set up Google Drive
  google-drive.json          # only if you connected Google Drive
  recordings/               # original captures (never modified)
    exports/                # rendered videos + posters/transcripts/summaries
```

**Backup**: copy the whole directory. To restore, put it back in place — the
app reads everything from there. Nothing is stored anywhere else.

---

## Platform notes

### macOS screen recording & microphone permission

The first time you record, macOS asks for **Screen Recording** and
**Microphone** access:

1. **System Settings → Privacy & Security → Screen Recording** → enable the app.
2. **System Settings → Privacy & Security → Microphone** → enable the app.
3. Quit and reopen the app — macOS requires a restart after granting screen
   recording.

Cursor sampling and the global tray "Stop" behave per-OS; where a permission is
missing, the UI reports it instead of failing silently.

### Windows

ffmpeg installed via winget is auto-detected even if it is not on `PATH`. The
first run in a fresh terminal may need `FFMPEG_PATH` if `PATH` has not refreshed.

### Linux

Install `ffmpeg` from your distro. Cursor sampling support depends on the
display server (X11/Wayland) and degrades gracefully when unavailable.

---

## Privacy

- No network calls, no analytics, no crash reporting, no auto-update pings.
  The single exception is Google Drive upload, which only talks to Google
  after you connect an account and click "Save to Drive".
- All rendering uses your local ffmpeg; all transcription (if enabled) uses your
  local whisper.cpp.
- The only files written are your recordings, exports and the local database
  under the app-data directory above.

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm test         # unit tests + E2E (E2E requires ffmpeg on PATH)
pnpm tauri dev    # run the desktop app (after Rust is installed)
```

Rust-side checks (after installing Rust):

```bash
cd src-tauri
cargo test
cargo build
```

The TypeScript core is where the interesting logic lives and is covered by the
test suite; the Rust layer is intentionally thin and validated.
