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
  type DriveProgress,
  type DriveStatus,
} from "./lib/bridge.js";
import { ScreenRecorder, recorderSupported } from "./lib/recorder.js";
import { loadProjects, persistProject, removeProject } from "./lib/projects.js";
import { LANGUAGES, useI18n, type Lang, type TranslationKey } from "./lib/i18n.js";
import { CalloutEditor } from "./components/CalloutEditor.js";
import { DriveButton, DriveSection, DriveSetupView, type DriveProps } from "./components/Drive.js";
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
  withExportDriveUrl,
} from "./core/project.js";
import { formatDuration } from "./core/time.js";
import type {
  Callout,
  CaptureKind,
  ExportArtifact,
  Framing,
  Project,
} from "./core/types.js";

type View = "library" | "record" | "edit" | "drive";
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

  const [driveStatus, setDriveStatus] = useState<DriveStatus | null>(null);
  const [driveConnecting, setDriveConnecting] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveUploads, setDriveUploads] = useState<Record<string, number>>({});

  const recorderRef = useRef<ScreenRecorder | null>(null);
  const stoppingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const projectsRef = useRef<Project[]>([]);
  projectsRef.current = projects;

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
          const [info, capabilities, drive] = await Promise.all([
            bridge.getAppInfo(),
            bridge.captureCapabilities(),
            bridge.driveStatus(),
          ]);
          if (cancelled) return;
          setAppInfo(info);
          setCaps(capabilities);
          setDriveStatus(drive);
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
    void listen<number>("recording://tick", (ms) => setElapsedMs(ms)).then((d) => disposers.push(d));
    void listen<null>("recording://stop-requested", () => void handleStop()).then((d) =>
      disposers.push(d),
    );
    void listen<number>("export://progress", (ms) => setExportProgressMs(ms)).then((d) =>
      disposers.push(d),
    );
    void listen<DriveProgress>("drive://progress", ({ path, sent, total }) =>
      setDriveUploads((prev) =>
        path in prev ? { ...prev, [path]: total > 0 ? sent / total : 1 } : prev,
      ),
    ).then((d) => disposers.push(d));
    return () => disposers.forEach((dispose) => dispose());
  }, [handleStop]);

  const startRecording = useCallback(async () => {
    setRecWarning(null);
    try {
      if (!recorderSupported()) {
        throw new Error(t("error.captureUnsupported"));
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
  }, [kind, mic, t]);

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

  const connectDrive = useCallback(async (): Promise<boolean> => {
    setDriveError(null);
    setDriveConnecting(true);
    try {
      const status = await bridge.driveConnect();
      setDriveStatus(status);
      return status.connected;
    } catch (error) {
      setDriveError(errMessage(error));
      return false;
    } finally {
      setDriveConnecting(false);
    }
  }, []);

  const disconnectDrive = useCallback(async () => {
    setDriveError(null);
    try {
      setDriveStatus(await bridge.driveDisconnect());
    } catch (error) {
      setDriveError(errMessage(error));
    }
  }, []);

  const uploadToDrive = useCallback(
    async (projectId: string, artifact: ExportArtifact) => {
      setDriveError(null);
      if (!driveStatus?.connected && !(await connectDrive())) return;
      const path = artifact.videoPath;
      setDriveUploads((prev) => ({ ...prev, [path]: 0 }));
      try {
        const file = await bridge.driveUpload(path);
        const latest = projectsRef.current.find((p) => p.id === projectId);
        if (latest) commit(withExportDriveUrl(latest, artifact.id, file.webViewLink));
      } catch (error) {
        setDriveError(errMessage(error));
        setDriveStatus(await bridge.driveStatus().catch(() => null));
      } finally {
        setDriveUploads(({ [path]: _done, ...rest }) => rest);
      }
    },
    [driveStatus, connectDrive, commit],
  );

  const saveDriveClient = useCallback(async (clientId: string, clientSecret: string) => {
    setDriveError(null);
    try {
      setDriveStatus(await bridge.driveSaveClient(clientId, clientSecret));
      return true;
    } catch (error) {
      setDriveError(errMessage(error));
      return false;
    }
  }, []);

  const clearDriveClient = useCallback(async () => {
    setDriveError(null);
    try {
      setDriveStatus(await bridge.driveClearClient());
    } catch (error) {
      setDriveError(errMessage(error));
    }
  }, []);

  const drive: DriveProps = {
    status: driveStatus,
    connecting: driveConnecting,
    error: driveError,
    uploads: driveUploads,
    onConnect: () => void connectDrive(),
    onDisconnect: () => void disconnectDrive(),
    onUpload: (artifact) => {
      if (activeProject) void uploadToDrive(activeProject.id, artifact);
    },
    onOpen: (url) => void bridge.openUrl(url).catch((error) => setDriveError(errMessage(error))),
    onSetup: () => {
      setDriveError(null);
      setView("drive");
    },
    onSaveClient: saveDriveClient,
    onClearClient: () => void clearDriveClient(),
  };

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
          <button
            type="button"
            className={`nav__link ${view === "drive" ? "nav__link--active" : ""}`}
            onClick={() => setView("drive")}
          >
            {t("nav.drive")}
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

        {view === "drive" && <DriveSetupView drive={drive} />}

        {view === "edit" && activeProject && (
          <EditView
            project={activeProject}
            previewUrl={previewUrl}
            exporting={exporting}
            exportProgressMs={exportProgressMs}
            exportError={exportError}
            exportWarnings={exportWarnings}
            lastExport={lastExport}
            drive={drive}
            onChange={commit}
            onExport={() => void handleExport()}
            onBack={() => setView("library")}
            onReveal={(path) => void bridge.revealPath(path).catch(() => {})}
            onCopy={(path) => void bridge.copyPath(path).catch(() => {})}
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

function EditView({
  project,
  previewUrl,
  exporting,
  exportProgressMs,
  exportError,
  exportWarnings,
  lastExport,
  drive,
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
  drive: DriveProps;
  onChange: (project: Project) => void;
  onExport: () => void;
  onBack: () => void;
  onReveal: (path: string) => void;
  onCopy: (path: string) => void;
}) {
  const { t } = useI18n();
  const durationMs = project.source?.durationMs ?? 0;
  const clipMs = Math.max(0, project.trim.endMs - project.trim.startMs);

  const setFraming = (patch: Partial<Framing>) =>
    onChange({ ...project, framing: { ...project.framing, ...patch } });

  const setCallouts = (callouts: Callout[]) => onChange({ ...project, callouts });

  const setPreset = (presetId: string) => onChange(withPreset(project, presetId));

  const latestExport = lastExport
    ? (project.exports.find((a) => a.id === lastExport.id) ?? lastExport)
    : null;

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
              <video className="stage__video" src={previewUrl} controls preload="metadata" />
            ) : (
              <div className="stage__placeholder">{t("edit.previewPlaceholder")}</div>
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
                  onChange(withAutoZoom({ ...project, zoom: { ...project.zoom, enabled: e.target.checked } }))
                }
              />
              <span>{t("edit.zoomFollow")}</span>
            </label>
            <label>
              <span>{t("edit.zoomIntensity", { percent: Math.round(project.zoom.intensity * 100) })}</span>
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
              <span>{t("edit.zoomHighlight")}</span>
            </label>
            <p className="muted">{t("edit.zoomKeyframes", { count: project.zoom.keyframes.length })}</p>
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

          {latestExport && (
            <SuccessState
              title={t("edit.exportComplete")}
              description={`${formatBytes(latestExport.bytes)} · ${formatDuration(latestExport.durationMs)}`}
            >
              <ul className="artifact-list">
                {exportArtifacts(latestExport).map((item) => (
                  <li key={item.path}>
                    <span className="artifact-list__label">{item.label}</span>
                    <code title={item.path}>{item.path}</code>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => onCopy(item.path)}>
                      {t("edit.copy")}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => onReveal(item.path)}>
                      {t("edit.reveal")}
                    </button>
                    {item.path === latestExport.videoPath && (
                      <DriveButton artifact={latestExport} drive={drive} />
                    )}
                  </li>
                ))}
              </ul>
            </SuccessState>
          )}

          <DriveSection drive={drive} />

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
                    <DriveButton artifact={artifact} drive={drive} />
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
