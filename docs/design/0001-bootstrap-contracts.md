# PR1 Detailed Design: Workspace Bootstrap and Protocol Contracts

Status: approved for implementation under Proposal v1.1a

PR scope: repository bootstrap, shared contracts, validation tooling, and CI only

## Responsibility boundary

This PR establishes a buildable TypeScript monorepo and freezes the first cross-process contract between the desktop shell and the Harness daemon. It does not start Codex App Server, open sockets, persist application state, route tasks, execute tools, or render a production desktop interface.

All runtime features remain disabled. Later PRs must build on the contracts introduced here instead of allowing the renderer to reach operating-system or Codex capabilities directly.

## Process ownership fixed by this PR

1. The Electron renderer may call only allowlisted preload methods.
2. Electron main owns one Harness daemon child process and translates allowlisted renderer calls into Harness RPC calls. V1 has no detached/background daemon mode and no attach-to-an-existing-daemon flow.
3. The Harness daemon exclusively owns SQLite and all Codex App Server worker processes.
4. A Codex App Server worker is connected to the Harness daemon through JSONL over stdio. Its stderr is diagnostic output and must never be parsed as protocol traffic.
5. Electron main connects to its child daemon through an owner-only Unix domain socket on macOS/Linux or a named pipe on Windows. The socket protocol is newline-delimited JSON.
6. Electron main generates a 256-bit CSPRNG startup capability, retains it only in main-process memory for the hello request, and writes it once to daemon inherited FD 3. The capability never travels through argv or the general child environment and rotates whenever the daemon is relaunched. A separate inherited FD 4 is held open solely as the parent-liveness pipe.
7. V1's Unix guarantee is scoped to a single-supervisor failure and tracked process groups. Electron main is the only process holding the FD 4 write endpoint, the daemon is the only process holding its read endpoint, and neither endpoint may leak to renderer, helper, App Server, PTY, or command descendants. If Electron main exits unexpectedly while the daemon remains responsive, EOF on FD 4 first moves the daemon atomically to `QUIESCING`, closes every spawn gate, then requests graceful interruption/drain, terminates its tracked descendants, and exits. If the daemon exits unexpectedly while Electron main remains responsive, main uses kill-domain identifiers recorded before work was enabled to terminate the daemon's dedicated process group and every separately tracked worker or PTY group; delayed cleanup must not rely on a reusable bare PID or PGID. On Windows, Electron main assigns the tree to a non-breakaway Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before enabling work. This uses the two existing supervisor roles and introduces no watchdog process. After a bounded graceful timeout, the surviving supervisor escalates from graceful termination through `SIGTERM` to `SIGKILL`. PR3 must test Electron-main-only and daemon-only `SIGKILL`, ignored `SIGTERM`, pipelines, background shell jobs, PTYs, shutdown racing with spawn, and liveness-FD leakage from a verifier outside the execution tree. Simultaneous loss of both supervisors, an operating-system or power failure, and a descendant that deliberately escapes an owned Unix group are not hard-containment guarantees; after restart, affected runs are marked `interrupted` or `containment_unknown` and require reconciliation, never inferred complete or automatically resumed for writes. A later desktop launch creates a new daemon and recovers from durable state; background execution while the desktop is closed is a non-goal for V1.
8. Renderer, Electron main, Harness daemon, and Codex App Server logs are separate from every protocol stream.

## Repository layout

```text
apps/
  desktop/                 Electron/React package placeholder; no Electron runtime yet
  harnessd/                Harness daemon package placeholder; no socket or child process yet
packages/
  protocol/                Runtime-validated Desktop-to-Harness protocol
docs/
  architecture/            Long-lived architectural boundaries
  design/                  Per-PR detailed designs
.github/
  workflows/               Required validation workflow
  pull_request_template.md Review and merge gate checklist
```

