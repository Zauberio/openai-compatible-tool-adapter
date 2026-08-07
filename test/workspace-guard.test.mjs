import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { WorkspaceGuard } from "../dist/core/workspace-guard.js";

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

test("search_files must not follow directory symlinks (grep -r + guard)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "adapter-search-"));
  const outside = mkdtempSync(path.join(tmpdir(), "adapter-search-out-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "TOPSECRET_MARKER\n");
    writeFileSync(path.join(root, "inside.txt"), "safe\n");
    symlinkSync(outside, path.join(root, "escape"), "dir");

    const deref = spawnSync("grep", ["-RIn", "--exclude-dir=.git", "--", "TOPSECRET_MARKER", "."], {
      cwd: root,
      encoding: "utf8",
    });
    const noderef = spawnSync("grep", ["-rIn", "--exclude-dir=.git", "--", "TOPSECRET_MARKER", "."], {
      cwd: root,
      encoding: "utf8",
    });
    // -R would leak; -r must not.
    assert.match(String(deref.stdout || ""), /TOPSECRET_MARKER/);
    assert.equal(String(noderef.stdout || "").trim(), "");

    // Post-filter: any leaked path through escape/ must fail WorkspaceGuard.
    const guard = new WorkspaceGuard(root);
    assert.throws(() => guard.assertPath("escape/secret.txt", false), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
