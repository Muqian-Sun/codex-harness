import { TextDecoder, TextEncoder } from "node:util";

import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  RPC_ERROR_CODES,
  parseServerBootstrapEnvelope,
  parseServerRpcEnvelope,
  type JsonValue,
} from "@codex-harness/protocol";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { ConnectionSession, type ConnectionSessionAction } from "./connection-session.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STARTUP_CAPABILITY = "A".repeat(43);
const STREAM_ID = `${"B".repeat(21)}A`;
const ACCOUNT_STATUS = Object.freeze({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000831",
  workerSessionId: "00000000-0000-4000-8000-000000000832",
  observedAtMs: 1_750_000_000_001,
  status: "authenticated",
  credentialKind: "chatgpt",
  planType: "pro",
}) satisfies JsonValue;

function createSession(options?: {
  uptimeMs?: () => number;
  readAccountStatus?: () => unknown;
  readModelCatalogPage?: (params: JsonValue) => unknown;
  readProjectRoutingBindingStatuses?: (params: JsonValue) => unknown;
  bindProjectDefaultRouting?: (params: JsonValue) => unknown;
  readProjectTaskCatalogPage?: (params: JsonValue) => unknown;
  createProjectTask?: (params: JsonValue) => unknown;
  readProjectTaskDetail?: (params: JsonValue) => unknown;
  reviseProjectTaskRequirement?: (params: JsonValue) => unknown;
  generateProjectTaskCandidatePlan?: (params: JsonValue) => unknown | Promise<unknown>;
  readRoutingConfiguration?: () => unknown;
  setRoutingConfiguration?: (params: JsonValue) => unknown;
}): ConnectionSession {
  return new ConnectionSession({
    startupCapability: STARTUP_CAPABILITY,
    serverVersion: "0.0.0",
    streamIdFactory: () => STREAM_ID,
    ...(options?.uptimeMs === undefined ? {} : { uptimeMs: options.uptimeMs }),
    ...(options?.readAccountStatus === undefined
      ? {}
      : { readAccountStatus: options.readAccountStatus }),
    ...(options?.readModelCatalogPage === undefined
      ? {}
      : { readModelCatalogPage: options.readModelCatalogPage }),
    ...(options?.readProjectRoutingBindingStatuses === undefined
      ? {}
      : { readProjectRoutingBindingStatuses: options.readProjectRoutingBindingStatuses }),
    ...(options?.bindProjectDefaultRouting === undefined
      ? {}
      : { bindProjectDefaultRouting: options.bindProjectDefaultRouting }),
    ...(options?.readProjectTaskCatalogPage === undefined
      ? {}
      : { readProjectTaskCatalogPage: options.readProjectTaskCatalogPage }),
    ...(options?.createProjectTask === undefined
      ? {}
      : { createProjectTask: options.createProjectTask }),
    ...(options?.readProjectTaskDetail === undefined
      ? {}
      : { readProjectTaskDetail: options.readProjectTaskDetail }),
    ...(options?.reviseProjectTaskRequirement === undefined
      ? {}
      : { reviseProjectTaskRequirement: options.reviseProjectTaskRequirement }),
    ...(options?.generateProjectTaskCandidatePlan === undefined
      ? {}
      : { generateProjectTaskCandidatePlan: options.generateProjectTaskCandidatePlan }),
    ...(options?.readRoutingConfiguration === undefined
      ? {}
      : { readRoutingConfiguration: options.readRoutingConfiguration }),
    ...(options?.setRoutingConfiguration === undefined
      ? {}
      : { setRoutingConfiguration: options.setRoutingConfiguration }),
  });
}

function hello(
  capability = STARTUP_CAPABILITY,
  resume = false,
  negotiation?: {
    versions?: string[];
    supportedCapabilities?: string[];
    requiredCapabilities?: string[];
  },
): JsonValue {
  return {
    kind: "bootstrap-request",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    id: "hello-1",
    method: "system.hello",
    params: {
      client: { name: "CodexHarnessDesktop", version: "0.0.0" },
      supportedProtocolVersions: negotiation?.versions ?? [APPLICATION_PROTOCOL_VERSION],
      capabilities: {
        supported: negotiation?.supportedCapabilities ?? [],
        required: negotiation?.requiredCapabilities ?? [],
      },
      startupCapability: capability,
      ...(resume ? { resume: { streamId: `${"C".repeat(21)}A`, lastSequence: 10 } } : {}),
    },
  };
}