The repository uses a pnpm workspace, TypeScript project references, ESLint, Prettier, Vitest, and property-based parser tests. Node-executed packages use `NodeNext`; a separate browser config has no Node types, and renderer lint rules forbid every Node built-in import in bare or `node:` form, direct `electron` imports, and Node-only globals such as `process` or `Buffer`. A source-mapped, no-emit TypeScript configuration checks production and test sources independently from the forced package build. Package artifacts are imported by a Node ESM smoke test; no production bundler or desktop packager is introduced in this PR. Proposal v1.1a retains the TypeScript/Node Harness daemon selected for V1 and narrows Unix cleanup to the approved single-fault model, so no Rust workspace, guardian process, VM backend, or cross-language code generation is part of this architecture. The versioned wire contract preserves the option to replace the daemon implementation in a later proposal.

## Protocol interface

The wire format has a small, stable bootstrap layer so clients can authenticate and negotiate an application protocol before using application envelopes.

The first frame on every connection must be a strict `system.hello` bootstrap request. Before it succeeds, the daemon rejects every other frame and closes the connection. Authentication is performed before capability or application-version negotiation.

```ts
type BootstrapHelloRequest = {
  kind: "bootstrap-request";
  wireVersion: "1";
  id: string;
  method: "system.hello";
  params: SystemHelloParams;
};

type BootstrapHelloResponse = {
  kind: "bootstrap-response";
  wireVersion: "1";
  id: string;
  result: SystemHelloResult;
};

type BootstrapErrorResponse = {
  kind: "bootstrap-error";
  wireVersion: "1";
  id: string | null;
  error: {
    code: RpcErrorCode;
    message: string;
  };
};
```

After a successful hello, the selected application protocol is exact-match for the connection. The shared package exports runtime schemas and inferred TypeScript types for four application envelopes:

```ts
type RpcRequest = {
  kind: "request";
  wireVersion: "1";
  protocolVersion: "1.0";
  id: string;
  method: string;
  params: JsonValue;
};

type RpcResponse = {
  kind: "response";
  wireVersion: "1";
  protocolVersion: "1.0";
  id: string;
  result: JsonValue;
};

type RpcErrorResponse = {
  kind: "error";
  wireVersion: "1";
  protocolVersion: "1.0";
  id: string | null;
  error: {
    code: RpcErrorCode;
    message: string;
    data?: JsonValue;
  };
};

type RpcEvent = {
  kind: "event";
  wireVersion: "1";
  protocolVersion: "1.0";
  streamId: string;
  sequence: number;
  method: string;
  params: JsonValue;
};
```

Error-code syntax is an open, namespaced string so a new server code does not break an older client. The package exports these initial known constants, but consumers must preserve an `unknown` fallback:

- `protocol.invalid_message`
- `auth.authentication_failed`
- `protocol.unsupported_version`
- `capability.unsupported`
- `rpc.method_not_found`
- `rpc.invalid_params`
- `internal.error`
- `service.unavailable`
- `rpc.conflict`

Bootstrap errors are limited to `protocol.invalid_message`, `auth.authentication_failed`, `protocol.unsupported_version`, `capability.unsupported`, `internal.error`, and `service.unavailable`. Authenticated application errors may additionally use the `rpc.*` codes. A currently known application-only code is rejected in a bootstrap envelope; an unknown well-formed future code remains parseable and must follow the consumer's fallback path.

`RpcErrorCode` is a 1-128 byte ASCII token matching `[a-z][a-z0-9]*(?:[._/-][a-z][a-z0-9]*)*`. Bootstrap and application errors share this lexical grammar but apply different known-code rules and the strict `internal.error` branch described below. Application-version tokens are 3-32 ASCII bytes matching `[1-9][0-9]*\.[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9][a-z0-9.-]*)?`. Both grammar and limits are exported constants and have lower/upper boundary tests.

The bootstrap method is `system.hello`:

```ts
type SystemHelloParams = {
  client: { name: string; version: string };
  supportedProtocolVersions: string[];
  capabilities: {
    supported: string[];
    required: string[];
  };
  startupCapability: string;
  resume?: {
    streamId: string;
    lastSequence: number;
  };
};

type SystemHelloResult = {
  selectedProtocolVersion: ApplicationVersionToken;
  server: { name: "harnessd"; version: string };
  enabledCapabilities: string[];
  stream: {
    id: string;
    nextSequence: number;
    replayWindowStart: number;
    resyncRequired: boolean;
  };
};
```

