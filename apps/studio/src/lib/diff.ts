import type { ChangedFile, Generation } from "../api/types.ts";

export type DiffLine = { kind: "add" | "del" | "ctx" | "meta"; text: string; oldNo: number | null; newNo: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

function stripPrefix(raw: string): string | null {
  const value = raw.trim().split("\t")[0];
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/**
 * Parse a unified diff (the engine's `/diff` body) into files and hunks.
 * Pure and tolerant: unrecognised lines become meta lines rather than errors.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!text || !text.trim()) return files;
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      file = null;
      hunk = null;
      continue;
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      const oldPath = stripPrefix(line.slice(4));
      const newPath = stripPrefix(lines[index + 1].slice(4));
      index += 1;
      file = {
        path: newPath ?? oldPath ?? "unknown",
        oldPath,
        newPath,
        status: oldPath === null ? "added" : newPath === null ? "deleted" : "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header && file) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!file || !hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      newNo += 1;
      file.additions += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
      file.deletions += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else if (line === "" && index === lines.length - 1) {
      // Trailing newline at end of body.
    } else if (line === "") {
      hunk.lines.push({ kind: "ctx", text: "", oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }
  return files;
}

/** The engine's own per-file summary (`generation.changes.files`), validated. */
export function reportedFiles(generation: Pick<Generation, "changes"> | null | undefined): ChangedFile[] {
  const files = generation?.changes?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((file): file is ChangedFile => Boolean(file) && typeof file.path === "string");
}

export function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

export function baseName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}
