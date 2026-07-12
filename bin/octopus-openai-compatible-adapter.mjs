#!/usr/bin/env node

// Legacy compatibility wrapper. New integrations should invoke the generic adapter directly.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const adapter = path.join(root, "dist", "bin", "openai-compatible-tool-adapter.js");

const env = { ...process.env };

function copy(from, to) {
  if (!env[to] && env[from]) {
    env[to] = env[from];
  }
}

copy("OCTOPUS_OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_ADAPTER_BASE_URL");
copy("OCTOPUS_OPENAI_COMPATIBLE_MODEL", "OPENAI_COMPATIBLE_ADAPTER_MODEL");
copy("OCTOPUS_OPENAI_COMPATIBLE_API_KEY_ENV", "OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV");
copy("OCTOPUS_OPENAI_COMPATIBLE_MAX_TURNS", "OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS");
copy("OCTOPUS_OPENAI_COMPATIBLE_MAX_TOKENS", "OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS");
copy("OCTOPUS_OPENAI_COMPATIBLE_MAX_RETRIES", "OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES");
copy("OCTOPUS_OPENAI_COMPATIBLE_READ_LIMIT", "OPENAI_COMPATIBLE_ADAPTER_READ_LIMIT");
copy("OCTOPUS_OPENAI_COMPATIBLE_COMMAND_TIMEOUT_MS", "OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS");
copy("OCTOPUS_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS", "OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS");
copy("OCTOPUS_OPENAI_COMPATIBLE_COMMAND_OUTPUT_LIMIT", "OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT");
copy("OCTOPUS_OPENAI_COMPATIBLE_DIFF_OUTPUT_LIMIT", "OPENAI_COMPATIBLE_ADAPTER_DIFF_OUTPUT_LIMIT");
copy("OCTOPUS_OPENAI_COMPATIBLE_ALLOWED_FILES", "OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES");

const ghToken = env.GH_TOKEN || env.GITHUB_TOKEN || env.OCTOPUS_GITHUB_TOKEN;
if (ghToken) {
  env.GH_TOKEN ||= ghToken;
  env.GITHUB_TOKEN ||= ghToken;
  env.OCTOPUS_GITHUB_TOKEN ||= ghToken;
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
  console.error(`octopus openai-compatible adapter terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