Capability tokens use stable namespaced strings. `enabledCapabilities` is the supported intersection. If any required client capability cannot be enabled, the handshake fails with `capability.unsupported`. Unknown optional capability tokens are ignored.

`capabilities.supported` and `capabilities.required` each contain at most 64 unique tokens, with `required` a subset of `supported`. Each token is 1-128 ASCII characters matching `[a-z][a-z0-9]*(?:[._/-][a-z][a-z0-9]*)*`. Invalid or duplicate sets fail bootstrap validation. Empty sets are valid. `enabledCapabilities` is unique and follows the server's stable preference order, not client input order. An unsupported required token returns bootstrap error `capability.unsupported`.

The client must advertise between 1 and 16 unique syntactically valid application versions. An empty or malformed list is `protocol.invalid_message`. The server keeps an explicit unique newest-to-oldest application-version preference list and selects the first version also present in the client's supported set. Versions are never ordered lexicographically. No intersection returns bootstrap error `protocol.unsupported_version` and closes the connection. The bootstrap result accepts a syntactically valid selected token; session code must verify it was offered. This V1 implementation advertises only `1.0`, and application envelopes remain exact-match `1.0`.

The startup capability is a canonical unpadded 43-character base64url encoding of 256 CSPRNG bits; validation enforces the zero padding bits implied by that byte length. It is never exposed to the renderer, persisted, logged, echoed, or included in error data. PR3 must generate it with an operating-system CSPRNG, compare it in constant time, bind it to the daemon process lifetime, and close the connection after a generic authentication failure.

`streamId` is a fresh canonical unpadded 22-character base64url encoding of exactly 128 CSPRNG bits for every daemon start and is never reused intentionally; validation enforces its zero padding bits. Event `sequence`, `nextSequence`, and `replayWindowStart` are positive safe integers; `lastSequence` is a non-negative safe integer where `0` means no event has been consumed. `replayWindowStart <= nextSequence` is enforced. Event sequence starts at `1` and increases strictly across all connections to that instance. V1 permits exactly one authenticated active Electron-main connection per daemon. No application event is sent before hello succeeds. After the hello response, replay events are sent in strict sequence order and complete before live delivery begins; replay and live events never interleave. A duplicate `(streamId, sequence)` is ignored by the client; a gap triggers resynchronization. A different stream ID always requires reconstruction from durable state. The hello response states whether the requested in-memory replay window is available. PR3 supplies only a bounded in-memory replay buffer; PR4 adds durable reconstruction.

RPC IDs are 1-64 ASCII characters from `[A-Za-z0-9._:-]`, must be unique among in-flight requests on one connection, and are echoed exactly in the response. The client library refuses to send a duplicate. If the server nevertheless receives a duplicate in-flight ID, it returns a protocol error with `id: null` and closes the connection without resolving the original request. Unknown or late responses are ignored and diagnosed without payload logging. Disconnected requests are not automatically replayed; later write APIs require separate idempotency keys.

Application method names and capability tokens share the same 1-128 byte namespaced ASCII grammar. The protocol package exports the grammar and byte limits so the transport, registry, and tests cannot diverge.

Frames are limited to 1 MiB measured as raw UTF-8 bytes excluding the LF delimiter and an optional immediately preceding CR. PR3 must cap the unterminated byte buffer before it can exceed that bound, use fatal UTF-8 decoding, and close on an oversized, invalid-UTF-8, empty, or malformed frame without including the frame in an error response. One trailing carriage return before the newline is accepted.

Unknown event methods are forward-compatible and may be logged or ignored. Unknown requests receive `rpc.method_not_found`. Application protocol mismatch fails closed.

Request envelope and request-parameter schemas are strict. Response, non-internal error, and event schemas accept unknown fields within the same application protocol so servers can add optional output fields. The code-dependent `internal.error` envelope and payload remain strict to prevent accidental disclosure. Unknown envelope discriminators still fail. Breaking field semantics, removed fields, or new required output fields require a new application protocol version.

