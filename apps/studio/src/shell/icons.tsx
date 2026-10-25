export function Mark() {
  return <img className="mark" src="/paradox-mark.svg" alt="" width="36" height="36" />;
}

export function ModeIcon({ mode }: { mode: "explore" | "architect" | "analyze" }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {mode === "explore" ? <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><path d="M8 5h3a5 5 0 0 1 5 5v7M6 7v12" /></> : null}
      {mode === "architect" ? <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></> : null}
      {mode === "analyze" ? <><path d="m8 3-4 4 4 4M4 7h13a3 3 0 0 1 3 3v1m-4 10 4-4-4-4M20 17H7a3 3 0 0 1-3-3v-1" /></> : null}
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 12a7 7 0 1 1-1.6-4.4" />
      <path d="M19 5v4h-4" />
    </svg>
  );
}
