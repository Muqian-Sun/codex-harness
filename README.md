# Codex Harness

Local-first desktop task control, durable planning, and intelligent model routing for Codex.

The project is being delivered as a sequence of independently reviewed PRs. Runtime features remain disabled until their security and recovery gates are implemented.

## Development

Requirements:

- Node.js 24.14.0
- pnpm 10.14.0

Validation:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:build
```

See [the architecture overview](docs/architecture/overview.md) and the [PR1 detailed design](docs/design/0001-bootstrap-contracts.md).
