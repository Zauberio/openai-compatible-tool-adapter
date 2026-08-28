import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_SYMLINK_EXPANSIONS = 256;

export type GuardedPath = { rel: string; abs: string };

export class WorkspaceGuard {
  readonly cwd: string;
  readonly cwdReal: string;
  readonly allowedFiles: string[];

  constructor(cwd: string, allowedFiles: string[] = []) {
    this.cwd = path.resolve(cwd);
    // Validate up front: a nonexistent --cd produced a raw fs ENOENT stack,
    // and a regular FILE passed (realpathSync succeeds) only to fail later
    // in every tool. Fail fast with a clear message.
    if (!fs.existsSync(this.cwd)) {
      throw new Error(`--cd target does not exist: ${this.cwd}`);
    }
    if (!fs.statSync(this.cwd).isDirectory()) {
      throw new Error(`--cd target is not a directory: ${this.cwd}`);
    }
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
    // Symlink creation or retarget (mode 120000): the numstat scan cannot
    // see through a symlink that does not exist yet, so write-through
    // protection rests on git's own symlink guard (CVE-2022-39253 fix,
    // git >= 2.30.5/2.38.1). Reject symlink targets that escape the
    // workspace regardless of git version.
    for (const { link, target } of this.parseSymlinkTargets(patch)) {
      this.assertSymlinkTarget(target, link);
    }
    return paths;
  }

  // Git-valid symlink forms: "new file mode 120000", "new mode 120000",
  // and "index <old>..<new> 120000" (retarget of an existing symlink).
  parseSymlinkTargets(patch: string): { link: string; target: string }[] {
    const found: { link: string; target: string }[] = [];
    const lines = patch.split("\n");
    let newMode: string | undefined;
    let indexMode: string | undefined;
    let newPath = "";
    let added: string[] = [];
    let inHunk = false;
    let binaryPatch = false;

    const flush = () => {
      const mode = newMode ?? indexMode;
      if (mode === "120000" && newPath && binaryPatch) {
        throw new Error(`binary symlink patch is not supported: ${newPath}`);
      }
      if (mode === "120000" && newPath && added.length > 0) {
        found.push({ link: newPath, target: added.join("\n") });
      }
      newMode = undefined;
      indexMode = undefined;
      newPath = "";
      added = [];
      inHunk = false;
      binaryPatch = false;
    };

    for (const raw of lines) {
      const line = stripCr(raw);
      if (line.startsWith("diff --git ")) {
        flush();
        newPath = parseDiffGitNewPath(line);
        continue;
      }
      if (inHunk) {
        if (line.startsWith("@@ ")) continue;
        if (line.startsWith("+")) {
          added.push(line.slice(1));
          continue;
        }
        if (line.startsWith("\\") || line.startsWith("-") || line.startsWith(" ") || line === "") {
          continue;
        }
        inHunk = false;
      }
      const newFileMode = /^new file mode ([0-7]+)$/.exec(line);
      if (newFileMode) {
        newMode = newFileMode[1];
        continue;
      }
      const newModeMatch = /^new mode ([0-7]+)$/.exec(line);
      if (newModeMatch) {
        newMode = newModeMatch[1];
        continue;
      }
      const indexMatch = /^index [0-9a-fA-F.]+\s+([0-7]+)$/.exec(line);
      if (indexMatch) {
        indexMode = indexMatch[1];
        continue;
      }
      if (line === "GIT binary patch") {
        binaryPatch = true;
        continue;
      }
      if (line.startsWith("rename to ")) {
        newPath = decodeGitPath(line.slice("rename to ".length));
        continue;
      }
      if (line.startsWith("copy to ")) {
        newPath = decodeGitPath(line.slice("copy to ".length));
        continue;
      }
      if (line.startsWith("+++ ")) {
        const parsed = parseUnifiedPath(line.slice(4));
        if (parsed) newPath = parsed;
        continue;
      }
      if (line.startsWith("@@ ")) inHunk = true;
    }
    flush();
    return found;
  }

