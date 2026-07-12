import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type GuardedPath = { rel: string; abs: string };

export class WorkspaceGuard {
  readonly cwd: string;
  readonly cwdReal: string;
  readonly allowedFiles: string[];

  constructor(cwd: string, allowedFiles: string[] = []) {
    this.cwd = path.resolve(cwd);
    this.cwdReal = fs.realpathSync(this.cwd);
    this.allowedFiles = allowedFiles.map((entry) => path.normalize(entry));
  }

  assertPath(input: unknown, write: boolean): GuardedPath {
    const raw = String(input ?? "");
    if (!raw || raw.includes("\0")) throw new Error("missing or invalid repository path");

    const abs = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(this.cwd, path.normalize(raw.replace(/^\/+/, "")));
    this.assertInside(this.cwd, abs, `path outside cwd: ${raw}`);

    const rel = path.relative(this.cwd, abs) || ".";
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`invalid repository path: ${raw}`);
    }

    const realTarget = this.resolveRealTarget(abs, write);
    this.assertInside(this.cwdReal, realTarget, `path escapes cwd through symlink: ${raw}`);

    if (write && this.allowedFiles.length > 0 && !this.allowedFiles.includes(rel)) {
      throw new Error(`write denied for ${rel}; allowed: ${this.allowedFiles.join(", ")}`);
    }
    return { rel, abs };
  }

  assertPatch(patch: string): string[] {
    const scan = spawnSync("git", ["apply", "--numstat", "-z", "-"], {
      cwd: this.cwd,
      input: patch,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    if (scan.status !== 0) {
      throw new Error(`invalid patch: ${String(scan.stderr || scan.stdout).trim()}`);
    }

    const paths = parseNumstatPaths(String(scan.stdout || ""));
    if (paths.length === 0) throw new Error("patch does not touch any repository files");
    for (const file of paths) this.assertPath(file, true);
    return paths;
  }

  private resolveRealTarget(abs: string, write: boolean): string {
    if (fs.existsSync(abs)) return fs.realpathSync(abs);
    if (!write) return fs.realpathSync(abs);

    let existing = path.dirname(abs);
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`no existing parent for ${abs}`);
      existing = parent;
    }
    const realParent = fs.realpathSync(existing);
    return path.resolve(realParent, path.relative(existing, abs));
  }

  private assertInside(root: string, candidate: string, message: string): void {
    if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new Error(message);
  }
}

function parseNumstatPaths(output: string): string[] {
  const found = new Set<string>();
  for (const chunk of output.split("\0")) {
    if (!chunk) continue;
    const fields = chunk.split("\t");
    const candidate = fields.length >= 3 ? fields.slice(2).join("\t") : chunk;
    if (candidate && candidate !== "/dev/null") found.add(candidate);
  }
  return [...found];
}
