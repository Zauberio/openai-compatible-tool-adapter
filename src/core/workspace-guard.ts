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
    // git apply --numstat emits ONLY the new name for rename/copy records,
    // so the SOURCE path is never validated against the allowlist - a rename
    // could silently delete/overwrite an unlisted file. Parse the patch text
    // for rename/copy sources and check them too.
    for (const src of this.parseRenameSources(patch)) {
      this.assertPath(src, true);
    }
    // Symlink creation in the same patch (mode 120000): the numstat scan
    // cannot see through a symlink that does not exist yet, so write-through
    // protection rests on git's own symlink guard (CVE-2022-39253 fix,
    // git >= 2.30.5/2.38.1). Reject symlinks whose target escapes the
    // workspace regardless of git version.
    for (const target of this.parseSymlinkTargets(patch)) {
      this.assertSymlinkTarget(target);
    }
    return paths;
  }

  // "new file mode 120000" + following "+<target>" line: the symlink target.
  parseSymlinkTargets(patch: string): string[] {
    const targets: string[] = [];
    const re = /^new file mode 120000\s*\n(?:index [0-9a-f.]+\s*\n)?--- .*\n\+\+\+ .*\n@@ .*\n\+([^\n]+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(patch)) !== null) {
      const target = m[1].trim();
      if (target) targets.push(target);
    }
    return targets;
  }

  assertSymlinkTarget(target: string): void {
    if (!target) return;
    // The target need not exist yet (symlink to a to-be-created file), so
    // realpath-based assertPath would reject legit in-workspace targets.
    // Use lexical containment for the target path.
    const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(this.cwd, target);
    const rel = path.relative(this.cwd, resolved).replace(/\\/g, "/");
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
      throw new Error(`symlink target escapes cwd: ${target}`);
    }
  }

  // "rename from <path>" / "copy from <path>" lines carry the pre-image path
  // that numstat hides for rename/copy records.
  parseRenameSources(patch: string): string[] {
    const sources: string[] = [];
    const re = /^\s*(?:rename|copy)\s+from\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(patch)) !== null) {
      const src = m[1].trim();
      if (src && src !== "/dev/null") sources.push(src);
    }
    return sources;
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
