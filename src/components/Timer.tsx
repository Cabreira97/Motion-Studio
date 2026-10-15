import { formatDuration } from "../core/time.js";

/**
 * Always-visible recording timer. Rendered as a fixed banner while recording so
 * it cannot be scrolled out of view, and mirrored into the window title and
 * tray tooltip by the Rust session thread.
 */
export function RecordingBanner({
  elapsedMs,
  warning,
  onStop,
}: {
  elapsedMs: number;
  warning?: string | null;
  onStop: () => void;
}) {
  return (
    <div className="rec-banner" role="status" aria-live="polite">
      <span className="rec-banner__dot" aria-hidden="true" />
      <span className="rec-banner__label">REC</span>
      <span className="rec-banner__time">{formatDuration(elapsedMs)}</span>
      {warning && <span className="rec-banner__warning">{warning}</span>}
      <button type="button" className="btn btn--danger btn--sm" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}

export function TimerText({ elapsedMs }: { elapsedMs: number }) {
  return <span className="timer">{formatDuration(elapsedMs)}</span>;
}
