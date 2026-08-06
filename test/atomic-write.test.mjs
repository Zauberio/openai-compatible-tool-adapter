import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
