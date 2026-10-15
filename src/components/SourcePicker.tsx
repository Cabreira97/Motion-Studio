import type { CaptureCapabilities } from "../lib/bridge.js";
import { useI18n, type TranslationKey } from "../lib/i18n.js";
import type { CaptureKind } from "../core/types.js";

const OPTIONS: Array<{ kind: CaptureKind; label: TranslationKey; hint: TranslationKey }> = [
  { kind: "screen", label: "source.screen", hint: "source.screenHint" },
  { kind: "window", label: "source.window", hint: "source.windowHint" },
  { kind: "region", label: "source.region", hint: "source.regionHint" },
];

/**
 * Source selection. The options set the `displaySurface` hint passed to the
 * operating system's `getDisplayMedia` picker (and a default crop for regions).
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
  const { t } = useI18n();

  const supported = (candidate: CaptureKind): boolean => {
    if (!capabilities) return true;
    if (candidate === "window") return capabilities.window;
    if (candidate === "region") return capabilities.region;
    return capabilities.screen;
  };

  return (
    <div className="picker">
      <fieldset className="picker__group" disabled={disabled}>
        <legend>{t("source.legend")}</legend>
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
                  disabled={disabled || !ok}
                  onChange={() => onKind(option.kind)}
                />
                <span className="pick-card__label">{t(option.label)}</span>
                <span className="pick-card__hint">{t(option.hint)}</span>
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
          onChange={(e) => onMic(e.target.checked)}
        />
        <span>{t("source.mic")}</span>
      </label>

      {capabilities?.backend && (
        <p className="muted">{t("source.backend", { backend: capabilities.backend })}</p>
      )}
    </div>
  );
}
