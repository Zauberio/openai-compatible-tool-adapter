import { spawnSync } from "node:child_process";
import { WorkspaceGuard } from "./workspace-guard.js";

export type SearchFilesResult = {
  ok: boolean;
  status: number | null;
  matches: string[];
  truncated: boolean;
  stderr: string;
};

/**
 * grep-backed search_files implementation shared by the adapter and its tests.
 *
 * Flags are deliberate:
 * - `-r` (not `-R`): do not follow directory symlinks that escape the workspace.
 *   GNU grep -r is --no-dereference; -R follows dir links and can leak /etc etc.
 * - `-H`: always print the file name, even when the operand is a single file,
 *   so a lone `line:text` can never be mistaken for a path.
 * - `-Z`: terminate the file name with a NUL byte, so paths containing ':'
 *   (and match text containing 'line:' lookalikes) parse unambiguously.
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
  const result = spawnSync(
    "grep",
    ["-rInHZ", "--exclude-dir=.git", "--exclude-dir=node_modules", "--", pattern, relPath],
    { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
  );
  // -Z output is "<path>\0<lineno>:<text>\n" per match: the path is
  // NUL-terminated (unambiguous even when it contains ':'), and the match
  // text is one line terminated by '\n'. Scan records sequentially so a
  // colon inside a path never truncates it.
  const stdout = String(result.stdout || "");
  const matches: string[] = [];
  let offset = 0;
  while (offset < stdout.length) {
    const nul = stdout.indexOf("\0", offset);
    if (nul === -1) break;
    const filePart = stdout.slice(offset, nul);
    offset = nul + 1;
    const nl = stdout.indexOf("\n", offset);
    const text = nl === -1 ? stdout.slice(offset) : stdout.slice(offset, nl);
    offset = nl === -1 ? stdout.length : nl + 1;
    if (!filePart) continue;
    try {
      // Post-filter: drop any match whose file path fails WorkspaceGuard
      // (defense in depth if a platform grep still follows links).
      guard.assertPath(filePart, false);
    } catch {
      continue;
    }
    matches.push(`${filePart}:${text}`);
  }
  return {
    ok: result.status === 0 || result.status === 1,
    status: result.status,
    matches: matches.slice(0, maxResults),
    truncated: matches.length >= maxResults,
    stderr: result.stderr || "",
  };
}
