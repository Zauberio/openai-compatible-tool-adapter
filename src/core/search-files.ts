import { spawnSync } from "node:child_process";
import { WorkspaceGuard } from "./workspace-guard.js";

export type SearchFilesResult = {
  ok: boolean;
  status: number | null;
  matches: string[];
  truncated: boolean;
  stderr: string;
};

let nullDelimSupported: boolean | undefined;

export function grepSupportsNullDelimiter(): boolean {
  if (nullDelimSupported !== undefined) return nullDelimSupported;
  const probe = spawnSync("grep", ["--null", "--help"], { encoding: "utf8", timeout: 5000 });
  const text = `${probe.stdout || ""}${probe.stderr || ""}`;
  // GNU grep documents --null; BSD/macOS grep rejects the long option.
  nullDelimSupported = probe.status === 0 && /--null/.test(text) && !/unrecognized option|illegal option|unknown option/i.test(text);
  if (probe.status !== 0 && /unrecognized option|illegal option|unknown option/i.test(text)) {
    nullDelimSupported = false;
  }
  if (probe.status === 0 && /--null/.test(text)) nullDelimSupported = true;
  return Boolean(nullDelimSupported);
}

function parseNulRecords(stdout: string): Array<{ filePart: string; text: string }> {
  const out: Array<{ filePart: string; text: string }> = [];
  let offset = 0;
  while (offset < stdout.length) {
    const nul = stdout.indexOf("\0", offset);
    if (nul === -1) break;
    const filePart = stdout.slice(offset, nul);
    offset = nul + 1;
    const nl = stdout.indexOf("\n", offset);
    const text = nl === -1 ? stdout.slice(offset) : stdout.slice(offset, nl);
    offset = nl === -1 ? stdout.length : nl + 1;
    if (filePart) out.push({ filePart, text });
  }
  return out;
}

function parseColonRecords(stdout: string): Array<{ filePart: string; text: string }> {
  const out: Array<{ filePart: string; text: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const match = line.match(/^(.*):(\d+:.*)$/);
    if (!match) continue;
    out.push({ filePart: match[1], text: match[2] });
  }
  return out;
}

/**
 * grep-backed search_files implementation shared by the adapter and its tests.
 *
 * Flags are deliberate:
 * - `-r` (not `-R`): do not follow directory symlinks that escape the workspace.
 * - `-H`: always print the file name, even when the operand is a single file.
 * - `--null` when the host grep supports it (GNU). BSD/macOS falls back to
 *   parsing `path:line:text` from `-rInH` so colon-containing names still work
 *   via the last `:\d+:` split.
 * - `--exclude-dir=node_modules`: prune dependency trees at any depth.
 */
export function searchFiles(
  cwd: string,
  relPath: string,
  pattern: string,
  maxResults: number,
  guard: WorkspaceGuard,
  timeoutMs: number,
): SearchFilesResult {
  const useNull = grepSupportsNullDelimiter();
  const args = useNull
    ? ["-rInH", "--null", "--exclude-dir=.git", "--exclude-dir=node_modules", "--", pattern, relPath]
    : ["-rInH", "--exclude-dir=.git", "--exclude-dir=node_modules", "--", pattern, relPath];
  const result = spawnSync("grep", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const stdout = String(result.stdout || "");
  const records = useNull ? parseNulRecords(stdout) : parseColonRecords(stdout);
  const matches: string[] = [];
  for (const rec of records) {
    try {
      guard.assertPath(rec.filePart, false);
    } catch {
      continue;
    }
    matches.push(`${rec.filePart}:${rec.text}`);
  }
  return {
    ok: result.status === 0 || result.status === 1,
    status: result.status,
    matches: matches.slice(0, maxResults),
    truncated: matches.length > maxResults,
    stderr: result.stderr || "",
  };
}
