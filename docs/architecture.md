# Architecture and trust boundaries

OpenAI-Compatible Tool Adapter is a local command-line process. It does not expose a network server. A caller starts the process, supplies a task on stdin and receives the final message on stdout or in an output file.

## Request flow

```text
caller
  │ argv + environment + stdin prompt
  ▼
CLI parser
  │
  ├── loads the selected recipe
  ├── validates the target checkout
  └── prepares provider messages and tools
  │
  ▼
OpenAI-compatible Chat Completions endpoint
  │ assistant message or tool calls
  ▼
tool loop
  │
  ├── path-checked file tools
  ├── privileged shell command tool
  └── Git diff inspection
  │
  ▼
optional JSON Schema validation and repair
  │
  ▼
stdout + optional result file + process exit code
```

## Module map

| Area | Location | Responsibility |
|---|---|---|
| CLI and provider loop | `src/bin/openai-compatible-tool-adapter.ts` | Arguments, environment, HTTP requests, retries, tool dispatch and final output. |
| Tool-call normalization | `src/core/textual-tools.ts` | Converts supported native or textual tool-call forms into one internal shape. |
| Workspace guard | `src/core/workspace-guard.ts` | Real-path checks, symlink-escape rejection and patch target validation. |
| Schema validation | `src/core/schema-validator.ts` | Compiles and evaluates output schemas with Ajv. |
| Recipe interface | `src/recipes/types.ts` | Contract for prompt preparation and result normalization. |
| Generic recipe | `src/recipes/generic.ts` | Provider-neutral repository-agent instructions. |
| ClawSweeper recipe | `src/recipes/clawsweeper/` | Explicit compatibility behavior for ClawSweeper jobs. |
| Compatibility wrappers | `bin/` | Environment and executable-shape translation. |

## Recipe boundary

The core knows only the recipe interface. A recipe may:

- prepare or compact the incoming prompt;
- add system instructions;
- normalize candidate or final output;
- provide a schema-repair prompt;
- translate a command for a known compatibility constraint;
- define behavior when the tool budget is exhausted.

A recipe should not add provider clients, deployment credentials or publication logic to the generic core.

## Trust boundaries

### Provider boundary

The adapter sends the prompt, conversation and tool definitions to the configured provider. Treat the provider as able to observe all content sent in those messages.

API keys are read from the environment and used only for the HTTP Authorization header. They are not inserted into model messages by the adapter.

### Repository boundary

Path-based tools are constrained to the real target checkout. They reject lexical traversal, external absolute paths and symlinks that resolve outside the checkout.

When an allowed-file list is configured, direct writes and every target of `apply_patch` must match an exact relative path.

### Shell boundary

`run_command` is privileged arbitrary shell execution. It inherits the complete adapter environment and is governed only by the operating-system account, container or VM around the process.

The file allowlist does not constrain shell commands.

### Publication boundary

The adapter edits a checkout and returns results. Commit, push, pull-request, merge and deployment actions should remain separate caller-controlled stages with independent credentials and approval policy.

## Failure model

- Configuration errors fail before contacting the provider.
- Transient HTTP errors are retried within the configured attempt budget.
- Invalid successful provider payloads fail with a compatibility error.
- Tool errors are returned to the model as tool results so it can recover.
- Final schema violations receive one repair request when the selected recipe allows it.
- Exhausting the turn budget returns a bounded finalization result or exits with failure, depending on the output contract.

See [adapter-contract.md](./adapter-contract.md) for the external command contract and [provider-compatibility.md](./provider-compatibility.md) for endpoint requirements.
