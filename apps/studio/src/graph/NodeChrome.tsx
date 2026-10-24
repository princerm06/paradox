import type { ReactNode } from "react";

/** State vocabulary shared by timeline cards and generation ghosts. */
export type StateKind =
  | "root"
  | "confirmed"
  | "pending"
  | "declined"
  | "running"
  | "failed"
  | "cancelled"
  | "unknown";

function glyph(kind: StateKind): ReactNode {
  switch (kind) {
    case "root":
      return (
        <>
          <circle cx="3.4" cy="3" r="1.4" />
          <circle cx="3.4" cy="9" r="1.4" />
          <circle cx="9.2" cy="6" r="1.4" />
          <path d="M3.4 4.4v3.2" />
          <path d="M4.8 6h3" />
        </>
      );
    case "confirmed":
      return <path d="M2.6 6.3 5 8.6 9.4 3.5" />;
    case "pending":
      return (
        <>
          <circle cx="6" cy="6" r="3.7" />
          <path d="M6 3.9v2.3l1.6 1" />
        </>
      );
    case "declined":
      return (
        <>
          <path d="M3.6 3.6 8.4 8.4" />
          <path d="M8.4 3.6 3.6 8.4" />
        </>
      );
    case "running":
      return <path d="M6 2a4 4 0 1 1-4 4" />;
    case "failed":
      return (
        <>
          <circle cx="6" cy="6" r="3.9" />
          <path d="M6 3.9v2.3" />
          <path d="M6 8.3h.01" />
        </>
      );
    case "cancelled":
      return (
        <>
          <circle cx="6" cy="6" r="3.9" />
          <path d="M3.2 8.8 8.8 3.2" />
        </>
      );
    default:
      return <circle cx="6" cy="6" r="3.7" />;
  }
}

function Icon({ kind, className }: { kind: StateKind; className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyph(kind)}
    </svg>
  );
}

/**
 * Lifecycle state. Independent of selection and of the live runtime so the three
 * can be read at once (a timeline can be active, selected and still unconfirmed).
 */
export function StatusChip({ kind, label, hint }: { kind: StateKind; label: string; hint?: string }) {
  return (
    <span className={`state-chip is-${kind}`} title={hint}>
      <Icon kind={kind} className={kind === "running" ? "state-icon is-spinning" : "state-icon"} />
      <span className="state-text">{label}</span>
    </span>
  );
}

/** Shown only for the backend-confirmed active timeline. */
export function LiveChip() {
  return (
    <span className="state-live" title="Serving the running application right now">
      <span className="state-live-dot" aria-hidden="true" />
      <span className="state-text">Live</span>
    </span>
  );
}

export function Lineage({ relation, when, hint }: { relation: string | null; when: string | null; hint?: string }) {
  if (!relation && !when) return null;
  return (
    <span className="future-lineage" title={hint}>
      {relation ? (
        <>
          <svg
            className="lineage-mark"
            viewBox="0 0 12 12"
            width="11"
            height="11"
            aria-hidden="true"
            focusable="false"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.2 2v3.6a2 2 0 0 0 2 2h3.4" />
            <path d="M7 6.1 8.8 7.6 7 9.1" />
          </svg>
          <span className="lineage-name">{relation}</span>
        </>
      ) : null}
      {relation && when ? (
        <span className="lineage-sep" aria-hidden="true">
          ·
        </span>
      ) : null}
      {when ? <span className="lineage-when">{when}</span> : null}
    </span>
  );
}

export function InspectButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" className="future-inspect" aria-label={`Inspect ${name}`} onClick={onClick}>
      <span>Inspect</span>
      <svg
        viewBox="0 0 12 12"
        width="11"
        height="11"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4.6 2.6 8 6l-3.4 3.4" />
      </svg>
    </button>
  );
}
