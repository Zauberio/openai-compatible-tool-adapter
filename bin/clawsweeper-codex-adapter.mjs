#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const adapter = path.join(root, "dist", "bin", "openai-compatible-tool-adapter.js");

const env = { ...process.env };
env.OPENAI_COMPATIBLE_ADAPTER_RECIPE ||= "clawsweeper";
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_ADAPTER_BASE_URL");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL", "OPENAI_COMPATIBLE_ADAPTER_MODEL");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV", "OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS", "OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS", "OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_RETRIES", "OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_READ_LIMIT", "OPENAI_COMPATIBLE_ADAPTER_READ_LIMIT");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_COMMAND_TIMEOUT_MS", "OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS", "OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_COMMAND_OUTPUT_LIMIT", "OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_DIFF_OUTPUT_LIMIT", "OPENAI_COMPATIBLE_ADAPTER_DIFF_OUTPUT_LIMIT");
copy("CLAWSWEEPER_OPENAI_COMPATIBLE_ALLOWED_FILES", "OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES");
copy("CLAWSWEEPER_REPAIR_EVIDENCE_PACK", "OPENAI_COMPATIBLE_ADAPTER_CLAWSWEEPER_EVIDENCE_PACK");
copy("CLAWSWEEPER_REPAIR_EVIDENCE_PACK_MAX_HUNKS", "OPENAI_COMPATIBLE_ADAPTER_EVIDENCE_PACK_MAX_HUNKS");
copy("CLAWSWEEPER_REPAIR_EVIDENCE_PACK_MAX_HUNK_BYTES", "OPENAI_COMPATIBLE_ADAPTER_EVIDENCE_PACK_MAX_HUNK_BYTES");

const token = env.GH_TOKEN || env.GITHUB_TOKEN;
if (token) {
  env.GH_TOKEN ||= token;
  env.GITHUB_TOKEN ||= token;
  env.CLAWSWEEPER_INVENTORY_TOKEN ||= token;
  env.CLAWSWEEPER_DISPATCH_TOKEN ||= token;
}

const result = spawnSync(process.execPath, [adapter, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message || String(result.error));
  process.exit(1);
}
if (result.signal) {
  console.error(`clawsweeper codex adapter terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 0);

function copy(from, to) {
  if (!env[to] && env[from]) env[to] = env[from];
}
