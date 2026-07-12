import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const packed = run("npm", ["pack", "--json"], root);
const metadata = JSON.parse(packed.stdout)[0];
const files = metadata.files.map((entry) => entry.path);
assert.ok(files.includes("dist/bin/openai-compatible-tool-adapter.js"));
assert.ok(files.includes("bin/clawsweeper-codex-adapter.mjs"));
assert.equal(files.includes("dist/core/clawsweeper-evidence-pack.js"), false);
assert.equal(files.includes("dist/core/normalize-result.js"), false);
assert.ok(files.includes(".env.example"));
assert.ok(files.includes("examples/task-result.schema.json"));
assert.equal(files.some((file) => /(^|\/)(runtime|ops-backups)\//i.test(file)), false);
assert.equal(files.some((file) => file.includes("node_modules/")), false);

const tarball = path.join(root, metadata.filename);
const installDir = mkdtempSync(path.join(tmpdir(), "adapter-package-"));
try {
  run("npm", ["init", "-y"], installDir);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installDir);
  const pkg = JSON.parse(
    readFileSync(path.join(installDir, "node_modules", "openai-compatible-tool-adapter", "package.json"), "utf8"),
  );
  const cli = path.join(
    installDir,
    "node_modules",
    "openai-compatible-tool-adapter",
    pkg.bin["openai-compatible-tool-adapter"],
  );
  const version = run(process.execPath, [cli, "--version"], installDir);
  assert.match(version.stdout, /^0\.1\.0\s*$/);
} finally {
  rmSync(installDir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
