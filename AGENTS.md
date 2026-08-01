# Codex Harness repository guidance

## Architecture invariants

- The renderer never accesses shell, filesystem, SQLite, credentials, or Codex processes directly.
- Electron main owns the Harness daemon process but does not own application state.
- Harness daemon is the only SQLite writer and the only owner of Codex App Server workers.
- Cross-process input is untrusted until validated by `@codex-harness/protocol`.
- Model tier and permission level are separate decisions.
- A model-reported completion is not a verified completion.
- External Harness recovery after context compaction is guaranteed only at the next safe turn boundary.

## Change workflow

- Keep one independently verifiable capability per PR.
- Complete the PR detailed design before changing source, tests, configuration, scripts, or dependencies.
- Update the corresponding design document in the same PR.
- Do not begin a dependent PR before its predecessor is merged.
- Keep runtime features disabled until their approval and evidence gates exist.

## Required validation

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:build
```

Every PR requires two consecutive review rounds against the same head SHA with no new actionable finding before squash merge.
