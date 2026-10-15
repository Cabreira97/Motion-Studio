import type { CaptureCapabilities } from "../lib/bridge.js";
import type { CaptureKind } from "../core/types.js";

const OPTIONS: Array<{ kind: CaptureKind; label: string; hint: string }> = [
  { kind: "screen", label: "Entire screen", hint: "Record a full display" },
  { kind: "window", label: "Window", hint: "Record a single application window" },
  { kind: "region", label: "Region", hint: "Record everything, crop later" },
];

/**
 * Source selection. The actual picker is the operating system's `getDisplayMedia`
 * sheet; these options describe intent and set the crop/zoom defaults.
 */
export function SourcePicker({
  kind,
  mic,
  disabled,
  capabilities,
  onKind,
  onMic,
}: {
  kind: CaptureKind;
  mic: boolean;
  disabled: boolean;
  capabilities: CaptureCapabilities | null;
  onKind: (kind: CaptureKind) => void;
  onMic: (mic: boolean) => void;
}) {
  const supported = (candidate: CaptureKind): boolean => {
    if (!capabilities) return true;
    if (candidate === "window") return capabilities.window;
    if (candidate === "region") return capabilities.region;
    return capabilities.screen;
  };

  return (
    <div className="picker">
      <fieldset className="picker__group" disabled={disabled}>
        <legend>Source</legend>
        <div className="picker__options">
          {OPTIONS.map((option) => {
            const ok = supported(option.kind);
            return (
              <label
                key={option.kind}
                className={`pick-card ${kind === option.kind ? "pick-card--active" : ""} ${
                  ok ? "" : "pick-card--disabled"
                }`}
              >
                <input
                  type="radio"
                  name="source"
                  value={option.kind}
                  checked={kind === option.kind}
                  disabled={!ok}
                  onChange={() => onKind(option.kind)}
                />
                <span className="pick-card__label">{option.label}</span>
                <span className="pick-card__hint">{option.hint}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <label className="toggle">
        <input
          type="checkbox"
          checked={mic}
          disabled={disabled}
          onChange={(event) => onMic(event.target.checked)}
        />
        <span>Record microphone</span>
      </label>

      {capabilities?.backend && (
        <p className="muted">Capture backend: {capabilities.backend}</p>
      )}
    </div>
  );
}