  assertSymlinkTarget(target: string, linkPath = ""): void {
    if (!target) return;
    // Resolve relative targets from the link's directory (POSIX link
    // semantics). The final path need not exist yet, so walk existing
    // prefixes — including symlink components — instead of requiring
    // realpath of the whole target.
    const linkAbs = linkPath ? path.resolve(this.cwd, linkPath) : this.cwd;
    if (linkPath) {
      const linkRel = path.relative(this.cwd, linkAbs).replace(/\\/g, "/");
      if (linkRel === ".." || linkRel.startsWith("../") || path.isAbsolute(linkRel)) {
        throw new Error(`symlink path outside cwd: ${linkPath}`);
      }
    }
    const linkDir = linkPath ? path.dirname(linkAbs) : this.cwd;
    const lexicalTarget = path.isAbsolute(target) ? path.normalize(target) : path.resolve(linkDir, target);
    const rel = path.relative(this.cwd, lexicalTarget).replace(/\\/g, "/");
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
      throw new Error(`symlink target escapes cwd: ${target}`);
    }
    const realLinkDir = this.resolveExistingPrefix(linkDir);
    const realTarget = this.resolveSymlinkTargetComponents(realLinkDir, target);
    this.assertInside(this.cwdReal, realTarget, `symlink target escapes cwd: ${target}`);
  }

  private resolveSymlinkTargetComponents(baseDir: string, target: string): string {
    const absoluteTarget = path.isAbsolute(target);
    let resolved = absoluteTarget ? path.parse(target).root : baseDir;
    let pending = splitRawPathComponents(
      absoluteTarget ? target.slice(path.parse(target).root.length) : target,
    );
    const seenStates = new Set<string>();
    let symlinkHops = 0;

    while (pending.length > 0) {
      const component = pending.shift()!;
      if (!component || component === ".") continue;
      if (component === "..") {
        resolved = path.dirname(resolved);
        continue;
      }

      const candidate = path.join(resolved, component);
      const stat = lstatIfPresent(candidate);
      if (!stat || !stat.isSymbolicLink()) {
        resolved = candidate;
        continue;
      }

      if (++symlinkHops > MAX_SYMLINK_EXPANSIONS) {
        throw new Error("symlink cycle or excessive indirection");
      }

      const state = `${path.normalize(candidate)}\u0000${pending.join("\u0000")}`;
      if (seenStates.has(state)) {
        throw new Error(`symlink cycle while resolving ${target}`);
      }
      seenStates.add(state);

      const dest = fs.readlinkSync(candidate);
      if (path.isAbsolute(dest)) {
        const destRoot = path.parse(dest).root;
        resolved = destRoot;
        pending = [
          ...splitRawPathComponents(dest.slice(destRoot.length)),
          ...pending,
        ];
      } else {
        resolved = path.dirname(candidate);
        pending = [...splitRawPathComponents(dest), ...pending];
      }
    }

    return path.normalize(resolved);
  }

  // "rename from <path>" / "copy from <path>" lines carry the pre-image path
  // that numstat hides for rename/copy records. Keep trailing spaces and
  // decode C-quoted Git pathnames so allowlist checks see the real source.
  parseRenameSources(patch: string): string[] {
    const sources: string[] = [];
    const re = /^(?:rename|copy) from (.*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(patch)) !== null) {
      const src = decodeGitPath(m[1]);
      if (src && src !== "/dev/null") sources.push(src);
    }
    return sources;
  }

  private resolveRealTarget(abs: string, write: boolean): string {
    if (fs.existsSync(abs)) return fs.realpathSync(abs);
    if (!write) return fs.realpathSync(abs);
    return this.resolveExistingPrefix(abs);
  }

  // Follow existing symlink prefixes without requiring the final path to exist.
  // Resolve one component at a time and preserve relative symlink destinations
  // verbatim: applying `..` before following an intermediate symlink changes
  // POSIX path semantics and can hide an escape.
  private resolveExistingPrefix(abs: string): string {
    const absolute = path.resolve(abs);
    const root = path.parse(absolute).root;
    let resolved = root;
    let pending = splitRawPathComponents(absolute.slice(root.length));
    const seenStates = new Set<string>();
    let symlinkHops = 0;

    while (pending.length > 0) {
      const component = pending.shift()!;
      if (!component || component === ".") continue;
      if (component === "..") {
        resolved = path.dirname(resolved);
        continue;
      }

      const candidate = path.join(resolved, component);
      const stat = lstatIfPresent(candidate);
      if (!stat) {
        return path.resolve(resolved, component, ...pending);
      }
      if (!stat.isSymbolicLink()) {
        resolved = candidate;
        continue;
      }

      if (++symlinkHops > MAX_SYMLINK_EXPANSIONS) {
        throw new Error("symlink cycle or excessive indirection");
      }

      const state = `${path.normalize(candidate)}\u0000${pending.join("\u0000")}`;
      if (seenStates.has(state)) {
        throw new Error(`symlink cycle while resolving ${abs}`);
      }
      seenStates.add(state);

      const dest = fs.readlinkSync(candidate);
      if (path.isAbsolute(dest)) {
        const destRoot = path.parse(dest).root;
        resolved = destRoot;
        pending = [
          ...splitRawPathComponents(dest.slice(destRoot.length)),
          ...pending,
        ];
      } else {
        resolved = path.dirname(candidate);
        pending = [...splitRawPathComponents(dest), ...pending];
      }
    }

    return path.normalize(resolved);
  }

  private assertInside(root: string, candidate: string, message: string): void {
    if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new Error(message);
  }
}

