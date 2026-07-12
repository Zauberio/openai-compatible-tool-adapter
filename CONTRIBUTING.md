# Contributing

## Setup

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run verify
```

Use a focused feature branch. Keep the generic core independent of host-specific prompts, schemas and result normalisation.

## Where changes belong

- Generic provider, CLI, tool-loop and workspace behaviour: `src/core/` or `src/bin/`.
- Host-specific policy: `src/recipes/<name>/`.
- Installation and integration examples: `recipes/<name>/`.
- Compatibility wrappers: `bin/`, only where environment or command translation is genuinely required.

New recipes should be selected explicitly and must not change the default generic behaviour.

## Tests

Add tests for behaviour changes, especially path handling, schemas, provider responses and package contents. `pnpm run verify` must pass before opening a pull request.

Never commit tokens, `.env` files, runtime logs, production state, backups or local checkout artefacts.