All payloads use a cycle-aware, iterative `JsonValue` validator: null, boolean, finite number, string, JSON array, or plain string-keyed JSON object. Maximum nesting depth is 64, and both visited nodes and pending traversal work are bounded by 100,000 in addition to the frame byte limit. `undefined`, bigint, symbols, functions, non-finite numbers, accessors that throw, class instances, cyclic structures, and deeper or larger graphs are rejected as structured failures. Every public parser catches unexpected validation and JSON exceptions rather than allowing untrusted input to escape as a throw.

The initial application method contracts are:

```ts
type SystemHealthParams = Record<string, never>;
type SystemHealthResult = {
  status: "ok";
  streamId: string;
  uptimeMs: number;
};

type SystemShutdownParams = {
  reason?: string;
};
type SystemShutdownResult = {
  accepted: true;
};
```

`system.shutdown` requests a graceful drain and is available only after authentication. It does not grant the renderer direct process termination.

When present, `system.shutdown.reason` is a machine-readable value using the same 1-128 byte namespaced ASCII grammar as method names.

`uptimeMs` is a non-negative safe integer. Method and hello-result schemas enforce these numeric, identity, and cross-field constraints rather than leaving them as documentation-only rules.

## Envelope direction and session responsibility

V1 is client-initiated RPC. Electron main is the only client and Harness daemon is the server:

- client to server before authentication: `bootstrap-request` only;
- server to client before authentication: `bootstrap-response` or `bootstrap-error` only;
- client to server after authentication: `request` only;
- server to client after authentication: `response`, `error`, or `event` only.

Server-initiated requests are not supported in V1. Future approval prompts are daemon events with opaque request IDs; Electron main resolves them using an authenticated client request. The package exports role-aware parsers so a structurally valid envelope in the wrong direction is rejected before dispatch.

## Package behavior

`@codex-harness/protocol` provides:

- envelope schemas and inferred types;
- bootstrap hello request/response schemas;
- a raw-frame decoder that accepts `Uint8Array`, enforces the per-frame byte limit, performs fatal UTF-8 decoding, parses JSON, and then validates the envelope;
- `parseClientBootstrapEnvelope`, `parseServerBootstrapEnvelope`, `parseClientRpcEnvelope`, and `parseServerRpcEnvelope`, returning typed success/failure results without throwing for untrusted input or accepting wrong-direction envelopes;
- `assertSupportedProtocolVersion(version)` for trusted internal call sites;
- a method-contract registry with request-parameter and response-result schemas;
- `decodeRequestParams(method, params)` and `decodeResponseResult(method, result)` as the mandatory second validation stage;
- a pure `negotiateHello` utility for version and capability set validation/selection; authentication remains a PR3 transport concern;
- method-specific schemas for `system.hello`, `system.health`, and `system.shutdown`;
- constants for wire/application versions, known error codes, ID constraints, and maximum frame size.

Dispatch is always two-stage: parse the envelope, then look up and decode the method-specific payload. Unknown methods never reach a handler. Invalid method parameters produce `rpc.invalid_params`. Responses are decoded using the method stored with the matching pending request.

The desktop and daemon placeholder packages may import the protocol package to prove workspace boundaries compile, but they expose no executable behavior.

## State and error handling

This PR creates no application database and no durable runtime state. Parsing failures are represented as structured failures and must not leak parser stack traces or the full untrusted payload. Internal programmer errors may throw only after data has crossed a runtime validation boundary.

CI and local commands must return non-zero on lint, formatting, type, unit-test, or build failure.

PR1 validates schemas, frame decoding, directionality, and pure negotiation only. Connection state, constant-time authentication, first-frame enforcement, active request-ID tracking, replay buffering, sequence-gap handling, graceful shutdown, parent-liveness handling, and process-tree termination are mandatory PR3 acceptance tests. Durable resynchronization is a PR4 acceptance test. They are documented here to freeze the contract but are not claimed as implemented by PR1.

Every `internal.error` sent across the boundary uses a code-dependent strict schema with a fixed safe public message. Its optional data may contain only a non-sensitive correlation ID, and its envelope does not accept forward-compatible extra fields. Raw `Error` objects, stack traces, environment variables, request parameters, frames, and credentials are never serialized; PR1 passes a sentinel exception through the safe application-error constructor and injects sentinel secrets into unsafe bootstrap and application envelopes to prove that serialization or validation cannot expose them. Logging does not exist in PR1; PR3 must add a separate sentinel test before any runtime log sink is enabled.

