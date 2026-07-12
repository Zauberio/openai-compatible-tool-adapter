# Local supervised automation recipe

A minimal deployment profile for running the generic adapter under human supervision.

This is not a separate code recipe: it uses the default `generic` behavior and documents a conservative runtime posture.

## Provider environment

```bash
export OPENAI_COMPATIBLE_ADAPTER_BASE_URL="https://api.example.com/v1"
export OPENAI_COMPATIBLE_ADAPTER_MODEL="provider/model"
export OPENAI_COMPATIBLE_ADAPTER_API_KEY_ENV="PROVIDER_API_KEY"
export PROVIDER_API_KEY="replace-with-your-secret"
```

Safe starting limits:

```bash
export OPENAI_COMPATIBLE_ADAPTER_MAX_TURNS=20
export OPENAI_COMPATIBLE_ADAPTER_MAX_TOKENS=0
export OPENAI_COMPATIBLE_ADAPTER_MAX_RETRIES=3
export OPENAI_COMPATIBLE_ADAPTER_REQUEST_TIMEOUT_MS=600000
export OPENAI_COMPATIBLE_ADAPTER_COMMAND_TIMEOUT_MS=120000
```

Optional exact write allowlist:

```bash
export OPENAI_COMPATIBLE_ADAPTER_ALLOWED_FILES="src/index.ts,test/index.test.ts"
```

## Run a supervised task

```bash
printf '%s\n' \
  'Inspect the failing test, make the smallest fix, run the narrow test, then show the diff.' | \
  openai-compatible-tool-adapter exec \
    --cd /path/to/disposable-checkout \
    --json -
```

Before accepting the result:

```bash
git status --short
git diff --check
git diff
```

## Credentials

Provide GitHub credentials only when the task explicitly needs read-only PR or issue inspection:

```bash
export GH_TOKEN="replace-with-a-scoped-token"
export GITHUB_TOKEN="$GH_TOKEN"
```

`run_command` inherits the complete adapter environment. Use narrowly scoped credentials and keep commit, push, merge and deployment credentials in a separate process.

## Recommended runtime posture

- Use a disposable checkout.
- Run as an unprivileged operating-system user.
- Mount only the repository and required caches.
- Restrict network egress where practical.
- Set outer CPU, memory and wall-clock limits.
- Start with an exact allowed-file list.
- Review the final diff before any publication step.
- Destroy the worker environment after the task when processing untrusted content.

See [../../SECURITY.md](../../SECURITY.md) and [../../docs/adapter-contract.md](../../docs/adapter-contract.md).