function rpc(id: string, method: string, params: JsonValue): JsonValue {
  return {
    kind: "request",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id,
    method,
    params,
  };
}

function frame(value: JsonValue, carriageReturn = false): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}${carriageReturn ? "\r" : ""}\n`);
}

function joinedFrames(...values: JsonValue[]): Uint8Array {
  return encoder.encode(values.map((value) => `${JSON.stringify(value)}\n`).join(""));
}

function sentValues(actions: readonly ConnectionSessionAction[]): JsonValue[] {
  return actions
    .filter(
      (action): action is Extract<ConnectionSessionAction, { type: "send" }> =>
        action.type === "send",
    )
    .map((action) => {
      const text = decoder.decode(action.frame);
      expect(text.endsWith("\n")).toBe(true);
      return JSON.parse(text.slice(0, -1)) as JsonValue;
    });
}

async function authenticate(session: ConnectionSession): Promise<JsonValue> {
  const actions = await session.receive(frame(hello(), true));
  expect(actions).toHaveLength(1);
  const values = sentValues(actions);
  expect(values).toHaveLength(1);
  expect(parseServerBootstrapEnvelope(values[0]).ok).toBe(true);
  expect(session.state).toBe("authenticated");
  return values[0] as JsonValue;
}

describe("daemon connection session", () => {
  it("authenticates a fragmented hello before accepting RPC", async () => {
    const session = createSession();
    const encoded = frame(hello());
    const split = Math.floor(encoded.byteLength / 2);
    expect(await session.receive(encoded.subarray(0, split))).toEqual([]);
    const actions = await session.receive(encoded.subarray(split));
    const response = sentValues(actions)[0];
    expect(response).toMatchObject({
      kind: "bootstrap-response",
      id: "hello-1",
      result: {
        selectedProtocolVersion: APPLICATION_PROTOCOL_VERSION,
        enabledCapabilities: [],
        stream: {
          id: STREAM_ID,
          nextSequence: 1,
          replayWindowStart: 1,
          resyncRequired: false,
        },
      },
    });
    expect(session.state).toBe("authenticated");
  });

  it("processes hello and health frames in order from one chunk", async () => {
    const session = createSession({ uptimeMs: () => 1_250.9 });
    const actions = await session.receive(
      joinedFrames(hello(), rpc("health-1", "system.health", {})),
    );
    const values = sentValues(actions);
    expect(values).toHaveLength(2);
    expect(parseServerBootstrapEnvelope(values[0]).ok).toBe(true);
    expect(parseServerRpcEnvelope(values[1]).ok).toBe(true);
    expect(values[1]).toMatchObject({
      kind: "response",
      id: "health-1",
      result: { status: "ok", streamId: STREAM_ID, uptimeMs: 1_250 },
    });
  });

  it("serves a validated account snapshot after authentication", async () => {
    const session = createSession({
      readAccountStatus: () => ({
        schemaVersion: 1,
        snapshotId: "00000000-0000-4000-8000-000000000821",
        workerSessionId: "00000000-0000-4000-8000-000000000822",
        observedAtMs: 1_750_000_000_001,
        status: "authentication_required",
        credentialKind: null,
        planType: null,
      }),
    });
    await authenticate(session);

    const actions = await session.receive(frame(rpc("account-1", "account.status", {})));
    expect(sentValues(actions)[0]).toMatchObject({
      kind: "response",
      id: "account-1",
      result: {
        status: "authentication_required",
        credentialKind: null,
        planType: null,
      },
    });
    expect(session.state).toBe("authenticated");
  });

  it("serves a validated bounded model catalog page only after authentication", async () => {
    const observedParams: JsonValue[] = [];
    const session = createSession({
      readModelCatalogPage: (params) => {
        observedParams.push(params);
        return {
          schemaVersion: 1,
          provider: "openai",
          totalVisibleModels: 1,
          models: [
            {
              model: "gpt-model",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium"],
              inputModalities: ["text"],
            },
          ],
          nextCursor: null,
        };
      },
    });
    await authenticate(session);

    const params = { cursor: null, limit: 12 } as const;
    const actions = await session.receive(frame(rpc("catalog-1", "model.catalog_page", params)));
    expect(sentValues(actions)[0]).toMatchObject({
      kind: "response",
      id: "catalog-1",
      result: {
        provider: "openai",
        totalVisibleModels: 1,
        models: [{ model: "gpt-model" }],
        nextCursor: null,
      },
    });
    expect(observedParams).toEqual([params]);
    expect(session.state).toBe("authenticated");
  });

  it("serves routing reads and writes through the authenticated session", async () => {
    const unconfigured = {
      schemaVersion: 1,
      configured: false,
      profileVersion: 0,
      configurationRevisionId: null,
      tiers: null,
      availability: null,
    } as const;
    const setRoutingConfiguration = vi.fn(() => unconfigured);
    const session = createSession({
      readRoutingConfiguration: () => unconfigured,
      setRoutingConfiguration,
    });
    await authenticate(session);

    expect(
      sentValues(
        await session.receive(frame(rpc("routing-get", "routing.configuration.get", {}))),
      )[0],
    ).toMatchObject({ kind: "response", result: unconfigured });
    const params = {
      commandId: "00000000-0000-4000-8000-000000000851",
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: {
        fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
        standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
      },
    } as const;
    expect(
      sentValues(
        await session.receive(frame(rpc("routing-set", "routing.configuration.set", params))),
      )[0],
    ).toMatchObject({ kind: "response", result: unconfigured });
    expect(setRoutingConfiguration).toHaveBeenCalledWith(params);
  });

  it("serves Project routing binding reads and writes through the authenticated session", async () => {
    const projectId = "00000000-0000-4000-8000-000000000861";
    const profileId = "00000000-0000-4000-8000-000000000901";
    const revisionId = "00000000-0000-4000-8000-000000000851";
    const binding = {
      projectId,
      bindingVersion: 1,
      profileId,
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: revisionId,
    } as const;
    const readProjectRoutingBindingStatuses = vi.fn(() => ({
      schemaVersion: 1,
      statuses: [{ projectId, status: "default_bound", binding }],
    }));
    const bindProjectDefaultRouting = vi.fn(() => ({
      schemaVersion: 1,
      status: "bound",
      binding,
    }));
    const session = createSession({
      readProjectRoutingBindingStatuses,
      bindProjectDefaultRouting,
    });
    await authenticate(session);

    const statusParams = { projectIds: [projectId] };
    expect(
      sentValues(
        await session.receive(
          frame(rpc("binding-get", "project.routing_binding.status_batch", statusParams)),
        ),
      )[0],
    ).toMatchObject({ kind: "response", result: { statuses: [{ status: "default_bound" }] } });
    expect(readProjectRoutingBindingStatuses).toHaveBeenCalledWith(statusParams);

    const bindParams = {
      commandId: "00000000-0000-4000-8000-000000000862",
      projectId,
      expectedBindingVersion: 0,
      previousProfileId: null,
      expectedProfileVersion: 1,
      expectedConfigurationRevisionId: revisionId,
    } as const;
    expect(
      sentValues(
        await session.receive(
          frame(rpc("binding-set", "project.routing_binding.bind_default", bindParams)),
        ),
      )[0],
    ).toMatchObject({ kind: "response", result: { status: "bound", binding } });
    expect(bindProjectDefaultRouting).toHaveBeenCalledWith(bindParams);
  });

  it("fails closed when Project routing binding providers are absent", async () => {
    const session = createSession();
    await authenticate(session);

    expect(
      sentValues(
        await session.receive(
          frame(
            rpc("binding-get", "project.routing_binding.status_batch", {
              projectIds: ["00000000-0000-4000-8000-000000000861"],
            }),
          ),
        ),
      )[0],
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.unavailable } });
  });

  it("serves Project Task catalog, creation, detail, and revision through explicit providers", async () => {
    const projectId = "00000000-0000-4000-8000-000000000861";
    const taskId = "00000000-0000-4000-8000-000000000911";
    const readProjectTaskCatalogPage = vi.fn(() => ({
      schemaVersion: 1,
      tasks: [
        {
          taskId,
          projectId,
          taskVersion: 1,
          title: "Persist Task",
          objective: "Persist without execution.",
          stage: "requirements_only",
        },
      ],
      nextCursor: null,
    }));
    const createProjectTask = vi.fn(() => ({
      schemaVersion: 1,
      status: "created",
      taskId,
    }));
    const readProjectTaskDetail = vi.fn(() => ({
      schemaVersion: 1,
      projectId,
      ownershipVersion: 1,
      taskId,
      taskVersion: 1,
      title: "Persist Task",
      stage: "requirements_only",
      activeRequirement: {
        revisionId: "00000000-0000-4000-8000-000000000912",
        revisionNumber: 1,
        sourceText: "Persist without execution.",
        objective: "Persist without execution.",
        constraints: [],
        acceptanceCriteria: [],
      },
      latestPlanRevisionId: null,
      candidatePlan: null,
    }));
    const reviseProjectTaskRequirement = vi.fn(() => ({
      schemaVersion: 1,
      status: "revised",
      taskId,
    }));
    const session = createSession({
      readProjectTaskCatalogPage,
      createProjectTask,
      readProjectTaskDetail,
      reviseProjectTaskRequirement,
    });
    await authenticate(session);
    const catalogParams = { projectId, cursor: null, limit: 12 };
    expect(
      sentValues(
        await session.receive(frame(rpc("task-get", "task.catalog_page", catalogParams))),
      )[0],
    ).toMatchObject({ kind: "response", result: { tasks: [{ taskId }] } });
    expect(readProjectTaskCatalogPage).toHaveBeenCalledWith(catalogParams);

    const createParams = {
      commandId: "00000000-0000-4000-8000-000000000912",
      ownershipCommandId: "00000000-0000-4000-8000-000000000913",
      taskId,
      projectId,
      expectedProjectVersion: 1,
      expectedRoutingBindingVersion: 1,
      title: "Persist Task",
      sourceText: "Persist without execution.",
    };
    expect(
      sentValues(await session.receive(frame(rpc("task-create", "task.create", createParams))))[0],
    ).toMatchObject({ kind: "response", result: { status: "created", taskId } });
    expect(createProjectTask).toHaveBeenCalledWith(createParams);

    const detailParams = { projectId, taskId };
    expect(
      sentValues(await session.receive(frame(rpc("task-detail", "task.detail", detailParams))))[0],
    ).toMatchObject({ kind: "response", result: { taskId, taskVersion: 1 } });
    expect(readProjectTaskDetail).toHaveBeenCalledWith(detailParams);

    const reviseParams = {
      commandId: "00000000-0000-4000-8000-000000000914",
      projectId,
      taskId,
      expectedTaskVersion: 1,
      expectedOwnershipVersion: 1,
      previousRequirementRevisionId: "00000000-0000-4000-8000-000000000912",
      sourceText: "Persist the revised Requirement.",
    };
    expect(
      sentValues(
        await session.receive(frame(rpc("task-revise", "task.requirement.revise", reviseParams))),
      )[0],
    ).toMatchObject({ kind: "response", result: { status: "revised", taskId } });
    expect(reviseProjectTaskRequirement).toHaveBeenCalledWith(reviseParams);

    const missing = createSession();
    await authenticate(missing);
    expect(
      sentValues(
        await missing.receive(frame(rpc("task-missing", "task.catalog_page", catalogParams))),
      )[0],
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.unavailable } });
  });

  it("awaits candidate Plan generation and preserves request order", async () => {
    let resolveGeneration!: (value: JsonValue) => void;
    const generateProjectTaskCandidatePlan = vi.fn(
      async () =>
        await new Promise<JsonValue>((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const session = createSession({ generateProjectTaskCandidatePlan, uptimeMs: () => 10 });
    await authenticate(session);
    const params = {
      commandId: "00000000-0000-4000-8000-000000000921",
      projectId: "00000000-0000-4000-8000-000000000922",
      taskId: "00000000-0000-4000-8000-000000000923",
      expectedProjectVersion: 1,
      expectedTaskVersion: 1,
      expectedOwnershipVersion: 1,
      previousRequirementRevisionId: "00000000-0000-4000-8000-000000000924",
      previousPlanRevisionId: null,
      expectedRoutingBindingVersion: 1,
      expectedProfileVersion: 1,
      expectedConfigurationRevisionId: "00000000-0000-4000-8000-000000000925",
    };
    const actionsPromise = session.receive(
      joinedFrames(
        rpc("plan-1", "task.plan.generate_candidate", params),
        rpc("health-after-plan", "system.health", {}),
      ),
    );
    await vi.waitFor(() => expect(generateProjectTaskCandidatePlan).toHaveBeenCalledWith(params));
    resolveGeneration({ schemaVersion: 1, status: "generated", taskId: params.taskId });

    const values = sentValues(await actionsPromise);
    expect(values.map((value) => (value as { id?: string }).id)).toEqual([
      "plan-1",
      "health-after-plan",
    ]);
    expect(values[0]).toMatchObject({ kind: "response", result: { status: "generated" } });
  });

  it("fails closed on authentication failure without echoing secrets", async () => {
    const session = createSession();
    const wrongCapability = `${"B".repeat(42)}A`;
    const actions = await session.receive(frame(hello(wrongCapability)));
    const serialized = JSON.stringify(sentValues(actions));
    expect(serialized).not.toContain(STARTUP_CAPABILITY);
    expect(serialized).not.toContain(wrongCapability);
    expect(sentValues(actions)[0]).toMatchObject({
      kind: "bootstrap-error",
      error: { code: RPC_ERROR_CODES.authenticationFailed },
    });
    expect(actions.at(-1)).toEqual({ type: "close", reason: "authentication_failed" });
    expect(session.state).toBe("closed");
  });

  it("rejects RPC before hello and repeated hello after authentication", async () => {
    const beforeHello = createSession();
    const firstActions = await beforeHello.receive(frame(rpc("health-1", "system.health", {})));
    expect(sentValues(firstActions)[0]).toMatchObject({
      kind: "bootstrap-error",
      error: { code: RPC_ERROR_CODES.invalidMessage },
    });
    expect(beforeHello.state).toBe("closed");

    const repeated = createSession();
    await authenticate(repeated);
    const repeatedActions = await repeated.receive(frame(hello()));
    expect(sentValues(repeatedActions)[0]).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.invalidMessage },
    });
    expect(repeated.state).toBe("closed");
  });

  it("marks resume attempts for conservative resynchronization", async () => {
    const session = createSession();
    const response = sentValues(await session.receive(frame(hello(STARTUP_CAPABILITY, true))))[0];
    expect(response).toMatchObject({
      result: { stream: { id: STREAM_ID, resyncRequired: true } },
    });
  });

  it("publishes only authenticated account events with a strictly increasing sequence", async () => {
    const session = createSession();
    expect(session.publishEvent("account.status_changed", ACCOUNT_STATUS)).toEqual([]);
    await authenticate(session);

    const first = sentValues(session.publishEvent("account.status_changed", ACCOUNT_STATUS))[0];
    const second = sentValues(session.publishEvent("account.status_changed", ACCOUNT_STATUS))[0];

    expect(first).toMatchObject({
      kind: "event",
      streamId: STREAM_ID,
      sequence: 1,
      method: "account.status_changed",
      params: ACCOUNT_STATUS,
    });
    expect(second).toMatchObject({ sequence: 2 });
    expect(parseServerRpcEnvelope(first).ok).toBe(true);
    expect(session.state).toBe("authenticated");
  });

  it("fails closed instead of publishing an unknown or malformed trusted event", async () => {
    const unknown = createSession();
    await authenticate(unknown);
    const unknownActions = unknown.publishEvent("future.event", ACCOUNT_STATUS);
    expect(sentValues(unknownActions)[0]).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.internalError },
    });
    expect(unknownActions.at(-1)).toEqual({ type: "close", reason: "internal_error" });
    expect(unknown.state).toBe("closed");

    const malformed = createSession();
    await authenticate(malformed);
    const malformedActions = malformed.publishEvent("account.status_changed", {
      ...ACCOUNT_STATUS,
      email: "private@example.com",
    });
    expect(malformedActions.at(-1)).toEqual({ type: "close", reason: "internal_error" });
    expect(JSON.stringify(sentValues(malformedActions))).not.toContain("private@example.com");
  });

  it("fails closed when version or required capability negotiation fails", async () => {
    const unsupportedVersion = createSession();
    const versionActions = await unsupportedVersion.receive(
      frame(hello(STARTUP_CAPABILITY, false, { versions: ["2.0"] })),
    );
    expect(sentValues(versionActions)[0]).toMatchObject({
      kind: "bootstrap-error",
      error: { code: RPC_ERROR_CODES.unsupportedProtocolVersion },
    });
    expect(versionActions.at(-1)).toEqual({ type: "close", reason: "protocol_violation" });

    const unsupportedCapability = createSession();
    const capabilityActions = await unsupportedCapability.receive(
      frame(
        hello(STARTUP_CAPABILITY, false, {
          supportedCapabilities: ["harness.events.replay.v1"],
          requiredCapabilities: ["harness.events.replay.v1"],
        }),
      ),
    );
    expect(sentValues(capabilityActions)[0]).toMatchObject({
      kind: "bootstrap-error",
      error: { code: RPC_ERROR_CODES.unsupportedCapability },
    });
    expect(capabilityActions.at(-1)).toEqual({
      type: "close",
      reason: "protocol_violation",
    });
  });

  it("emits one shutdown request and rejects later work while closing", async () => {
    const session = createSession();
    await authenticate(session);
    const shutdownActions = await session.receive(
      frame(rpc("shutdown-1", "system.shutdown", { reason: "user.requested" })),
    );
    expect(sentValues(shutdownActions)[0]).toMatchObject({
      kind: "response",
      id: "shutdown-1",
      result: { accepted: true },
    });
    expect(shutdownActions).toContainEqual({
      type: "shutdown_requested",
      reason: "user.requested",
    });
    expect(session.state).toBe("closing");

    const laterActions = await session.receive(frame(rpc("health-2", "system.health", {})));
    expect(sentValues(laterActions)[0]).toMatchObject({
      kind: "error",
      id: "health-2",
      error: { code: RPC_ERROR_CODES.unavailable },
    });
    expect(laterActions.some((action) => action.type === "shutdown_requested")).toBe(false);
  });

  it("does not enter closing state for invalid shutdown parameters", async () => {
    const session = createSession();
    await authenticate(session);
    const actions = await session.receive(
      frame(rpc("shutdown-invalid", "system.shutdown", { reason: "not valid" })),
    );
    expect(sentValues(actions)[0]).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.invalidParams },
    });
    expect(actions.some((action) => action.type === "shutdown_requested")).toBe(false);
    expect(session.state).toBe("authenticated");
  });

  it("keeps unknown methods non-fatal", async () => {
    const session = createSession();
    await authenticate(session);
    const actions = await session.receive(frame(rpc("future-1", "future.method", {})));
    expect(sentValues(actions)[0]).toMatchObject({
      kind: "error",
      id: "future-1",
      error: { code: RPC_ERROR_CODES.methodNotFound },
    });
    expect(session.state).toBe("authenticated");
  });

  it("reports injected internal failures without blaming the peer", async () => {
    const invalidRandomSource = new ConnectionSession({
      startupCapability: STARTUP_CAPABILITY,
      serverVersion: "0.0.0",
      streamIdFactory: () => "invalid-stream-id",
    });
    const bootstrapActions = await invalidRandomSource.receive(frame(hello()));
    expect(sentValues(bootstrapActions)[0]).toEqual({
      kind: "bootstrap-error",
      wireVersion: BOOTSTRAP_WIRE_VERSION,
      id: null,
      error: {
        code: RPC_ERROR_CODES.internalError,
        message: "An internal error occurred.",
      },
    });
    expect(bootstrapActions.at(-1)).toEqual({ type: "close", reason: "internal_error" });

    let clockFails = false;
    const failingClock = createSession({
      uptimeMs: () => {
        if (clockFails) {
          throw new Error("private clock detail");
        }
        return 1_000;
      },
    });
    await authenticate(failingClock);
    clockFails = true;
    const rpcActions = await failingClock.receive(frame(rpc("health-clock", "system.health", {})));
    expect(sentValues(rpcActions)[0]).toMatchObject({
      kind: "error",
      id: null,
      error: {
        code: RPC_ERROR_CODES.internalError,
        message: "An internal error occurred.",
      },
    });
    expect(JSON.stringify(sentValues(rpcActions))).not.toContain("private clock detail");
    expect(rpcActions.at(-1)).toEqual({ type: "close", reason: "internal_error" });
  });

  it("closes on invalid UTF-8 and reports truncated EOF conservatively", async () => {
    const invalidUtf8 = createSession();
    await authenticate(invalidUtf8);
    const invalidActions = await invalidUtf8.receive(Uint8Array.of(0xff, 0x0a));
    expect(invalidActions.at(-1)).toEqual({ type: "close", reason: "protocol_violation" });
    expect(invalidUtf8.state).toBe("closed");

    const truncated = createSession();
    expect(await truncated.receive(encoder.encode("partial"))).toEqual([]);
    expect(truncated.end()).toEqual([{ type: "close", reason: "truncated_frame" }]);
  });

  it("never throws for arbitrary byte input", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 8192 }), async (input) => {
        const session = createSession();
        await expect(session.receive(input)).resolves.toBeDefined();
      }),
      { numRuns: 500 },
    );
  });
});