## Security impact

- No shell, filesystem, network, database, credential, or model capability is exposed.
- Runtime validation is mandatory at process boundaries; TypeScript types alone are insufficient.
- Authentication must complete before any application method is accepted.
- The renderer-to-main preload API remains intentionally unspecified until the Electron security-shell PR.
- Dependency lifecycle scripts are not granted broad privileges by repository configuration.
- pnpm dependency build scripts use an explicit minimal allowlist, shared by local installs and CI; the lockfile and allowlist are reviewed together.
- GitHub Actions use top-level `permissions: contents: read`, disable checkout credential persistence, never use `pull_request_target`, receive no repository secrets for untrusted PR code, and pin every `uses:` action, including official `actions/*`, to a full commit SHA with its release tag recorded in a comment. Only repository-local actions may use relative paths.
- Secrets and complete untrusted frames must not appear in validation errors.

## Compatibility

- Bootstrap wire version `1` remains stable across application-protocol negotiation.
- Application protocol version `1.0` is exact-match in V1.
- Strict requests reject unknown fields. Responses, non-internal errors, and events tolerate unknown optional fields within the same application protocol; `internal.error` is intentionally strict.
- Error codes and optional capability tokens are open strings; consumers must handle unknown values.
- Breaking envelope or method changes require a new protocol version and migration design.
- Node 24.14.0 and pnpm 10.14.0 are pinned by repository metadata and CI. The Node baseline matches the current lint/test toolchain's supported engine range.
- No Codex App Server protocol types are copied into this package; those are pinned and generated in PR2.

## Files expected in this PR

- root workspace metadata and tool configuration;
- `apps/desktop` and `apps/harnessd` compile-only placeholders;
- `packages/protocol` implementation and tests;
- architecture overview and repository guidance;
- CI workflow and PR review template;
- dependency lockfile.

No other application feature files are in scope.

## Verification

Required local checks:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:build
```

Protocol tests cover:

- each valid envelope;
- malformed JSON-compatible values;
- arbitrary/property-generated inputs proving public parsers do not throw;
- raw byte frames at, below, and above the 1 MiB limit;
- invalid UTF-8, empty frames, non-JSON frames, non-finite values, and non-JSON runtime values;
- cyclic runtime objects, throwing accessors, excessive nesting depth, and excessive graph-node count;
- unknown envelope kinds;
- empty or oversized identifiers and methods;
- invalid event sequences;
- open error-code fallback and every known error-code constant;
- supported and unsupported protocol versions;
- redacted parse errors and snapshots proving the startup capability never appears in serialized failures;
- strict requests versus forward-compatible response/event fields;
- client/server direction-invalid envelopes;
- RPC ID syntax and length;
- method-registry parameter/result decoding;
- pure hello negotiation covering success, no common version, unsupported required capability, duplicates, unknown optional tokens, empty sets, deterministic ordering, and configured limits;
- `system.hello` authentication, capability, stream-resume, stream-counter, and version shapes.

CI runs the same checks on a clean install with the frozen lockfile.

## Review and merge gate

The PR remains a draft until all checks pass. After implementation:

1. perform a complete requirement/design/diff self-review;
2. run independent correctness and security/compatibility reviews;
3. fix every actionable finding and rerun all checks;
4. repeat review against the new final commit;
5. require two consecutive review rounds against the same PR head SHA with no new actionable finding;
6. verify there are no unresolved review threads and pass the expected reviewed head SHA to the merge operation so no post-review commit can race the merge;
7. squash merge only after all gates pass, then record and verify the newly created squash commit SHA separately.

GitHub branch protection is not changed in this PR because repository-setting mutation was not included in the approved implementation scope. Until separately authorized, the agent enforces the same checks procedurally and refuses to merge when any gate is unmet.

Any need to introduce runtime execution, persistence, Electron, Codex process management, or a materially different cross-process boundary requires stopping and updating the proposal.
