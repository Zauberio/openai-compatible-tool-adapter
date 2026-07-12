# Legacy compatibility: Octopus (OpenAI-compatible adapter)

> **Status:** Legacy compatibility material. New Octopus integrations should invoke the generic adapter directly. The wrapper remains in the public repository for existing deployments but is not exported as an npm binary.

This document records the former Octopus integration with an OpenAI-compatible API provider using the generic tool adapter.

Octopus is a meta-agent that delegates code-generation subtasks to subagents. When configured with an external adapter, Octopus can route tool-using work to any OpenAI-compatible chat-completions provider without embedding provider clients in the Octopus runtime.

## Files

```text
recipes/octopus-openai-compatible/adapter.example.env
```

New integrations do not need a dedicated wrapper because Octopus can invoke the standard `codex exec`-shaped command surface directly. `bin/octopus-openai-compatible-adapter.mjs` is retained only for deployments that still use the older `OCTOPUS_OPENAI_COMPATIBLE_*` environment names.

## Host configuration

Configure Octopus to use the adapter as its model command:

```bash
# Tell Octopus to use an external command for model inference
export OCTOPUS_MODEL_COMMAND=/path/to/openai-compatible-tool-adapter/dist/bin/openai-compatible-tool-adapter.js
export OCTOPUS_MODEL_COMMAND_ARGS='["exec"]'
```

Octopus will then invoke the adapter with:

```text
stdin prompt
--cd <working directory>
--output-last-message <result path>
--output-schema <optional schema>
--json -
```

## Provider environment

Set the OpenAI-compatible provider endpoint and model in the Octopus process environment:

```bash
export OPENAI_COMPATIBLE_ADAPTER_BASE_URL="https://api.example.com/v1"
export OPENAI_COMPATIBLE_ADAPTER_MODEL="provider/model-name"
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV="MY_PROVIDER_API_KEY"
export MY_PROVIDER_API_KEY="..."
```

The adapter reads the API key by environment variable name (`OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV`), not by direct value. This keeps the key name in config while the secret value stays in your secret store or process manager.

Optional limits:

```bash
export OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS=20
export OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS=0
export OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=3
export OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS=600000
export OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS=120000
```

The adapter defaults to 20 turns. Set `OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS=0` explicitly for unlimited turns and retain an outer host timeout.

## Token environment

If the recipe requires GitHub API access, provide a normal GitHub token in the process environment:

```bash
export GH_TOKEN="..."
export GITHUB_TOKEN="$GH_TOKEN"
```

Do not hardcode tokens in recipe files, adapter config, or host config. Store them in your secret manager, shell profile, or process supervisor unit.

## Expected host command shape

Octopus calls the adapter with the standard Codex-compatible command surface:

```bash
printf "$PROMPT" | \
  /path/to/openai-compatible-tool-adapter/dist/bin/openai-compatible-tool-adapter.js \
    exec \
    --cd /tmp/octopus-checkout/target-repo \
    --output-last-message /tmp/octopus-result.json \
    --output-schema /path/to/schema.json \
    --json -
```

Arguments:

| Argument | Purpose |
|----------|---------|
| `exec` | Subcommand selecting the tool-loop executor |
| `--cd <path>` | Target checkout directory for file operations |
| `--output-last-message <path>` | File path to write the model's final structured output |
| `--output-schema <path>` | Optional JSON schema for constraining output |
| `--json` | Request JSON-structured output |
| `-` | Accept prompt from stdin |

## Input/prompt expectations

Octopus should scope the prompt to the specific subtask being delegated. The prompt may include:

```text
task description and scope
target directory path
relevant file paths or search patterns
validation commands (if applicable)
output format instructions
```

The adapter passes the prompt verbatim to the model as the system and/or user message. Octopus remains responsible for overall orchestration, subtask decomposition, and aggregating results.

## What the adapter may do

Within the bounds of the checked-out target directory and environment configuration, the adapter may:

- Read files
- Write files (limited by `OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES` if set)
- Run shell commands in the target directory
- Search files
- Produce structured or unstructured output

## What remains host-controlled

Octopus (the host) retains full control over:

- **Subtask decomposition and orchestration** -- Octopus decides which subtasks to delegate and how to combine results
- **Working directory selection** -- which repository checkout to work on
- **Sandbox policy** -- what commands may run, what files may be read
- **Validation gates** -- post-adapter verification before accepting results
- **Publishing and deployment** -- commits, pushes, PRs, approvals stay in Octopus workflow
- **Secrets management** -- provider keys and tokens live outside recipe files
- **Timeout budget** -- the host process timeout caps total execution time

## Validation / smoke command

Before using this recipe in production, verify the adapter is correctly installed and the expected command surface works:

```bash
# 1. Confirm the adapter builds and the entry point exists
node dist/bin/openai-compatible-tool-adapter.js --help

# 2. Quick smoke: invoke with a trivial prompt and validate output shape
printf "Say hello and nothing else." | \
  node dist/bin/openai-compatible-tool-adapter.js exec \
    --cd "$PWD" \
    --output-last-message /tmp/adapter-smoke.json \
    --json -

# 3. Inspect the output
cat /tmp/adapter-smoke.json
```

> **Note:** Steps 2--3 require a configured provider (`OPENAI_COMPATIBLE_ADAPTER_BASE_URL`, `OPENAI_COMPATIBLE_ADAPTER_MODEL`, and `OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV` + key). Without a provider, the adapter will fail at the API call stage. For a fully offline smoke, run `node dist/bin/openai-compatible-tool-adapter.js --help` and confirm the command parses arguments without error.

## Environment validation

To verify the environment is correctly set before invoking Octopus:

```bash
# Check that key environment variables are present (values redacted)
echo "Base URL: ${OPENAI_COMPATIBLE_ADAPTER_BASE_URL:?must be set}"
echo "Model:    ${OPENAI_COMPATIBLE_ADAPTER_MODEL:?must be set}"
echo "Key env:  ${OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV:?must be set}"
key_name="${OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV}"
echo "Key set:  ${!key_name:+yes (value hidden)}"
```

This script will exit with an error if any required variable is missing.
