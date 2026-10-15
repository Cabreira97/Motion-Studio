import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BridgeUnavailableError,
  bridge,
  createTauriPorts,
  isTauri,
  listen,
  toAssetUrl,
  type AppInfo,
  type CaptureCapabilities,
} from "./lib/bridge.js";
import { ScreenRecorder, recorderSupported } from "./lib/recorder.js";
import { loadProjects, persistProject, removeProject } from "./lib/projects.js";
import { CalloutEditor } from "./components/CalloutEditor.js";
import { SourcePicker } from "./components/SourcePicker.js";
import { RecordingBanner, TimerText } from "./components/Timer.js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  SuccessState,
} from "./components/StateView.js";
import { EXPORT_PRESETS } from "./core/presets.js";
import { exportArtifacts, runExport } from "./core/pipeline.js";
import {
  addExport,
  createProject,
  summarizeTrim,
  timestampName,
  withCrop,
  withPreset,
  withTrim,
  withAutoZoom,
} from "./core/project.js";
import { formatDuration } from "./core/time.js";
import type {
  Callout,
  CaptureKind,
  ExportArtifact,
  Framing,
  Project,
} from "./core/types.js";

type View = "library" | "record" | "edit";
type RecState = "idle" | "starting" | "recording" | "stopping";

function errMessage(error: unknown): string {
  if (error instanceof BridgeUnavailableError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [boot, setBoot] = useState<"loading" | "ready" | "error">("loading");
  const [bootError, setBootError] = useState("");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [caps, setCaps] = useState<CaptureCapabilities | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View>("library");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recState, setRecState] = useState<RecState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recWarning, setRecWarning] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [kind, setKind] = useState<CaptureKind>("screen");
  const [mic, setMic] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exportProgressMs, setExportProgressMs] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const [lastExport, setLastExport] = useState<ExportArtifact | null>(null);

  const recorderRef = useRef<ScreenRecorder | null>(null);
  const stoppingRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId],
  );

  // --- boot ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadProjects();
        if (cancelled) return;
        setProjects(loaded);
        if (isTauri()) {
          const [info, capabilities] = await Promise.all([
            bridge.getAppInfo(),
            bridge.captureCapabilities(),
          ]);
          if (cancelled) return;
          setAppInfo(info);
          setCaps(capabilities);
        }
        setBoot("ready");
      } catch (error) {
        if (cancelled) return;
        setBootError(errMessage(error));
        setBoot("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- recording timer (+ OS session/tray events) ----------------------------
  useEffect(() => {
    if (recState !== "recording") return;
    timerRef.current = window.setInterval(() => {
      const recorder = recorderRef.current;
      if (recorder) setElapsedMs(recorder.elapsedMs);
    }, 200);
    document.title = `● ${formatDuration(elapsedMs)} — Screen Studio (local)`;
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [recState, elapsedMs]);

  useEffect(() => {
    if (recState !== "recording") document.title = "Screen Studio (local)";
  }, [recState]);

  const handleStop = useCallback(async () => {
    if (stoppingRef.current) return;
    const recorder = recorderRef.current;
    if (!recorder) return;
    stoppingRef.current = true;
    setRecState("stopping");
    try {
      let cursorTrack: Project["cursorTrack"] = [];
      let finalElapsed = recorder.elapsedMs;
      if (isTauri()) {
        const session = await bridge.sessionStop();
        finalElapsed = session.elapsedMs || finalElapsed;
        const samples = await bridge.cursorStop();
        cursorTrack = samples.map((s) => ({ t: s.t, x: s.x, y: s.y }));
      }
      const result = await recorder.stop();

      let sourcePath = "";
      let sourceWidth = result.width;
      let sourceHeight = result.height;
      let durationMs = Math.round(finalElapsed);
      let fps = 30;
      let hasAudio = result.hasAudio;

      const bytes = new Uint8Array(await result.blob.arrayBuffer());

      if (isTauri()) {
        const name = timestampName("Recording", Date.now());
        const saved = await bridge.saveRecording(name, bytes);
        sourcePath = saved.path;
        const info = await bridge.probeMedia(saved.path);
        sourceWidth = info.width || sourceWidth;
        sourceHeight = info.height || sourceHeight;
        durationMs = info.durationMs || durationMs;
        fps = info.fps || fps;
        hasAudio = info.hasAudio;
        setPreviewUrl(await toAssetUrl(saved.path));
      } else {
        setPreviewUrl(URL.createObjectURL(result.blob));
        sourcePath = URL.createObjectURL(result.blob);
      }

      const project = createProject({
        id: crypto.randomUUID(),
        name: timestampName("Recording", Date.now()),
        captureKind: kind,
        sourceLabel: kind,
        mic,
        source: {
          path: sourcePath,
          width: sourceWidth,
          height: sourceHeight,
          durationMs: Math.max(durationMs, 1),
          fps,
          hasAudio,
        },
        cursorTrack,
        presetId: "mp4-1080p",
      });

      setProjects((prev) => [project, ...prev]);
      await persistProject(project);
      setActiveId(project.id);
      setView("edit");
      setRecWarning(
        hasAudio || !mic ? null : "Microphone was requested but no audio track was captured.",
      );
    } catch (error) {
      setRecWarning(errMessage(error));
    } finally {
      recorderRef.current = null;
      stoppingRef.current = false;
      setElapsedMs(0);
      setRecState("idle");
    }
  }, [kind, mic]);

  useEffect(() => {
    if (!isTauri()) return;
    const disposers: Array<() => void> = [];
    void listen<number>("recording://tick", (ms) => setElapsedMs(ms)).then((d) => disposers.push(d));
    void listen<null>("recording://stop-requested", () => void handleStop()).then((d) =>
      disposers.push(d),
    );
    void listen<number>("export://progress", (ms) => setExportProgressMs(ms)).then((d) =>
      disposers.push(d),
    );
    return () => disposers.forEach((dispose) => dispose());
  }, [handleStop]);

  const startRecording = useCallback(async () => {
    setRecWarning(null);
    try {
      if (!recorderSupported()) {
        throw new Error(
          "Screen capture is not available here. Use the desktop app (pnpm first-run) to record.",
        );
      }
      setRecState("starting");
      const recorder = new ScreenRecorder();
      await recorder.start({ kind, mic, fps: 30 });
      recorderRef.current = recorder;
      setElapsedMs(0);
      if (isTauri()) {
        await bridge.sessionStart();
        await bridge.cursorStart(40);
      }
      setRecState("recording");
    } catch (error) {
      recorderRef.current = null;
      setRecState("idle");
      setRecWarning(errMessage(error));
    }
  }, [kind, mic]);

  const commit = useCallback((next: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)));
    void persistProject(next).catch((error) => setExportError(errMessage(error)));
  }, []);

  const handleExport = useCallback(async () => {
    if (!activeProject || !appInfo) return;
    setExportError(null);
    setExportWarnings([]);
    setLastExport(null);
    if (!isTauri()) {
      setExportError(
        "Export runs through your local ffmpeg via the desktop app. Start it with `pnpm first-run`.",
      );
      return;
    }
    setExporting(true);
    setExportProgressMs(0);
    try {
      const ports = createTauriPorts();
      const needsFont = activeProject.callouts.some((c) => c.text.trim().length > 0);
      const font = needsFont ? await bridge.findSystemFont() : null;
      const outputDir = joinPath(appInfo.recordingsDir, "exports");
      const result = await runExport(
        {
          project: activeProject,
          outputDir,
          presetId: activeProject.export.presetId,
          ...(font ? { fontFile: font } : {}),
        },
        ports,
      );
      const next = addExport(activeProject, result.artifact);
      commit(next);
      setLastExport(result.artifact);
      setExportWarnings(result.warnings);
    } catch (error) {
      setExportError(errMessage(error));
    } finally {
      setExporting(false);
    }
  }, [activeProject, appInfo, commit]);

  if (boot === "loading") return <LoadingState label="Loading your library…" />;
  if (boot === "error") return <ErrorState message={bootError} onRetry={() => location.reload()} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" />
          <strong>Screen&nbsp;Studio</strong>
          <span className="muted">local</span>
        </div>
        <nav className="nav">
          <button
            type="button"
            className={`nav__link ${view === "library" ? "nav__link--active" : ""}`}
            onClick={() => setView("library")}
          >
            Library
          </button>
          <button
            type="button"
            className={`nav__link ${view === "record" ? "nav__link--active" : ""}`}
            onClick={() => setView("record")}
          >
            New recording
          </button>
        </nav>
        <div className="topbar__meta">
          {recState === "recording" && <TimerText elapsedMs={elapsedMs} />}
          {appInfo?.ffmpegPath ? (
            <span className="pill pill--ok" title={appInfo.ffmpegPath}>
              ffmpeg ready
            </span>
          ) : (
            <span className="pill pill--warn" title="ffmpeg not found">
              ffmpeg missing
            </span>
          )}
        </div>
      </header>

      {recState === "recording" && (
        <RecordingBanner elapsedMs={elapsedMs} warning={recWarning} onStop={() => void handleStop()} />
      )}

      {!isTauri() && (
        <div className="notice">
          Browser preview mode — recording UI works, but saving and exporting need the desktop app
          (`pnpm first-run`).
        </div>
      )}

      <main className="content">
        {view === "library" && (
          <LibraryView
            projects={projects}
            onOpen={(id) => {
              const project = projects.find((p) => p.id === id);
              setActiveId(id);
              setLastExport(null);
              setView("edit");
              if (project?.source?.path) {
                const sourcePath = project.source.path;
                if (isTauri()) {
                  void toAssetUrl(sourcePath).then(setPreviewUrl).catch(() => setPreviewUrl(null));
                } else {
                  setPreviewUrl(sourcePath);
                }
              } else {
                setPreviewUrl(null);
              }
            }}
            onDelete={async (id) => {
              await removeProject(id);
              setProjects((prev) => prev.filter((p) => p.id !== id));
              if (activeId === id) {
                setActiveId(null);
                setView("library");
              }
            }}
            onNew={() => setView("record")}
          />
        )}

        {view === "record" && (
          <section className="panel">
            <h2>New recording</h2>
            <p className="muted">
              Pick a source, optionally enable the microphone, then start. A timer stays visible
              while recording; the OS picker chooses the exact screen or window.
            </p>
            <SourcePicker
              kind={kind}
              mic={mic}
              disabled={recState !== "idle"}
              capabilities={caps}
              onKind={setKind}
              onMic={setMic}
            />
            {recWarning && recState === "idle" && <p className="error-text">{recWarning}</p>}
            <div className="row">
              <button
                type="button"
                className="btn btn--primary"
                disabled={recState !== "idle"}
                onClick={() => void startRecording()}
              >
                {recState === "starting" ? "Starting…" : "Start recording"}
              </button>
              {recState === "recording" && (
                <button type="button" className="btn btn--danger" onClick={() => void handleStop()}>
                  Stop
                </button>
              )}
            </div>
          </section>
        )}

        {view === "edit" && activeProject && (
          <EditView
            project={activeProject}
            previewUrl={previewUrl}
            exporting={exporting}
            exportProgressMs={exportProgressMs}
            exportError={exportError}
            exportWarnings={exportWarnings}
            lastExport={lastExport}
            onChange={commit}
            onExport={() => void handleExport()}
            onBack={() => setView("library")}
            onReveal={(path) => void bridge.revealPath(path).catch(() => {})}
            onCopy={(path) => void bridge.copyPath(path).catch(() => {})}
          />
        )}

        {view === "edit" && !activeProject && (
          <EmptyState
            title="No recording selected"
            description="Pick a recording from the library to edit and export."
            action={
              <button type="button" className="btn btn--primary" onClick={() => setView("library")}>
                Back to library
              </button>
            }
          />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function LibraryView({
  projects,
  onOpen,
  onDelete,
  onNew,
}: {
  projects: Project[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  if (projects.length === 0) {
    return (
      <EmptyState
        title="No recordings yet"
        description="Record your screen, and it will appear here for editing and export."
        action={
          <button type="button" className="btn btn--primary" onClick={onNew}>
            New recording
          </button>
        }
      />
    );
  }

  return (
    <section className="library">
      <div className="row row--between">
        <h2>Your recordings</h2>
        <button type="button" className="btn btn--primary" onClick={onNew}>
          New recording
        </button>
      </div>
      <div className="grid">
        {projects.map((project) => (
          <article key={project.id} className="card">
            <h3 className="card__title">{project.name}</h3>
            <p className="muted">
              {formatDuration(project.source?.durationMs ?? 0)} ·{" "}
              {project.source ? `${project.source.width}×${project.source.height}` : "unknown size"}
            </p>
            <p className="muted">
              {project.exports.length} export{project.exports.length === 1 ? "" : "s"} ·{" "}
              {project.capture.kind}
            </p>
            <div className="row">
              <button type="button" className="btn btn--primary btn--sm" onClick={() => onOpen(project.id)}>
                Open
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onDelete(project.id)}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

function EditView({
  project,
  previewUrl,
  exporting,
  exportProgressMs,
  exportError,
  exportWarnings,
  lastExport,
  onChange,
  onExport,
  onBack,
  onReveal,
  onCopy,
}: {
  project: Project;
  previewUrl: string | null;
  exporting: boolean;
  exportProgressMs: number;
  exportError: string | null;
  exportWarnings: string[];
  lastExport: ExportArtifact | null;
  onChange: (project: Project) => void;
  onExport: () => void;
  onBack: () => void;
  onReveal: (path: string) => void;
  onCopy: (path: string) => void;
}) {
  const durationMs = project.source?.durationMs ?? 0;
  const clipMs = Math.max(0, project.trim.endMs - project.trim.startMs);

  const setFraming = (patch: Partial<Framing>) =>
    onChange({ ...project, framing: { ...project.framing, ...patch } });

  const setCallouts = (callouts: Callout[]) => onChange({ ...project, callouts });

  const setPreset = (presetId: string) => onChange(withPreset(project, presetId));

  return (
    <section className="edit">
      <div className="row row--between">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          ← Library
        </button>
        <input
          className="input input--title"
          value={project.name}
          onChange={(e) => onChange({ ...project, name: e.target.value })}
        />
      </div>

      <div className="edit__layout">
        <div className="edit__preview">
          <div
            className="stage"
            style={{
              aspectRatio: `${project.framing.outputWidth} / ${project.framing.outputHeight}`,
              background: project.framing.background,
              padding: `${(project.framing.paddingPx / project.framing.outputHeight) * 100}%`,
            }}
          >
            {previewUrl ? (
              <video className="stage__video" src={previewUrl} controls preload="metadata" />
            ) : (
              <div className="stage__placeholder">
                Preview is available after recording in the desktop app.
              </div>
            )}
            <div
              className="stage__crop"
              style={{
                left: `${project.crop.x * 100}%`,
                top: `${project.crop.y * 100}%`,
                width: `${project.crop.width * 100}%`,
                height: `${project.crop.height * 100}%`,
                borderRadius: project.framing.cornerRadiusPx,
              }}
            />
          </div>
          <p className="muted">
            Trim: {summarizeTrim(project)} · Output {project.framing.outputWidth}×
            {project.framing.outputHeight} @ {project.framing.fps}fps
          </p>
        </div>

        <aside className="edit__controls">
          {/* Trim */}
          <div className="control">
            <h4>Trim</h4>
            <label>
              <span>Start {formatDuration(project.trim.startMs)}</span>
              <input
                type="range"
                min={0}
                max={durationMs}
                step={10}
                value={project.trim.startMs}
                onChange={(e) =>
                  onChange(
                    withTrim(project, { startMs: Number(e.target.value), endMs: project.trim.endMs }),
                  )
                }
              />
            </label>
            <label>
              <span>End {formatDuration(project.trim.endMs)}</span>
              <input
                type="range"
                min={0}
                max={durationMs}
                step={10}
                value={project.trim.endMs}
                onChange={(e) =>
                  onChange(
                    withTrim(project, { startMs: project.trim.startMs, endMs: Number(e.target.value) }),
                  )
                }
              />
            </label>
            <p className="muted">Clip length {formatDuration(clipMs)}</p>
          </div>

          {/* Zoom */}
          <div className="control">
            <h4>Auto zoom</h4>
            <label className="toggle">
              <input
                type="checkbox"
                checked={project.zoom.enabled}
                onChange={(e) =>
                  onChange(withAutoZoom({ ...project, zoom: { ...project.zoom, enabled: e.target.checked } }))
                }
              />
              <span>Follow the cursor with smooth zooms</span>
            </label>
            <label>
              <span>Intensity {Math.round(project.zoom.intensity * 100)}%</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={project.zoom.intensity}
                disabled={!project.zoom.enabled}
                onChange={(e) => onChange(withAutoZoom(project, Number(e.target.value)))}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={project.cursorStyle.highlight}
                onChange={(e) =>
                  onChange({
                    ...project,
                    cursorStyle: { ...project.cursorStyle, highlight: e.target.checked },
                  })
                }
              />
              <span>Highlight the pointer</span>
            </label>
            <p className="muted">{project.zoom.keyframes.length} zoom keyframes</p>
          </div>

          {/* Crop */}
          <div className="control">
            <h4>Crop</h4>
            {(["x", "y", "width", "height"] as const).map((field) => (
              <label key={field}>
                <span>
                  {field} {Math.round(project.crop[field] * 100)}%
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={project.crop[field]}
                  onChange={(e) =>
                    onChange(withCrop(project, { ...project.crop, [field]: Number(e.target.value) }))
                  }
                />
              </label>
            ))}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onChange(withCrop(project, { x: 0, y: 0, width: 1, height: 1 }))}
            >
              Reset crop
            </button>
          </div>

          {/* Framing */}
          <div className="control">
            <h4>Framing</h4>
            <label>
              <span>Padding {project.framing.paddingPx}px</span>
              <input
                type="range"
                min={0}
                max={240}
                step={4}
                value={project.framing.paddingPx}
                onChange={(e) => setFraming({ paddingPx: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>Corner radius {project.framing.cornerRadiusPx}px</span>
              <input
                type="range"
                min={0}
                max={48}
                step={2}
                value={project.framing.cornerRadiusPx}
                onChange={(e) => setFraming({ cornerRadiusPx: Number(e.target.value) })}
              />
            </label>
            <label className="callout__color">
              <span>Background</span>
              <input
                type="color"
                value={project.framing.background.slice(0, 7)}
                onChange={(e) => setFraming({ background: e.target.value })}
              />
            </label>
          </div>

          {/* Callouts */}
          <div className="control">
            <CalloutEditor callouts={project.callouts} durationMs={clipMs} onChange={setCallouts} />
          </div>

          {/* Export */}
          <div className="control">
            <h4>Export</h4>
            <label>
              <span>Format</span>
              <select
                className="input"
                value={project.export.presetId}
                onChange={(e) => setPreset(e.target.value)}
              >
                {EXPORT_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn--primary"
              disabled={exporting}
              onClick={onExport}
            >
              {exporting ? "Exporting…" : "Export video"}
            </button>
            {exporting && (
              <p className="muted">
                Rendering {formatDuration(exportProgressMs)} of {formatDuration(clipMs)}…
              </p>
            )}
            {exportError && <p className="error-text">{exportError}</p>}
            {exportWarnings.map((warning) => (
              <p key={warning} className="warn-text">
                {warning}
              </p>
            ))}
          </div>

          {lastExport && (
            <SuccessState
              title="Export complete"
              description={`${formatBytes(lastExport.bytes)} · ${formatDuration(lastExport.durationMs)}`}
            >
              <ul className="artifact-list">
                {exportArtifacts(lastExport).map((item) => (
                  <li key={item.path}>
                    <span className="artifact-list__label">{item.label}</span>
                    <code title={item.path}>{item.path}</code>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => onCopy(item.path)}>
                      Copy
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => onReveal(item.path)}>
                      Reveal
                    </button>
                  </li>
                ))}
              </ul>
            </SuccessState>
          )}

          {project.exports.length > 0 && (
            <div className="control">
              <h4>Previous exports</h4>
              <ul className="artifact-list">
                {project.exports.map((artifact) => (
                  <li key={artifact.id}>
                    <span className="artifact-list__label">{artifact.presetId}</span>
                    <code title={artifact.videoPath}>{artifact.videoPath}</code>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => onReveal(artifact.videoPath)}
                    >
                      Reveal
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
