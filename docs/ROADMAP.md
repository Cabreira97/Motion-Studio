# Roadmap

Nothing here is a promise or a schedule, and the order is not a priority — this
is a parking lot so that known gaps stop living in chat logs and memory. Two
lists: debts that are visible in the code today, and ideas nobody has committed
to yet.

Anything added here has to hold to the project's rules: everything local, no
accounts, no billing, no telemetry, no analytics, no hosted control plane. The
[Out of scope](#out-of-scope) section at the end spells out what that rules out,
so a good idea does not get picked up and then thrown away late.

## Known debts

Each one is a thing the code does today that it should not.

### Region capture ignores the region

[`src/App.tsx:234`](../src/App.tsx) hardcodes the crop:

```ts
withCrop(project, { x: 0.15, y: 0.15, width: 0.7, height: 0.7 })
```

Picking "region" therefore always yields the same centred rectangle, whatever
the user meant to frame. The editor's own crop fields
([`src/App.tsx:884`](../src/App.tsx)) do work, so the fix is to carry a real
selection from the source picker into the project rather than to invent the
plumbing. See also [Draw the region](#draw-the-region-with-the-mouse) — closing
this debt honestly is most of that feature.

### A near-dead branch in `deriveFraming`

[`src/core/project.ts:40`](../src/core/project.ts) has a branch that, as far as
reading goes, no caller can reach. Either a case exists that nobody is feeding
it — in which case something upstream is wrong — or it should go. Worth deciding
which before it is mistaken for load-bearing.

### Two owners for the window title

During a recording both sides write the title:

- [`src/App.tsx:145`](../src/App.tsx) sets `document.title` to `● 00:12 — Motion Studio`
- [`src-tauri/src/session.rs:91`](../src-tauri/src/session.rs) calls `window.set_title("● REC …")`

Whichever ran last wins, which makes the elapsed time in the title flicker or
stall depending on timing. One of the two should own it. The Rust side keeps
working when the webview is busy, which argues for it; the React side is the one
that knows the formatted duration.

### The Windows capture path is unverified

The webview recorder is the Windows path and has never been run on Windows by
anyone working on this. It is not known to be broken — it is unmeasured, which
is not the same thing. One recording, one export, and a look at whether the
cursor track lines up would settle it.

### The blended cursor is unverified on real hardware

The portal cursor path (`CursorMode::Metadata`, bitmap blended into the frame,
positions timestamped against the encoder) is covered by unit tests for every
pure part, but no recorded file has been inspected: the portal picker needs a
human to answer it. The halo case (premultiplied vs straight alpha) and hotspot
placement are the two things a single short recording would confirm or refute.

## Ideas

Unclaimed, unordered, and not yet agreed to be worth building.

### Draw the region with the mouse

An overlay to drag out the rectangle before recording, feeding the crop that
[Region capture ignores the region](#region-capture-ignores-the-region) currently
fakes. The debt and the feature are the same work seen from two sides.

### Click highlights

A ring or pulse where the pointer was clicked. The cursor track already carries
positions per frame; what is missing is the click itself, which neither the
portal nor the webview reports today — so this needs a source for button events
before it needs any drawing.

### Silence trimming and per-clip speed

Cut the dead air automatically, and let a stretch of the timeline play faster or
slower. Both are edits to the render graph rather than to capture, so the
preview would need to reflect them before the export can be trusted.

### Padding and a background

Inset the video inside a solid or gradient backdrop, with rounded corners and a
shadow — the look other screen recorders use to make a raw capture presentable.
Pure render-graph work.

### Export a GIF

For short loops that need to play inline wherever they are pasted. ffmpeg
already does the encoding; the cost is a palette pass and sane defaults for
size, because a naive GIF of a screen recording is enormous.

### Export the transcript as a file

The transcript is produced already and embedded in the summary; writing it out
as `.srt`/`.vtt` would let it be used as subtitles elsewhere, or burnt into the
video as a second step.

### A global start/stop shortcut

Start and stop without finding the window first, which matters because finding
the window is itself part of the recording today.

### Editable export presets

The presets are fixed. Letting them be edited and saved — resolution, bitrate,
codec, fps — is mostly a settings surface plus validation, since the export
pipeline already takes those as parameters.

### Webcam picture-in-picture

A camera inset over the screen capture. The heaviest item on the list: a second
live source to open, place, and keep in sync with the screen track.

### Record system audio

Today only the microphone is captured
([`src/lib/recorder.ts:289`](../src/lib/recorder.ts)), so a demo of anything
that makes a sound records silence. On Linux this is a PipeWire monitor source;
macOS needs a virtual device or ScreenCaptureKit; Windows has WASAPI loopback —
three different answers, which is why it is an idea and not a task.

## Out of scope

Deliberately not built, so that an idea depending on one of these can be
rejected early rather than half-built:

- Accounts, sign-in, SSO, or enterprise workspaces
- Billing or licensing
- Telemetry, crash reporting, or product analytics
- Viewer identity or engagement analytics on shared videos
- Public cloud hosting, or any hosted control plane the app phones home to
- Alternative stacks — this is Tauri 2 + React + TypeScript + ffmpeg + SQLite

Local-first is the whole point: recordings, projects, and exports live on the
machine that made them, and export is a file, not an upload.
