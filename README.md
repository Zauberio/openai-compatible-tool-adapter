# OpenAI-Compatible Tool Adapter

[![CI](https://github.com/Jhacarreiro/openai-compatible-tool-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/Jhacarreiro/openai-compatible-tool-adapter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853d.svg)](https://nodejs.org/)

OpenAI-Compatible Tool Adapter turns an OpenAI-compatible Chat Completions endpoint into a local, Codex-shaped coding-agent command.

It gives a model a bounded repository tool loop, accepts prompts through stdin, can validate the final response against JSON Schema, and is designed to fit into existing automation that already knows how to invoke `codex exec`-style commands.

> [!CAUTION]
> The adapter can execute real shell commands and intentionally passes the runtime environment to those commands. It is **not a sandbox**. Use a dedicated unprivileged account or isolated worker, expose only the credentials the task needs, and keep commit, push, merge and deployment actions in a separate controlled stage.

## Features

- OpenAI-compatible `POST /chat/completions` provider support.
- Codex-shaped CLI with stdin prompts and `--cd`, `--output-schema` and `--output-last-message`.
- Repository tools for reading, searching, editing, patching, command execution and diff inspection.
- Native tool-call support plus normalization for compatible textual tool-call formats.
- JSON Schema validation with Ajv and an automatic schema-repair turn.
- Exact allowed-file controls for direct writes and every file touched by `apply_patch`.
- Real-path validation that rejects lexical traversal and symlink escapes.
- Configurable tool-turn, request, command, output and retry limits.
- Optional custom HTTP headers and unauthenticated local-provider mode.
- A generic default recipe and an explicit ClawSweeper compatibility recipe.
- Reproducible package builds, integration tests and install-from-tarball smoke tests.

## How it works

```text
prompt on stdin
      │
      ▼
Codex-shaped CLI
      │
      ├── selected recipe: generic by default
      │
      ▼
OpenAI-compatible /chat/completions provider
      │
      ▼
local repository tool loop
      │
      ├── read / search / edit / patch / command / diff
      └── optional JSON Schema validation
      │
      ▼
final message on stdout and optional result file
```

The provider supplies model inference. The adapter supplies the local command surface, repository tools, limits and output validation.

See [docs/architecture.md](./docs/architecture.md) for the module map and trust boundaries.

## Requirements

- Node.js **20 or newer**.
- Git.
- Bash for `run_command`.
- An OpenAI-compatible Chat Completions endpoint that can return assistant messages and preferably native tool calls.
- A model capable of following repository-editing and structured-output instructions.

The file tools are cross-platform Node.js code. `run_command` currently uses `bash -lc`, so Windows users should run through WSL, Git Bash or a Linux container.

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/Jhacarreiro/openai-compatible-tool-adapter.git
cd openai-compatible-tool-adapter
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

Optionally expose the command globally from the checkout:

```bash
npm link
openai-compatible-tool-adapter --version
```

### 2. Configure a provider

Copy the example and replace the endpoint, model and secret:

```bash
cp .env.example .env
chmod 600 .env
```

The adapter does not load `.env` automatically. Load it into the current shell:

```bash
set -a
. ./.env
set +a
```

Minimal environment:

```bash
export OPENAI_COMPATIBLE_ADAPTER_BASE_URL="https://api.example.com/v1"
export OPENAI_COMPATIBLE_ADAPTER_MODEL="provider/model"
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV="PROVIDER_API_KEY"
export PROVIDER_API_KEY="replace-with-your-secret"
```

For a local endpoint that does not require authentication:

```bash
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL=1
```

### 3. Run a first read-only task

From this repository:

```bash
printf '%s\n' \
  'Inspect package.json and README.md. Summarize the project without modifying files.' | \
  openai-compatible-tool-adapter exec \
    --cd "$PWD" \
    --json -
```

Without `npm link`, call the built file directly:

```bash
node dist/bin/openai-compatible-tool-adapter.js --help
```

### 4. Request structured output

A sample schema is included in `examples/task-result.schema.json`:

```bash
printf '%s\n' \
  'Inspect the project and return a concise structured assessment. Do not modify files.' | \
  openai-compatible-tool-adapter exec \
    --cd "$PWD" \
    --output-schema "$PWD/examples/task-result.schema.json" \
    --output-last-message /tmp/adapter-result.json \
    --json -

cat /tmp/adapter-result.json
```

The adapter validates the final JSON with Ajv. If the first answer is invalid, it can make one repair request before returning a schema failure.

## Configuration

### Provider variables

| Variable | Default | Purpose |
|---|---:|---|
| `OPENAI_COMPATIBLE_ADAPTER_BASE_URL` | required | Provider base URL, normally ending in `/v1`. |
| `OPENAI_COMPATIBLE_ADAPTER_MODEL` | required | Model identifier sent in the Chat Completions request. |
| `OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV` | `OPENAI_API_KEY` | Name of the environment variable containing the provider API key. |
| `OPENAI_COMPATIBLE_ADAPTER_API_KEY_OPTIONAL` | `false` | Allows a provider request without an Authorization header. Useful for trusted local endpoints. |
| `OPENAI_COMPATIBLE_ADAPTER_HEADERS_JSON` | `{}` | Additional HTTP headers as a JSON object. |
| `OPENAI_COMPATIBLE_ADAPTER_RECIPE` | `generic` | Named recipe to load. Wrappers normally set this automatically. |

Example additional headers:

```bash
export OPENAI_COMPATIBLE_ADAPTER_HEADERS_JSON='{"X-Project":"example"}'
```

### Execution and output limits

| Variable | Default | Purpose |
|---|---:|---|
| `OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS` | `20` | Maximum model/tool-loop turns. Set `0` explicitly for unlimited turns. |
| `OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS` | `0` | Provider output-token limit. `0` omits the limit and leaves it to the provider. |
| `OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES` | `3` | Provider request attempts for transient failures. |
| `OPENAI_COMPATIBLE_ADAPTER_MAX_PROMPT_BYTES` | `2097152` | Maximum bytes read from stdin for the prompt. Prompts exceeding it abort with an error. Previously stdin was unbounded; raise explicitly if you feed larger prompts. |
| `OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS` | `600000` | Timeout for one provider request. |
| `OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS` | `120000` | Maximum duration of one `run_command` call. |
| `OPENAI_COMPATIBLE_ADAPTER_READ_LIMIT` | `200000` | Maximum characters returned by a file read. |
| `OPENAI_COMPATIBLE_ADAPTER_READ_LINES` | `1000` | Maximum lines returned by one ranged file read. |
| `OPENAI_COMPATIBLE_ADAPTER_COMMAND_OUTPUT_LIMIT` | `200000` | Maximum returned command output. |
| `OPENAI_COMPATIBLE_ADAPTER_DIFF_OUTPUT_LIMIT` | `200000` | Maximum returned Git diff output. |
| `OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES` | unset | Comma-separated exact relative paths allowed for direct writes and patches. |

Prompts larger than the cap now fail at startup with the message `stdin prompt exceeds OPENAI_COMPATIBLE_ADAPTER_MAX_PROMPT_BYTES`.

Example write allowlist:

```bash
export OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES="src/index.ts,test/index.test.ts"
```

This allowlist applies to `write_file`, `replace_in_file` and every path detected in `apply_patch`. It does **not** restrict `run_command`.

See [docs/provider-compatibility.md](./docs/provider-compatibility.md) for endpoint requirements and compatibility diagnostics.

## Command line

```text
openai-compatible-tool-adapter exec [options] -
```

| Argument | Purpose |
|---|---|
| `exec` | Starts the model/tool loop. |
| `--cd <path>` | Target repository checkout. Defaults to the current directory. |
| `--output-last-message <path>` | Writes the final assistant message to a file. |
| `--output-schema <path>` | Validates the final JSON against this schema. |
| `--json` | Accepted for Codex command-shape compatibility. |
| `-` | Reads the prompt from stdin. |
| `--help`, `-h` | Shows CLI help. |
| `--version`, `-V` | Shows the package version. |

Unknown migration flags are ignored when they do not conflict with the supported command shape.

## Tool surface

| Tool | Capability | Allowed-file control |
|---|---|---:|
| `read_file` | Read a complete text file within the checkout. | No |
| `read_file_range` | Read a bounded line range. | No |
| `search_files` | Search repository files. | No |
| `write_file` | Create or replace a complete file. | Yes |
| `replace_in_file` | Apply a targeted text replacement. | Yes |
| `apply_patch` | Apply a unified Git patch after pre-scanning every target path. | Yes |
| `run_command` | Execute `bash -lc` in the checkout. | **No** |
| `git_diff` | Inspect the current Git diff. | No |

All path-based tools resolve real filesystem paths and reject paths or symlinks that escape the selected checkout.

## Recipes

Recipes add host-specific prompt preparation or result normalization without changing the generic core.

### Generic

The default recipe passes the task through unchanged and supplies general repository-agent instructions:

```bash
export OPENAI_COMPATIBLE_ADAPTER_RECIPE=generic
```

### ClawSweeper

The packaged `clawsweeper-codex-adapter` wrapper selects the ClawSweeper recipe and translates its environment-variable names:

```bash
export CODEX_BIN="$(command -v clawsweeper-codex-adapter)"
```

The recipe preserves repair-specific evidence preparation and result normalization while the core remains provider- and host-neutral.

See [recipes/clawsweeper-codex-bin/README.md](./recipes/clawsweeper-codex-bin/README.md).

### Local supervised automation

A small generic deployment profile is documented in [recipes/local-ops/README.md](./recipes/local-ops/README.md).

### Octopus legacy compatibility

The Octopus wrapper and recipe notes remain for existing deployments. New integrations should invoke the generic command directly.

See [recipes/octopus-openai-compatible/README.md](./recipes/octopus-openai-compatible/README.md).

## Security model

The adapter separates path-checked repository tools from privileged shell execution.

Path-checked tools:

- remain inside the real `--cd` directory;
- reject `..`, external absolute paths and symlink escapes;
- enforce exact allowed files for writes and patches when configured.

Privileged `run_command`:

- runs `bash -lc` in the target checkout;
- inherits the adapter environment, including provider or GitHub tokens supplied by the caller;
- is not constrained by the file allowlist;
- can do anything permitted by the operating-system account and outer sandbox.

Recommended production posture:

- use an ephemeral container, VM or dedicated unprivileged account;
- mount only the intended checkout;
- expose only narrowly scoped, short-lived credentials;
- restrict network egress when feasible;
- enforce outer wall-clock and resource limits;
- review and validate diffs before publication;
- perform commit, push, pull-request, merge and deployment actions in a separate controlled stage.

See [SECURITY.md](./SECURITY.md) and [docs/adapter-contract.md](./docs/adapter-contract.md).

## Testing

Run the complete verification suite:

```bash
corepack pnpm run verify
```

It includes:

- TypeScript type checking.
- A clean production build.
- Unit tests for recipes and result normalization.
- Real-path, symlink and patch-allowlist tests.
- Local HTTP provider integration tests.
- JSON Schema validation tests.
- A package smoke test that creates a tarball, installs it in a temporary project and invokes the published CLI.

CI runs the same suite on Node.js 20, 22 and 24.

## Troubleshooting

Common failures:

- **`missing API key`** — set the variable named by `OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV`, or enable optional authentication for a trusted local provider.
- **HTTP 404** — the base URL is usually wrong; the adapter appends `/chat/completions`.
- **`missing choices[0].message`** — the endpoint returned a non-compatible success payload.
- **`write denied`** — add the exact relative path to `OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES`.
- **`path escapes cwd through symlink`** — the selected file or parent directory resolves outside the checkout.
- **`max_turns_exhausted`** — increase the turn budget or narrow the task.
- **Schema validation failure** — inspect the final validation errors and confirm the model supports reliable structured output.

See [docs/troubleshooting.md](./docs/troubleshooting.md) for detailed checks.

## Documentation

- [Architecture and trust boundaries](./docs/architecture.md)
- [External adapter contract](./docs/adapter-contract.md)
- [Provider compatibility](./docs/provider-compatibility.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [ClawSweeper recipe](./recipes/clawsweeper-codex-bin/README.md)
- [Local supervised recipe](./recipes/local-ops/README.md)
- [Octopus legacy compatibility](./recipes/octopus-openai-compatible/README.md)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)

## Project status

The project is usable and covered by integration tests, but the public API is still pre-1.0. Recipe interfaces and compatibility behavior may evolve between minor releases.

## Contributing

Issues and focused pull requests are welcome. Keep provider/tool-loop behavior generic and place host-specific policy in an explicit recipe.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
