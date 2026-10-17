import { useState } from "react";
import { useI18n, type TranslationKey } from "../lib/i18n.js";
import type { DriveStatus } from "../lib/bridge.js";
import type { ExportArtifact } from "../core/types.js";

export interface DriveProps {
  status: DriveStatus | null;
  connecting: boolean;
  error: string | null;
  uploads: Record<string, number>;
  onConnect: () => void;
  onDisconnect: () => void;
  onUpload: (artifact: ExportArtifact) => void;
  onOpen: (url: string) => void;
  onSetup: () => void;
  onSaveClient: (clientId: string, clientSecret: string) => Promise<boolean>;
  onClearClient: () => void;
}

const SETUP_STEPS: Array<{ title: TranslationKey; body: TranslationKey; url: string }> = [
  {
    title: "drive.step1.title",
    body: "drive.step1.body",
    url: "https://console.cloud.google.com/projectcreate",
  },
  {
    title: "drive.step2.title",
    body: "drive.step2.body",
    url: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  },
  {
    title: "drive.step3.title",
    body: "drive.step3.body",
    url: "https://console.cloud.google.com/auth/overview",
  },
  {
    title: "drive.step4.title",
    body: "drive.step4.body",
    url: "https://console.cloud.google.com/auth/audience",
  },
  {
    title: "drive.step5.title",
    body: "drive.step5.body",
    url: "https://console.cloud.google.com/auth/clients",
  },
];

export function DriveSection({ drive }: { drive: DriveProps }) {
  const { t } = useI18n();
  const { status, connecting, error } = drive;
  return (
    <div className="control">
      <h4>{t("drive.title")}</h4>
      {!status?.configured ? (
        <>
          <p className="muted">{t("drive.notConfigured")}</p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={drive.onSetup}>
            {t("drive.setupCta")}
          </button>
        </>
      ) : status.connected ? (
        <div className="row row--between">
          <span className="muted">
            {status.email ? t("drive.connectedAs", { email: status.email }) : t("drive.connected")}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={drive.onDisconnect}>
            {t("drive.disconnect")}
          </button>
        </div>
      ) : (
        <>
          <p className="muted">{t("drive.connectDesc")}</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={connecting}
            onClick={drive.onConnect}
          >
            {connecting ? t("drive.connecting") : t("drive.connect")}
          </button>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

export function DriveButton({ artifact, drive }: { artifact: ExportArtifact; drive: DriveProps }) {
  const { t } = useI18n();
  if (artifact.driveUrl) {
    const url = artifact.driveUrl;
    return (
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => drive.onOpen(url)}>
        {t("drive.open")}
      </button>
    );
  }
  const progress = drive.uploads[artifact.videoPath];
  if (progress !== undefined) {
    return (
      <button type="button" className="btn btn--ghost btn--sm" disabled>
        {t("drive.uploading", { percent: Math.round(progress * 100) })}
      </button>
    );
  }
  if (!drive.status?.configured) {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        title={t("drive.notConfiguredTitle")}
        onClick={drive.onSetup}
      >
        {t("drive.save")}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      disabled={drive.connecting}
      title={t("drive.saveTitle")}
      onClick={() => drive.onUpload(artifact)}
    >
      {t("drive.save")}
    </button>
  );
}

export function DriveSetupView({ drive }: { drive: DriveProps }) {
  const { t } = useI18n();
  const { status, connecting, error } = drive;
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const showForm = !status?.configured || editing;

  const save = async () => {
    if (!clientId.trim().endsWith(".apps.googleusercontent.com")) {
      setFormError(t("drive.setup.invalidId"));
      return;
    }
    if (clientSecret.trim().length < 8) {
      setFormError(t("drive.setup.invalidSecret"));
      return;
    }
    setFormError(null);
    setSaving(true);
    const ok = await drive.onSaveClient(clientId, clientSecret);
    setSaving(false);
    if (ok) {
      setEditing(false);
      setClientSecret("");
    }
  };

  return (
    <section className="panel drive-setup">
      <h2>{t("drive.title")}</h2>
      <p className="muted">{t("drive.setup.intro")}</p>

      <div className="drive-setup__status">
        {!status?.configured ? (
          <span className="pill pill--warn">{t("drive.setup.stateNotConfigured")}</span>
        ) : status.connected ? (
          <>
            <span className="pill pill--ok">
              {status.email ? t("drive.connectedAs", { email: status.email }) : t("drive.connected")}
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={drive.onDisconnect}>
              {t("drive.disconnect")}
            </button>
          </>
        ) : (
          <>
            <span className="pill pill--warn">{t("drive.setup.stateReady")}</span>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={connecting}
              onClick={drive.onConnect}
            >
              {connecting ? t("drive.connecting") : t("drive.connect")}
            </button>
          </>
        )}
      </div>
      {connecting && <p className="muted">{t("drive.setup.connectingHint")}</p>}

      {status?.configured && !editing && (
        <div className="control drive-setup__client">
          <h4>{t("drive.setup.clientTitle")}</h4>
          <p className="muted">
            {status.clientSource === "env" ? t("drive.setup.fromEnv") : t("drive.setup.fromApp")}
          </p>
          <code className="drive-setup__id">{status.clientId}</code>
          <div className="row">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>
              {t("drive.setup.change")}
            </button>
            {status.clientSource === "app" && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={drive.onClearClient}>
                {t("drive.setup.remove")}
              </button>
            )}
          </div>
        </div>
      )}

      {showForm && (
        <>
          <h3 className="drive-setup__heading">{t("drive.setup.stepsTitle")}</h3>
          <ol className="steps">
            {SETUP_STEPS.map((step) => (
              <li key={step.title} className="steps__item">
                <div className="steps__body">
                  <strong>{t(step.title)}</strong>
                  <p className="muted">{t(step.body)}</p>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => drive.onOpen(step.url)}
                >
                  {t("drive.setup.openPage")}
                </button>
              </li>
            ))}
            <li className="steps__item steps__item--form">
              <div className="steps__body">
                <strong>{t("drive.step6.title")}</strong>
                <p className="muted">{t("drive.step6.body")}</p>
                <form
                  className="drive-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  <label>
                    <span>{t("drive.setup.clientId")}</span>
                    <input
                      className="input"
                      value={clientId}
                      placeholder="1234567890-abc123.apps.googleusercontent.com"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t("drive.setup.clientSecret")}</span>
                    <div className="drive-form__secret">
                      <input
                        className="input"
                        type={showSecret ? "text" : "password"}
                        value={clientSecret}
                        placeholder="GOCSPX-…"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setClientSecret(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setShowSecret((v) => !v)}
                      >
                        {showSecret ? t("drive.setup.hide") : t("drive.setup.show")}
                      </button>
                    </div>
                  </label>
                  {formError && <p className="error-text">{formError}</p>}
                  <div className="row">
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={saving || !clientId.trim() || !clientSecret.trim()}
                    >
                      {saving ? t("drive.setup.saving") : t("drive.setup.save")}
                    </button>
                    {editing && (
                      <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>
                        {t("drive.setup.cancel")}
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </li>
          </ol>
        </>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="drive-setup__notes">
        <p className="muted">{t("drive.setup.noteUnverified")}</p>
        <p className="muted">{t("drive.setup.notePrivacy")}</p>
      </div>
    </section>
  );
}
