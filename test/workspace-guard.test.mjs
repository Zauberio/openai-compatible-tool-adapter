import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { WorkspaceGuard } from "../dist/core/workspace-guard.js";
import { searchFiles, grepSupportsNullDelimiter, parseColonRecords } from "../dist/core/search-files.js";

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

function patchFor(file) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`);
}

test("search_files (production handler) prunes node_modules and symlink escapes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-search-"));
  const outside = mkdtempSync(path.join(tmpdir(), "adapter-search-out-"));
  try {
    writeFileSync(path.join(root, "inside.txt"), "TOPSECRET_MARKER\n");
    writeFileSync(path.join(outside, "secret.txt"), "TOPSECRET_MARKER\n");
    writeFileSync(path.join(root, "odd:name.txt"), "TOPSECRET_MARKER\n");
    mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(root, "pkg", "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "TOPSECRET_MARKER\n");
    writeFileSync(path.join(root, "pkg", "node_modules", "dep", "index.js"), "TOPSECRET_MARKER\n");
    symlinkSync(outside, path.join(root, "escape"), "dir");

    const guard = new WorkspaceGuard(root);
    const result = searchFiles(root, ".", "TOPSECRET_MARKER", 200, guard, 30000);

    assert.equal(result.ok, true);
    // node_modules is pruned at any depth, and the symlink escape never leaks.
    assert.ok(!result.matches.some((m) => m.includes("node_modules")), `node_modules leaked: ${result.matches}`);
    assert.ok(!result.matches.some((m) => m.includes("escape")), `symlink escape leaked: ${result.matches}`);
    // Real matches survive, including a colon-containing file name (the
    // delimiter-safe parser must not truncate it at the first ':').
    assert.deepEqual([...result.matches].sort(), [
      "./inside.txt:1:TOPSECRET_MARKER",
      "./odd:name.txt:1:TOPSECRET_MARKER",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("search_files preserves matches for a single-file search path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-search-one-"));
  try {
    writeFileSync(path.join(root, "solo.txt"), "TOPSECRET_MARKER\n");
    const guard = new WorkspaceGuard(root);
    // grep omits the file name for a single operand unless -H is used; the
    // production handler must still return the match with its path intact.
    const result = searchFiles(root, "solo.txt", "TOPSECRET_MARKER", 200, guard, 30000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.matches, ["solo.txt:1:TOPSECRET_MARKER"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep --null support is probed without throwing", () => {
  const supported = grepSupportsNullDelimiter();
  assert.equal(typeof supported, "boolean");
  assert.equal(grepSupportsNullDelimiter(), supported);
});

test("fallback colon parse keeps match text that contains colon-digits", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-search-colon-"));
  try {
    writeFileSync(path.join(root, "safe.txt"), "value:123:MARKER\n");
    const guard = new WorkspaceGuard(root);
    const result = searchFiles(root, ".", "MARKER", 200, guard, 30000);
    assert.equal(result.ok, true);
    assert.ok(result.matches.some((m) => m.includes("safe.txt") && m.includes("value:123:MARKER")), result.matches.join("|"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseColonRecords uses the first :line: split", () => {
  const recs = parseColonRecords("safe.txt:1:value:123:MARKER\nodd:name.txt:1:TOPSECRET_MARKER\n");
  assert.deepEqual(recs, [
    { filePart: "safe.txt", text: "1:value:123:MARKER" },
    { filePart: "odd:name.txt", text: "1:TOPSECRET_MARKER" },
  ]);
});
