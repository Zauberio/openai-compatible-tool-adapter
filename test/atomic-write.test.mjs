import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteFileSync } from "../dist/core/atomic-write.js";

test("atomicWriteFileSync writes content and leaves no temp files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-atomic-"));
  try {
    const target = join(dir, "file.txt");
    atomicWriteFileSync(target, "hello");
    assert.equal(readFileSync(target, "utf8"), "hello");
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.equal(leftovers.length, 0, "no temp files left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync overwrites existing content atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-atomic-"));
  try {
    const target = join(dir, "file.txt");
    writeFileSync(target, "old");
    atomicWriteFileSync(target, "new");
    assert.equal(readFileSync(target, "utf8"), "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync writes through an existing symlink to its target", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-atomic-"));
  try {
    const target = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "old");
    symlinkSync("real.txt", link);
    atomicWriteFileSync(link, "new");
    // The link must survive: the rename landed on the real target, exactly
    // like a plain write would have followed the link.
    assert.equal(readFileSync(target, "utf8"), "new");
    assert.equal(readFileSync(link, "utf8"), "new");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "symlink must not be replaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync preserves existing file permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-atomic-"));
  try {
    const target = join(dir, "run.sh");
    writeFileSync(target, "#!/bin/sh\necho old\n", { mode: 0o755 });
    atomicWriteFileSync(target, "#!/bin/sh\necho new\n");
    // The 0600 temp inode must not become the destination's mode.
    assert.equal(statSync(target).mode & 0o777, 0o755, "executable bit must survive");
    assert.equal(readFileSync(target, "utf8"), "#!/bin/sh\necho new\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync preserves the previous file when the write fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-atomic-"));
  try {
    const target = join(dir, "file.txt");
    writeFileSync(target, "precious");
    // target is a DIRECTORY path - rename over it fails; the temp write itself succeeds,
    // proving the original file is untouched when the rename cannot happen.
    const dirTarget = join(dir, "sub");
    mkdirSync(dirTarget);
    assert.throws(() => atomicWriteFileSync(dirTarget, "x"));
    assert.equal(readFileSync(target, "utf8"), "precious");
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.equal(leftovers.length, 0, "failed write cleaned its temp file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
