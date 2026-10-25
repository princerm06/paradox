export function FutureVisual({ attempt = false }: { attempt?: boolean }) {
  return (
    <span className="future-visual" role="img" aria-label={attempt ? "Generation attempt; no application capture available" : "Application capture unavailable"}>
      <svg viewBox="0 0 64 70" fill="none" aria-hidden="true">
        <path className="visual-orbit" d="M9 34C9 9 55 9 55 34S9 59 9 34Z" />
        <path className="visual-path" d="M12 35h12c10 0 10-19 26-19M24 35c10 0 10 19 26 19M24 35h26" />
        <circle cx="12" cy="35" r="4" /><circle cx="50" cy="16" r="4" /><circle cx="50" cy="35" r="3" /><circle cx="50" cy="54" r="4" />
        <circle className="visual-origin" cx="24" cy="35" r="2.5" />
      </svg>
      <span>No capture</span>
    </span>
  );
}

export function SelectionChip() {
  return <span className="future-selection">Selected</span>;
}