function splitRawPathComponents(value: string): string[] {
  return process.platform === "win32" ? value.split(/[\\/]+/) : value.split(/\/+/);
}

function lstatIfPresent(candidate: string) {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function decodeGitPath(raw: string): string {
  const value = stripCr(raw);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unquoteCStyle(value.slice(1, -1));
  }
  return value;
}

function unquoteCStyle(inner: string): string {
  const chunks: Buffer[] = [];
  const escapedBytes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    "\\": 0x5c,
  };

  for (let i = 0; i < inner.length; ) {
    if (inner[i] !== "\\") {
      const nextSlash = inner.indexOf("\\", i);
      const end = nextSlash === -1 ? inner.length : nextSlash;
      chunks.push(Buffer.from(inner.slice(i, end), "utf8"));
      i = end;
      continue;
    }

    const next = inner[i + 1];
    if (next === undefined) {
      chunks.push(Buffer.from([0x5c]));
      break;
    }
    if (next in escapedBytes) {
      chunks.push(Buffer.from([escapedBytes[next]]));
      i += 2;
      continue;
    }
    if (next >= "0" && next <= "7") {
      let oct = next;
      let j = i + 2;
      while (oct.length < 3 && j < inner.length && inner[j] >= "0" && inner[j] <= "7") {
        oct += inner[j];
        j += 1;
      }
      chunks.push(Buffer.from([parseInt(oct, 8)]));
      i = j;
      continue;
    }
    chunks.push(Buffer.from(next, "utf8"));
    i += 2;
  }

  return Buffer.concat(chunks).toString("utf8");
}

function stripAbPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  if (p === "a" || p === "b") return "";
  return p;
}

function parseUnifiedPath(raw: string): string | null {
  let value = stripCr(raw);
  const tab = value.indexOf("\t");
  if (tab !== -1) value = value.slice(0, tab);
  if (value === "/dev/null") return null;
  return stripAbPrefix(decodeGitPath(value));
}

function parseDiffGitNewPath(line: string): string {
  const rest = stripCr(line).slice("diff --git ".length);
  if (!rest) return "";
  if (rest.startsWith('"')) {
    const end = closingQuoteIndex(rest);
    if (end === -1) return "";
    const rem = rest.slice(end + 1).replace(/^ +/, "");
    return stripAbPrefix(decodeGitPath(rem));
  }
  const quotedSecond = rest.indexOf(' "');
  if (quotedSecond !== -1) return stripAbPrefix(decodeGitPath(rest.slice(quotedSecond + 1)));
  const sep = rest.indexOf(" b/");
  if (sep !== -1) return stripAbPrefix(rest.slice(sep + 1));
  return "";
}

function closingQuoteIndex(quoted: string): number {
  for (let i = 1; i < quoted.length; i++) {
    if (quoted[i] === "\\") {
      i += 1;
      continue;
    }
    if (quoted[i] === '"') return i;
  }
  return -1;
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
