# OpenAI-compatible tool adapter

Generic command-line adapter for running tool-using agents through OpenAI-compatible chat-completions providers.

The adapter is intentionally not tied to any single automation system. The core package provides a Codex-shaped command surface, a local tool loop, textual-tool-call normalization, schema/result normalization, and capability boundaries. Product-specific integration lives in `recipes/`.

## Why this exists

Many automation tools already know how to call a CLI such as `codex exec` with:

- a working directory;
- a stdin prompt;
- optional JSON output schema;
- optional `--output-last-message` file;
- stdout/stderr transcripts.

This project lets those tools keep that simple external-command contract while the model/provider logic lives outside the host project.

In other words: upstream projects only need an external command seam, such as an existing executable override or a small custom model command hook. They do not need to vendor OpenAI-compatible provider clients or tool-loop code.

## Current recipes

```text
recipes/clawsweeper-codex-bin/
recipes/local-ops/
```

`recipes/clawsweeper-codex-bin` documents how to connect ClawSweeper repair/review steps through ClawSweeper's supported `CODEX_BIN` executable override, without adding provider runtime code to ClawSweeper.

`recipes/local-ops` documents a generic local supervised-automation profile.

Recipes are examples and integration profiles. Runtime secrets and production config should stay outside git.

## Install from source

```bash
git clone https://github.com/<owner>/openai-compatible-tool-adapter.git
cd openai-compatible-tool-adapter
corepack pnpm install
corepack pnpm run build
```

## Provider keys and environment

Keys are not stored in this repository. Put them in your process manager, shell profile, secret store, CI secrets, systemd unit, Docker secret, or local `.env` that is not committed.

The generic adapter reads:

```bash
export OPENAI_COMPATIBLE_ADAPTER_BASE_URL="https://api.example.com/v1"
export OPENAI_COMPATIBLE_ADAPTER_MODEL="provider/model"
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV="PROVIDER_API_KEY"
export PROVIDER_API_KEY="...real secret..."
```

Optional limits:

```bash
export OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS=0
export OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS=0
export OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=3
export OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS=600000
export OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS=120000
export OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES="src/index.ts,tests/index.test.ts"
```

`OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS=0` means unlimited turns inside the adapter. Use the outer host timeout as the real budget.

GitHub access is recipe-owned. When a recipe needs GitHub, provide a normal token in the environment used to launch the adapter:

```bash
export GH_TOKEN="..."
export GITHUB_TOKEN="$GH_TOKEN"
```

Recipe wrappers may also map that same token to recipe-specific names, for example `CLAWSWEEPER_INVENTORY_TOKEN` and `CLAWSWEEPER_DISPATCH_TOKEN`. Do not hardcode tokens in recipe files.

## Codex-compatible command shape

The adapter accepts the command shape used by Codex-style hosts:

```bash
printf "Inspect this repository and return JSON." | \
  node dist/bin/openai-compatible-tool-adapter.js exec \
    --cd /path/to/repo \
    --output-last-message /tmp/adapter-result.json \
    --output-schema /path/to/schema.json \
    --json -
```

The `exec` subcommand, `--json` flag, and trailing `-` are accepted for compatibility. The prompt is read from stdin.

Currently recognized arguments include:

```text
exec
--cd <path>
--output-last-message <path>
--output-schema <path>
--json
-
```

Other Codex flags such as sandbox/model flags may be passed by hosts during migration. The adapter ignores flags it does not need unless they conflict with its command shape.

## Minimal standalone example

```bash
export OPENAI_COMPATIBLE_ADAPTER_BASE_URL="https://api.example.com/v1"
export OPENAI_COMPATIBLE_ADAPTER_MODEL="provider/model"
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV="PROVIDER_API_KEY"
export PROVIDER_API_KEY="..."

printf "Read package.json and summarize the project in JSON." | \
  node dist/bin/openai-compatible-tool-adapter.js exec \
    --cd "$PWD" \
    --output-last-message /tmp/adapter-result.json \
    --json -

cat /tmp/adapter-result.json
```

## Connecting another tool or repository

A host project should use the smallest possible external command seam. Some hosts already provide an executable override such as `CODEX_BIN`; others may need a small model command hook. For a generic hook, for example:

```bash
MODEL_COMMAND=/path/to/openai-compatible-tool-adapter/dist/bin/openai-compatible-tool-adapter.js
MODEL_COMMAND_ARGS="[\"exec\"]"
```

Then the host continues to provide:

```text
stdin prompt
--cd target checkout
--output-last-message result file
--output-schema optional schema
--json -
```

If the host already calls `codex exec`, the most compatible integration is usually a small wrapper script that translates host-specific environment names into `OPENAI_COMPATIBLE_ADAPTER_*` and then invokes this adapter.

## ClawSweeper CODEX_BIN wrapper

This repository includes:

```text
bin/clawsweeper-codex-adapter.mjs
```

Use it as ClawSweeper's `CODEX_BIN`. The wrapper maps ClawSweeper environment names to the generic adapter contract:

```text
CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL      -> OPENAI_COMPATIBLE_ADAPTER_BASE_URL
CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL         -> OPENAI_COMPATIBLE_ADAPTER_MODEL
CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV   -> OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV
CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS     -> OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS
CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS    -> OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS
```

It also preserves common GitHub token aliases when present:

```text
GH_TOKEN
GITHUB_TOKEN
CLAWSWEEPER_INVENTORY_TOKEN
CLAWSWEEPER_DISPATCH_TOKEN
```

See `recipes/clawsweeper-codex-bin/` for details.

## Tool surface

The adapter exposes a deliberately small local tool set to the model:

```text
read_file
read_file_range
write_file
replace_in_file
run_command
search_files
apply_patch
git_diff
```

Writes are limited to the target checkout. If `OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES` is set, write tools are limited to those relative paths.

## Security model

- Secrets live outside git.
- Provider credentials are passed by environment variable name, not hardcoded value.
- GitHub access is recipe-owned and should be allowlisted by the host runtime.
- The adapter never pushes, comments, labels, merges, or opens pull requests by itself.
- The host project remains responsible for choosing the working directory, sandbox posture, validation commands, and whether a later publish step is allowed.

## Repository status

This is an early public extraction of a generic OpenAI-compatible tool-loop adapter. The intended integration pattern is small upstream PRs in host projects plus recipe-owned local configuration, not provider-specific code inside every host repository.
