/** Per-tab, per-engine storage for UI context worth recovering after a refresh. */

function sessionKey(base: string, name: string): string {
  return `paradox.session:${base}:${name}`;
}

export function readSession(base: string, name: string): string | null {
  try {
    return sessionStorage.getItem(sessionKey(base, name));
  } catch {
    return null;
  }
}

export function writeSession(base: string, name: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(sessionKey(base, name));
    else sessionStorage.setItem(sessionKey(base, name), value);
  } catch {
    /* Recovery is best effort. */
  }
}
