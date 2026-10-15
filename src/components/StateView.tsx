import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n.js";

/** The four first-class UI states required everywhere. */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (    <div className="state state--empty" role="status">
      <div className="state__icon" aria-hidden="true">
        ○
      </div>
      <h3 className="state__title">{title}</h3>
      <p className="state__text">{description}</p>
      {action && <div className="state__action">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Working…" }: { label?: string }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p className="state__text">{label}</p>
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="state state--error" role="alert">
      <div className="state__icon" aria-hidden="true">
        !
      </div>
      <h3 className="state__title">{title}</h3>
      <p className="state__text">{message}</p>
      {onRetry && (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}

export function SuccessState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="state state--success" role="status">
      <div className="state__icon" aria-hidden="true">
        ✓
      </div>
      <h3 className="state__title">{title}</h3>
      {description && <p className="state__text">{description}</p>}
      {children}
    </div>
  );
}
