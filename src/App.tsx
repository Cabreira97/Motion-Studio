import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BridgeUnavailableError,
  bridge,
  createTauriPorts,
  isTauri,
  listen,
  toMediaUrl,
  type AppInfo,
  type CaptureCapabilities,
  type TickPayload,
} from "./lib/bridge.js";
import { createRecorder, recorderSupported, type Recorder } from "./lib/recorder.js";
import { loadProjects, persistProject, removeProject } from "./lib/projects.js";
import { LANGUAGES, useI18n, type Lang, type TranslationKey } from "./lib/i18n.js";
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
  addZoomStop,
  createProject,
  removeZoomStop,
  summarizeTrim,
  timestampName,
  updateZoomStop,
  withCrop,
  withPreset,
  withTrim,
  withZoomMode,
  withZoomTimeline,
} from "./core/project.js";
import { formatDuration } from "./core/time.js";
import { MAX_ZOOM_SCALE, MIN_STOP_MS, MIN_ZOOM_SCALE } from "./core/zoom.js";
import type {
  Callout,
  CaptureKind,
  ExportArtifact,
  Framing,
  Project,
} from "./core/types.js";

type View = "library" | "record" | "edit";
type RecState = "idle" | "starting" | "recording" | "stopping";

const KIND_KEY: Record<CaptureKind, TranslationKey> = {
  screen: "kind.screen",
  window: "kind.window",
  region: "kind.region",
};

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
  const { t, lang, setLang } = useI18n();
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

  const recorderRef = useRef<Recorder | null>(null);
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
    document.title = `● ${formatDuration(elapsedMs)} — Motion Studio`;
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [recState, elapsedMs]);

  useEffect(() => {
    if (recState !== "recording") document.title = "Motion Studio";
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

      if (result.path) {
        // The native backend already wrote the file. Sending the bytes back
        // through the bridge only to write them out again would copy a whole
        // recording through JSON for nothing.
        sourcePath = result.path;
      } else if (result.blob && isTauri()) {
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        const saved = await bridge.saveRecording(timestampName("Recording", Date.now()), bytes);
        sourcePath = saved.path;
      }

      if (sourcePath && isTauri()) {
        // Read the real numbers off the file rather than trusting what the
        // recorder reported: this is what the editor and the export act on.
        const info = await bridge.probeMedia(sourcePath);
        sourceWidth = info.width || sourceWidth;
        sourceHeight = info.height || sourceHeight;
        durationMs = info.durationMs || durationMs;
        fps = info.fps || fps;
        hasAudio = info.hasAudio;
        setPreviewUrl(await toMediaUrl(sourcePath));
      } else if (result.blob) {
        sourcePath = URL.createObjectURL(result.blob);
        setPreviewUrl(sourcePath);
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
          durationMs,
          fps,
          hasAudio,
        },
        cursorTrack,
        presetId: "mp4-1080p",
      });

      const framed =
        kind === "region"
          ? withCrop(project, { x: 0.15, y: 0.15, width: 0.7, height: 0.7 })
          : project;

      await persistProject(framed);
      setProjects((prev) => [framed, ...prev]);
      setActiveId(framed.id);
      setLastExport(null);
      setView("edit");

      setRecWarning(hasAudio || !mic ? null : t("error.micWarning"));
    } catch (error) {
      setRecWarning(errMessage(error));
    } finally {
      recorderRef.current = null;
      stoppingRef.current = false;
      setElapsedMs(0);
      setRecState("idle");
    }
  }, [kind, mic, t]);

  useEffect(() => {
    if (!isTauri()) return;
    const disposers: Array<() => void> = [];
    void listen<TickPayload>("recording://tick", (tick) => setElapsedMs(tick.elapsedMs)).then((d) =>
      disposers.push(d),
    );
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
      // The backend decides who records. On Linux the webview cannot, so Rust
      // does it and writes the file itself; everywhere else this is the
      // webview recorder and nothing about the flow changes.
      const backend = caps?.videoBackend ?? "webview";
      if (!recorderSupported(backend)) {
        throw new Error(t("error.captureUnsupported"));
      }
      setRecState("starting");
      const recorder = createRecorder(backend);
      const name = timestampName("Recording", Date.now());
      await recorder.start({ kind, mic, fps: 30, name });
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
  }, [caps, kind, mic, t]);

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
      setExportError(t("error.exportNeedsDesktop"));
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
  }, [activeProject, appInfo, commit, t]);

  if (boot === "loading") return <LoadingState label={t("boot.loading")} />;
  if (boot === "error") return <ErrorState message={bootError} onRetry={() => location.reload()} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" />
          <strong>Motion&nbsp;Studio</strong>
          <span className="muted">local</span>
        </div>
        <nav className="nav">
          <button
            type="button"
            className={`nav__link ${view === "library" ? "nav__link--active" : ""}`}
            onClick={() => setView("library")}
          >
            {t("nav.library")}
          </button>
          <button
            type="button"
            className={`nav__link ${view === "record" ? "nav__link--active" : ""}`}
            onClick={() => setView("record")}
          >
            {t("nav.new")}
          </button>
        </nav>
        <div className="topbar__meta">
          {recState === "recording" && <TimerText elapsedMs={elapsedMs} />}
          <label className="lang" title={t("lang.label")}>
            <span className="muted">{t("lang.label")}</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
              {LANGUAGES.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {appInfo?.ffmpegPath ? (
            <span className="pill pill--ok" title={appInfo.ffmpegPath}>
              {t("status.ffmpegReady")}
            </span>
          ) : (
            <span className="pill pill--warn" title={t("status.ffmpegMissingTitle")}>
              {t("status.ffmpegMissing")}
            </span>
          )}
        </div>
      </header>

      {recState === "recording" && (
        <RecordingBanner elapsedMs={elapsedMs} warning={recWarning} onStop={() => void handleStop()} />
      )}

      {!isTauri() && (
        <div className="notice">{t("browser.notice")}</div>
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
                  void toMediaUrl(sourcePath).then(setPreviewUrl).catch(() => setPreviewUrl(null));
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
            <h2>{t("record.title")}</h2>
            <p className="muted">{t("record.desc")}</p>
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
              {recState === "starting" ? t("record.starting") : t("record.start")}
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
            onReveal={(path) =>
              void bridge
                .revealPath(path)
                .catch((error) =>
                  setExportError(t("error.revealFailed", { message: errMessage(error) })),
                )
            }
            onCopy={(path) =>
              void bridge
                .copyPath(path)
                .catch((error) =>
                  setExportError(t("error.copyFailed", { message: errMessage(error) })),
                )
            }
          />
        )}

        {view === "edit" && !activeProject && (
          <EmptyState
            title={t("edit.noSelectionTitle")}
            description={t("edit.noSelectionDesc")}
            action={
              <button type="button" className="btn btn--primary" onClick={() => setView("library")}>
                {t("edit.backToLibrary")}
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
  const { t } = useI18n();
  if (projects.length === 0) {
    return (
      <EmptyState
        title={t("library.emptyTitle")}
        description={t("library.emptyDesc")}
        action={
          <button type="button" className="btn btn--primary" onClick={onNew}>
            {t("nav.new")}
          </button>
        }
      />
    );
  }

  return (
    <section className="library">
      <div className="row row--between">
        <h2>{t("library.title")}</h2>
        <button type="button" className="btn btn--primary" onClick={onNew}>
          {t("nav.new")}
        </button>
      </div>
      <div className="grid">
        {projects.map((project) => (
          <article key={project.id} className="card">
            <h3 className="card__title">{project.name}</h3>
            <p className="muted">
              {formatDuration(project.source?.durationMs ?? 0)} ·{" "}
              {project.source
                ? `${project.source.width}×${project.source.height}`
                : t("library.unknownSize")}
            </p>
            <p className="muted">
              {t("library.meta", {
                count: project.exports.length,
                kind: t(KIND_KEY[project.capture.kind]),
              })}
            </p>
            <div className="row">
              <button type="button" className="btn btn--primary btn--sm" onClick={() => onOpen(project.id)}>
                {t("library.open")}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onDelete(project.id)}
              >
                {t("library.delete")}
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

/**
 * A human-readable reason for a `<video>` failure. The numeric code is kept
 * because it is what makes a report actionable: 4 means the source itself was
 * refused, 2 means it was reachable but the transfer broke.
 */
function describeMediaError(error: MediaError | null): string {
  if (!error) return "unknown";
  const names: Record<number, string> = {
    1: "aborted",
    2: "network",
    3: "decode",
    4: "source not supported",
  };
  const name = names[error.code] ?? "unknown";
  return error.message ? `${name} ${error.code}: ${error.message}` : `${name} ${error.code}`;
}

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
  const { t } = useI18n();
  const durationMs = project.source?.durationMs ?? 0;
  const clipMs = Math.max(0, project.trim.endMs - project.trim.startMs);

  // Manual zoom is authored against the preview: the playhead gives the time,
  // clicking the frame gives the focus point.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // A new source gets a clean slate; the element reports its own failure again.
  useEffect(() => setPreviewError(null), [previewUrl]);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const stops = project.zoom.stops;
  const manualZoom = project.zoom.mode === "manual";
  const selectedStop = stops.find((s) => s.id === selectedStopId) ?? null;
  const pickingFocus = manualZoom && selectedStop !== null;

  const addStopAtPlayhead = () => {
    const id = `zs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setSelectedStopId(id);
    onChange(addZoomStop(project, { id, t: playheadMs }));
  };

  /** Click-to-focus: maps a click on the stage to a 0..1 point on the frame. */
  const focusFromClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (project.zoom.mode !== "manual" || !selectedStop) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cx = (event.clientX - rect.left) / rect.width;
    const cy = (event.clientY - rect.top) / rect.height;
    onChange(updateZoomStop(project, selectedStop.id, { cx, cy }));
  };

  const setFraming = (patch: Partial<Framing>) =>
    onChange({ ...project, framing: { ...project.framing, ...patch } });

  const setCallouts = (callouts: Callout[]) => onChange({ ...project, callouts });

  const setPreset = (presetId: string) => onChange(withPreset(project, presetId));

  return (
    <section className="edit">
      <div className="row row--between">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          ← {t("edit.back")}
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
              <video
                ref={videoRef}
                className="stage__video"
                src={previewUrl}
                controls
                preload="metadata"
                onLoadedMetadata={() => setPreviewError(null)}
                onError={(e) => setPreviewError(describeMediaError(e.currentTarget.error))}
                onTimeUpdate={(e) => setPlayheadMs(Math.round(e.currentTarget.currentTime * 1000))}
              />
            ) : (
              <div className="stage__placeholder">{t("edit.previewPlaceholder")}</div>
            )}
            {previewError && (
              <div className="stage__placeholder stage__placeholder--error">
                {t("edit.previewFailed", { reason: previewError })}
              </div>
            )}
            {/* The zoom focus is normalized against the *cropped* frame, which
                is exactly what this box outlines — so it doubles as the
                click target for picking a focus point. */}
            <div
              className="stage__crop"
              onClick={focusFromClick}
              style={{
                left: `${project.crop.x * 100}%`,
                top: `${project.crop.y * 100}%`,
                width: `${project.crop.width * 100}%`,
                height: `${project.crop.height * 100}%`,
                borderRadius: project.framing.cornerRadiusPx,
                ...(pickingFocus ? { pointerEvents: "auto" as const, cursor: "crosshair" } : {}),
              }}
            >
              {pickingFocus && (
                <span
                  className="stage__focus"
                  style={{ left: `${selectedStop.cx * 100}%`, top: `${selectedStop.cy * 100}%` }}
                />
              )}
            </div>
          </div>
          <p className="muted">
            {t("edit.summary", {
              summary: summarizeTrim(project),
              width: project.framing.outputWidth,
              height: project.framing.outputHeight,
              fps: project.framing.fps,
            })}
          </p>
        </div>

        <aside className="edit__controls">
          {/* Trim */}
          <div className="control">
            <h4>{t("edit.trim")}</h4>
            <label>
              <span>{t("edit.trimStart", { time: formatDuration(project.trim.startMs) })}</span>
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
              <span>{t("edit.trimEnd", { time: formatDuration(project.trim.endMs) })}</span>
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
            <p className="muted">{t("edit.clipLength", { time: formatDuration(clipMs) })}</p>
          </div>

          {/* Zoom */}
          <div className="control">
            <h4>{t("edit.zoom")}</h4>
            <label className="toggle">
              <input
                type="checkbox"
                checked={project.zoom.enabled}
                onChange={(e) =>
                  onChange(
                    withZoomTimeline({
                      ...project,
                      zoom: { ...project.zoom, enabled: e.target.checked },
                    }),
                  )
                }
              />
              <span>{t("edit.zoomEnabled")}</span>
            </label>

            <div className="seg" role="group" aria-label={t("edit.zoomMode")}>
              {(["auto", "manual"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`seg__btn${project.zoom.mode === mode ? " seg__btn--on" : ""}`}
                  disabled={!project.zoom.enabled}
                  onClick={() => onChange(withZoomMode(project, mode))}
                >
                  {t(mode === "auto" ? "edit.zoomModeAuto" : "edit.zoomModeManual")}
                </button>
              ))}
            </div>

            {manualZoom ? (
              <>
                <p className="muted">{t("edit.zoomManualHint")}</p>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={!project.zoom.enabled}
                  onClick={addStopAtPlayhead}
                >
                  {t("edit.zoomAddStop", { time: formatDuration(playheadMs) })}
                </button>

                {stops.length === 0 ? (
                  <p className="muted">{t("edit.zoomNoStops")}</p>
                ) : (
                  <ul className="stops">
                    {stops.map((stop) => (
                      <li
                        key={stop.id}
                        className={`stops__item${stop.id === selectedStopId ? " stops__item--on" : ""}`}
                      >
                        <div className="row row--between">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setSelectedStopId(stop.id)}
                          >
                            {t("edit.zoomStopLabel", {
                              time: formatDuration(stop.t),
                              scale: stop.scale.toFixed(1),
                            })}
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              if (stop.id === selectedStopId) setSelectedStopId(null);
                              onChange(removeZoomStop(project, stop.id));
                            }}
                          >
                            {t("edit.zoomRemoveStop")}
                          </button>
                        </div>
                        <label>
                          <span>{t("edit.zoomStopScale", { scale: stop.scale.toFixed(2) })}</span>
                          <input
                            type="range"
                            min={MIN_ZOOM_SCALE}
                            max={MAX_ZOOM_SCALE}
                            step={0.05}
                            value={stop.scale}
                            onChange={(e) =>
                              onChange(
                                updateZoomStop(project, stop.id, { scale: Number(e.target.value) }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>
                            {t("edit.zoomStopDuration", { time: formatDuration(stop.durationMs) })}
                          </span>
                          <input
                            type="range"
                            min={MIN_STOP_MS}
                            max={Math.max(MIN_STOP_MS, clipMs)}
                            step={100}
                            value={stop.durationMs}
                            onChange={(e) =>
                              onChange(
                                updateZoomStop(project, stop.id, {
                                  durationMs: Number(e.target.value),
                                }),
                              )
                            }
                          />
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <label>
                <span>
                  {t("edit.zoomIntensity", { percent: Math.round(project.zoom.intensity * 100) })}
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={project.zoom.intensity}
                  disabled={!project.zoom.enabled}
                  onChange={(e) => onChange(withZoomTimeline(project, Number(e.target.value)))}
                />
              </label>
            )}
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
              <span>{t("edit.zoomHighlight")}</span>
            </label>
            <p className="muted">{t("edit.zoomKeyframes", { count: project.zoom.keyframes.length })}</p>
            {/* Auto-zoom silently produces nothing without a cursor track —
                most often on Wayland, which does not report the global cursor
                position. Say so, and point at the mode that does work. */}
            {project.zoom.enabled && !manualZoom && project.cursorTrack.length === 0 && (
              <p className="warn-text">{t("edit.zoomNoCursorTrack")}</p>
            )}
          </div>

          {/* Crop */}
          <div className="control">
            <h4>{t("edit.crop")}</h4>
            {(["x", "y", "width", "height"] as const).map((field) => (
              <label key={field}>
                <span>
                  {t("edit.cropField", { field, percent: Math.round(project.crop[field] * 100) })}
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
              {t("edit.resetCrop")}
            </button>
          </div>

          {/* Framing */}
          <div className="control">
            <h4>{t("edit.framing")}</h4>
            <label>
              <span>{t("edit.padding", { px: project.framing.paddingPx })}</span>
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
              <span>{t("edit.radius", { px: project.framing.cornerRadiusPx })}</span>
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
              <span>{t("edit.background")}</span>
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
            <h4>{t("edit.export")}</h4>
            <label>
              <span>{t("edit.preset")}</span>
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
              {exporting ? `${t("edit.export")}…` : t("edit.exportVideo")}
            </button>
            {exporting && (
              <p className="muted">
                {t("edit.exportProgress", {
                  done: formatDuration(exportProgressMs),
                  total: formatDuration(clipMs),
                })}
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
              title={t("edit.exportComplete")}
              description={`${formatBytes(lastExport.bytes)} · ${formatDuration(lastExport.durationMs)}`}
            >
              <ul className="artifact-list">
                {exportArtifacts(lastExport).map((item) => (
                  <li key={item.path}>
                    <span className="artifact-list__label">{item.label}</span>
                    <code title={item.path}>{item.path}</code>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => onCopy(item.path)}>
                      {t("edit.copy")}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => onReveal(item.path)}>
                      {t("edit.reveal")}
                    </button>
                  </li>
                ))}
              </ul>
            </SuccessState>
          )}

          {project.exports.length > 0 && (
            <div className="control">
              <h4>{t("edit.previousExports")}</h4>
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
                      {t("edit.reveal")}
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
