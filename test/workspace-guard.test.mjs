import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { WorkspaceGuard } from "../dist/core/workspace-guard.js";

test("rejects a nonexistent workspace root", () => {
  const missing = path.join(tmpdir(), `adapter-missing-${process.pid}-${Date.now()}`);
  assert.throws(() => new WorkspaceGuard(missing), /--cd target does not exist/);
});

test("rejects a regular file as the workspace root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-file-root-"));
  try {
    const file = path.join(root, "not-a-dir.txt");
    writeFileSync(file, "x");
    assert.throws(() => new WorkspaceGuard(file), /--cd target is not a directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a valid directory as the workspace root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-dir-root-"));
  try {
    const guard = new WorkspaceGuard(root);
    assert.equal(guard.cwd, path.resolve(root));
    writeFileSync(path.join(root, "ok.txt"), "ok\n");
    assert.equal(guard.assertPath("ok.txt", false).rel, "ok.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a symlink-to-directory as the workspace root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-root-"));
  const target = mkdtempSync(path.join(tmpdir(), "adapter-target-"));
  try {
    const link = path.join(root, "link");
    symlinkSync(target, link, "dir");
    const guard = new WorkspaceGuard(link);
    assert.ok(guard.cwdReal.startsWith(realpathSync(target)));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("preserves dot-dot ordering inside existing symlink prefixes for direct writes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-prefix-dotdot-"));
  const outside = mkdtempSync(path.join(tmpdir(), "adapter-prefix-dotdot-out-"));
  try {
    mkdirSync(path.join(outside, "nested"));
    symlinkSync(outside, path.join(root, "escape"), "dir");
    symlinkSync("escape/..", path.join(root, "a"), "dir");
    const guard = new WorkspaceGuard(root);
    assert.throws(
      () => guard.assertPath("a/new.txt", true),
      /path escapes cwd through symlink/,
    );
    assert.equal(existsSync(path.join(root, "a", "new.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects read and write paths that escape through symlinks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "adapter-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, path.join(root, "escape"), "dir");
    const guard = new WorkspaceGuard(root);
    assert.throws(() => guard.assertPath("escape/secret.txt", false), /symlink/);
    assert.throws(() => guard.assertPath("escape/new.txt", true), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("enforces allowed files for every path in apply_patch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-patch-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Test"]);
    writeFileSync(path.join(root, "allowed.txt"), "old\n");
    writeFileSync(path.join(root, "denied.txt"), "old\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);

    const guard = new WorkspaceGuard(root, ["allowed.txt"]);
    assert.deepEqual(guard.assertPatch(patchFor("allowed.txt")), ["allowed.txt"]);
    assert.throws(
      () => guard.assertPatch(`${patchFor("allowed.txt")}\n${patchFor("denied.txt")}`),
      /write denied for denied\.txt/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unlisted rename and copy sources in apply_patch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-rename-"));
  try {
    initGit(root);
    writeFileSync(path.join(root, "allowed.txt"), "ok\n");
    writeFileSync(path.join(root, "unlisted.txt"), "secret\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);

    const guard = new WorkspaceGuard(root, ["allowed.txt", "renamed.txt", "copied.txt"]);
    git(root, ["mv", "unlisted.txt", "renamed.txt"]);
    const renamePatch = git(root, ["diff", "--cached"]).stdout;
    git(root, ["reset", "--hard", "-q"]);
    assert.throws(() => guard.assertPatch(renamePatch), /write denied for unlisted\.txt/);

    const copyPatch =
      "diff --git a/unlisted.txt b/copied.txt\nsimilarity index 100%\ncopy from unlisted.txt\ncopy to copied.txt\n";
    assert.throws(() => guard.assertPatch(copyPatch), /write denied for unlisted\.txt/);

    const listed = new WorkspaceGuard(root, ["allowed.txt", "renamed.txt"]);
    git(root, ["mv", "allowed.txt", "renamed.txt"]);
    const okRename = git(root, ["diff", "--cached"]).stdout;
    git(root, ["reset", "--hard", "-q"]);
    assert.deepEqual(listed.assertPatch(okRename), ["renamed.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects similarity-only symlink relocation that escapes at the destination", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-symlink-relocate-"));
  try {
    initGit(root);
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    mkdirSync(path.join(root, "inside"));
    writeFileSync(path.join(root, "inside", "secret.txt"), "secret\n");
    symlinkSync("../../inside", path.join(root, "a", "b", "link"));
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);

    git(root, ["mv", "a/b/link", "link"]);
    const patch = git(root, ["diff", "--cached", "--find-renames"]).stdout;
    git(root, ["reset", "--hard", "-q"]);

    assert.match(patch, /similarity index 100%/);
    assert.match(patch, /rename from a\/b\/link/);
    const guard = new WorkspaceGuard(root);
    assert.throws(() => guard.assertPatch(patch), /symlink target escapes cwd/);
    assert.equal(existsSync(path.join(root, "a", "b", "link")), true);
    assert.equal(existsSync(path.join(root, "link")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves trailing spaces and decodes C-quoted rename sources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-quote-"));
  try {
    initGit(root);
    writeFileSync(path.join(root, "file"), "plain\n");
    writeFileSync(path.join(root, "file "), "spaced\n");
    writeFileSync(path.join(root, "tab\tname"), "tabbed\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    const guard = new WorkspaceGuard(root);

    git(root, ["mv", "file ", "renamed-space"]);
    const spacePatch = git(root, ["diff", "--cached"]).stdout;
    git(root, ["reset", "--hard", "-q"]);
    assert.deepEqual(guard.parseRenameSources(spacePatch), ["file "]);
    const denySpace = new WorkspaceGuard(root, ["file", "renamed-space"]);
    assert.throws(() => denySpace.assertPatch(spacePatch), /write denied for file /);
    const allowSpace = new WorkspaceGuard(root, ["file ", "renamed-space"]);
    assert.deepEqual(allowSpace.assertPatch(spacePatch), ["renamed-space"]);

    git(root, ["mv", "tab\tname", "renamed-tab"]);
    const tabPatch = git(root, ["diff", "--cached"]).stdout;
    git(root, ["reset", "--hard", "-q"]);
    assert.deepEqual(guard.parseRenameSources(tabPatch), ["tab\tname"]);
    const denyTab = new WorkspaceGuard(root, ["renamed-tab"]);
    assert.throws(() => denyTab.assertPatch(tabPatch), /write denied for tab\tname/);

    const quotedEscape =
      'diff --git "a/../secret" "b/innocent.txt"\nsimilarity index 100%\nrename from "../secret"\nrename to innocent.txt\n';
    assert.deepEqual(guard.parseRenameSources(quotedEscape), ["../secret"]);
    assert.throws(() => guard.assertPatch(quotedEscape), /path outside cwd|\.\.\/secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects escaping targets on symlink creation and mode-change patches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-symlink-mode-"));
  try {
    initGit(root);
    writeFileSync(path.join(root, "regular.txt"), "base\n");
    symlinkSync("oldtarget", path.join(root, "existinglink"));
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    const guard = new WorkspaceGuard(root);

    const created = symlinkPatch("escape", "../../outside");
    assert.deepEqual(guard.parseSymlinkTargets(created), [{ link: "escape", target: "../../outside" }]);
    assert.throws(() => guard.assertPatch(created), /symlink target escapes cwd/);

    fsUnlinkAndRetarget(root, "existinglink", "../../outside");
    const retarget = git(root, ["diff"]).stdout;
    git(root, ["checkout", "-q", "--", "existinglink"]);
    assert.equal(guard.parseSymlinkTargets(retarget).length, 1);
    assert.equal(guard.parseSymlinkTargets(retarget)[0].link, "existinglink");
    assert.match(guard.parseSymlinkTargets(retarget)[0].target, /\.\.\/\.\.\/outside/);
    assert.doesNotMatch(retarget, /new file mode 120000/);
    assert.match(retarget, /index [0-9a-f.]+ 120000/);
    assert.throws(() => guard.assertPatch(retarget), /symlink target escapes cwd/);

    const modeChange =
      "diff --git a/regular.txt b/regular.txt\nold mode 100644\nnew mode 120000\n--- a/regular.txt\n+++ b/regular.txt\n@@ -1 +1 @@\n-base\n+../../outside\n";
    assert.deepEqual(guard.parseSymlinkTargets(modeChange), [
      { link: "regular.txt", target: "../../outside" },
    ]);
    assert.throws(() => guard.assertPatch(modeChange), /symlink target escapes cwd/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves nested relative symlink targets from the link location", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-nested-link-"));
  try {
    initGit(root);
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "inside.txt"), "ok\n");
    writeFileSync(path.join(root, "sub", "inside.txt"), "nested\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    const guard = new WorkspaceGuard(root);

    const nestedOk = symlinkPatch("sub/newlink", "../inside.txt");
    assert.deepEqual(guard.parseSymlinkTargets(nestedOk), [{ link: "sub/newlink", target: "../inside.txt" }]);
    assert.deepEqual(guard.assertPatch(nestedOk), ["sub/newlink"]);

    const nestedEscape = symlinkPatch("sub/escape", "../../outside");
    assert.throws(() => guard.assertPatch(nestedEscape), /symlink target escapes cwd/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects symlink targets that escape through existing symlink components", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-link-comp-"));
  const outside = mkdtempSync(path.join(tmpdir(), "adapter-link-out-"));
  try {
    initGit(root);
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, path.join(root, "escape"), "dir");
    mkdirSync(path.join(root, "sub"));
    symlinkSync(outside, path.join(root, "sub", "escape"), "dir");
    writeFileSync(path.join(root, "keep.txt"), "keep\n");
    git(root, ["add", "-f", "keep.txt"]);
    git(root, ["commit", "-q", "-m", "base"]);
    const guard = new WorkspaceGuard(root);

    assert.throws(
      () => guard.assertPatch(symlinkPatch("link", "escape/secret.txt")),
      /symlink target escapes cwd/,
    );
    assert.throws(
      () => guard.assertPatch(symlinkPatch("sub/link", "escape/secret.txt")),
      /symlink target escapes cwd/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects binary post-images for mode-120000 symlink patches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-binary-link-"));
  try {
    initGit(root);
    writeFileSync(path.join(root, "keep.txt"), "keep\n");
    git(root, ["add", "keep.txt"]);
    git(root, ["commit", "-q", "-m", "base"]);

    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: Buffer.from([0x2e, 0x2e, 0x2f, 0x00, 0x78]),
    });
    assert.equal(blob.status, 0, String(blob.stderr));
    const hash = String(blob.stdout).trim();
    git(root, ["update-index", "--add", "--cacheinfo", `120000,${hash},binary-link`]);
    const patch = git(root, ["diff", "--cached", "--binary"]).stdout;
    git(root, ["reset", "--hard", "-q"]);

    assert.match(patch, /new file mode 120000/);
    assert.match(patch, /GIT binary patch/);
    const guard = new WorkspaceGuard(root);
    assert.throws(() => guard.assertPatch(patch), /binary symlink patch is not supported/);
    assert.equal(existsSync(path.join(root, "binary-link")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves dot-dot ordering after following an existing symlink", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-dotdot-link-"));
  const outside = mkdtempSync(path.join(tmpdir(), "adapter-dotdot-out-"));
  try {
    initGit(root);
    writeFileSync(path.join(root, "keep.txt"), "keep\n");
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    git(root, ["add", "keep.txt"]);
    git(root, ["commit", "-q", "-m", "base"]);

    symlinkSync(path.join(outside, "nested"), path.join(root, "escape"), "dir");
    const guard = new WorkspaceGuard(root);
    assert.throws(
      () => guard.assertPatch(symlinkPatch("crafted-link", "escape/../secret.txt")),
      /symlink target escapes cwd/,
    );
    assert.equal(existsSync(path.join(root, "crafted-link")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("treats backslash as a literal path character on POSIX", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-backslash-"));
  const outside = mkdtempSync(path.join(tmpdir(), "adapter-backslash-out-"));
  try {
    const name = "escape\\outside";
    symlinkSync(outside, path.join(root, name), "dir");
    const guard = new WorkspaceGuard(root);
    assert.throws(() => guard.assertPath(`${name}/new.txt`, true), /path escapes cwd through symlink/);
    assert.throws(() => guard.assertPatch(symlinkPatch("link", `${name}/secret.txt`)), /symlink target escapes cwd/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("rejects symlink escapes through chains longer than 32 hops and rejects cycles", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-link-chain-"));
  const outside = mkdtempSync(path.join(tmpdir(), "adapter-link-chain-out-"));
  try {
    initGit(root);
    writeFileSync(path.join(root, "keep.txt"), "keep\n");
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    git(root, ["add", "keep.txt"]);
    git(root, ["commit", "-q", "-m", "base"]);

    for (let i = 0; i < 40; i++) {
      symlinkSync(`chain${i + 1}`, path.join(root, `chain${i}`));
    }
    symlinkSync(outside, path.join(root, "chain40"), "dir");

    const guard = new WorkspaceGuard(root);
    assert.throws(
      () => guard.assertPatch(symlinkPatch("long-link", "chain0/secret.txt")),
      /symlink target escapes cwd/,
    );

    symlinkSync("cycle-b", path.join(root, "cycle-a"));
    symlinkSync("cycle-a", path.join(root, "cycle-b"));
    assert.throws(
      () => guard.assertPatch(symlinkPatch("cycle-link", "cycle-a/never.txt")),
      /symlink cycle/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("fails closed on expanding symlink cycles", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-expanding-cycle-"));
  try {
    symlinkSync("a/x", path.join(root, "a"));
    const guard = new WorkspaceGuard(root);
    assert.throws(() => guard.assertPath("a/file", true), /symlink cycle|excessive indirection/);
    assert.throws(() => guard.assertPatch(symlinkPatch("link", "a/file")), /symlink cycle|excessive indirection/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("decodes Git octal pathname escapes as UTF-8 bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-utf8-rename-"));
  try {
    initGit(root);
    writeFileSync(path.join(root, "café.txt"), "coffee\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);

    git(root, ["mv", "café.txt", "renamed.txt"]);
    const patch = git(root, ["diff", "--cached"]).stdout;
    git(root, ["reset", "--hard", "-q"]);

    assert.match(patch, /caf\\303\\251\.txt/);
    const guard = new WorkspaceGuard(root);
    assert.deepEqual(guard.parseRenameSources(patch), ["café.txt"]);

    const allowed = new WorkspaceGuard(root, ["café.txt", "renamed.txt"]);
    assert.deepEqual(allowed.assertPatch(patch), ["renamed.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts in-workspace symlink targets including nested relative links", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-link-ok-"));
  try {
    initGit(root);
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "inside.txt"), "ok\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    const guard = new WorkspaceGuard(root);

    assert.deepEqual(guard.assertPatch(symlinkPatch("link", "inside.txt")), ["link"]);
    assert.deepEqual(guard.assertPatch(symlinkPatch("sub/rel", "../inside.txt")), ["sub/rel"]);
    assert.deepEqual(guard.assertPatch(symlinkPatch("sub/dot", "./../inside.txt")), ["sub/dot"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function patchFor(file) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;
}

function symlinkPatch(link, target) {
  return (
    `diff --git a/${link} b/${link}\n` +
    `new file mode 120000\n` +
    `index 0000000..1111111\n` +
    `--- /dev/null\n` +
    `+++ b/${link}\n` +
    `@@ -0,0 +1 @@\n` +
    `+${target}\n`
  );
}

function initGit(cwd) {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
}

function fsUnlinkAndRetarget(root, name, target) {
  const dest = path.join(root, name);
  rmSync(dest, { force: true });
  symlinkSync(target, dest);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`);
  return result;
}
