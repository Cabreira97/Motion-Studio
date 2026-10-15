import type { Callout } from "../core/types.js";
import { formatDuration } from "../core/time.js";
import { useI18n } from "../lib/i18n.js";

const BLANK = {
  text: "",
  x: 0.5,
  y: 0.5,
  fontSize: 28,
  color: "#ffffff",
  boxColor: "#000000cc",
  durationMs: 2000,
};

/**
 * Inline editor for timed text callouts. Each callout is anchored by normalized
 * x/y within the frame and rendered by ffmpeg `drawtext` during export.
 */
export function CalloutEditor({
  callouts,
  durationMs,
  onChange,
}: {
  callouts: Callout[];
  durationMs: number;
  onChange: (callouts: Callout[]) => void;
}) {
  const { t } = useI18n();
  const update = (id: string, patch: Partial<Callout>) => {
    onChange(callouts.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const remove = (id: string) => onChange(callouts.filter((c) => c.id !== id));

  const add = () => {
    onChange([
      ...callouts,
      { id: crypto.randomUUID(), t: 0, ...BLANK, text: t("callouts.newText") },
    ]);
  };

  return (
    <div className="callouts">
      <div className="row row--between">
        <h4>{t("callouts.title")}</h4>
        <button type="button" className="btn btn--ghost btn--sm" onClick={add}>
          + {t("callouts.add")}
        </button>
      </div>

      {callouts.length === 0 && <p className="muted">{t("callouts.empty")}</p>}

      {callouts.map((callout) => (
        <div key={callout.id} className="callout">
          <input
            className="input"
            value={callout.text}
            placeholder={t("callouts.placeholder")}
            onChange={(e) => update(callout.id, { text: e.target.value })}
          />
          <div className="callout__grid">
            <label>
              <span>{t("callouts.at", { time: formatDuration(callout.t) })}</span>
              <input
                type="range"
                min={0}
                max={Math.max(durationMs, 1)}
                step={50}
                value={callout.t}
                onChange={(e) => update(callout.id, { t: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>{t("callouts.duration", { time: formatDuration(callout.durationMs) })}</span>
              <input
                type="range"
                min={200}
                max={Math.max(durationMs, 200)}
                step={100}
                value={callout.durationMs}
                onChange={(e) => update(callout.id, { durationMs: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>X {Math.round(callout.x * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={callout.x}
                onChange={(e) => update(callout.id, { x: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>Y {Math.round(callout.y * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={callout.y}
                onChange={(e) => update(callout.id, { y: Number(e.target.value) })}
              />
            </label>
            <label className="callout__color">
              <span>{t("callouts.text")}</span>
              <input
                type="color"
                value={callout.color.slice(0, 7)}
                onChange={(e) => update(callout.id, { color: e.target.value })}
              />
            </label>
            <label className="callout__color">
              <span>{t("callouts.box")}</span>
              <input
                type="color"
                value={callout.boxColor.slice(0, 7)}
                onChange={(e) => update(callout.id, { boxColor: `${e.target.value}cc` })}
              />
            </label>
          </div>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => remove(callout.id)}
          >
            {t("callouts.remove")}
          </button>
        </div>
      ))}
    </div>
  );
}
