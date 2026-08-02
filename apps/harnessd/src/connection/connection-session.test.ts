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
import { describe, expect, it } from "vitest";

import { ConnectionSession, type ConnectionSessionAction } from "./connection-session.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STARTUP_CAPABILITY = "A".repeat(43);
const STREAM_ID = `${"B".repeat(21)}A`;

function createSession(options?: {
  uptimeMs?: () => number;
  readAccountStatus?: () => unknown;
}): ConnectionSession {
  return new ConnectionSession({
    startupCapability: STARTUP_CAPABILITY,
    serverVersion: "0.0.0",
    streamIdFactory: () => STREAM_ID,
    ...(options?.uptimeMs === undefined ? {} : { uptimeMs: options.uptimeMs }),
    ...(options?.readAccountStatus === undefined
      ? {}
      : { readAccountStatus: options.readAccountStatus }),
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

function authenticate(session: ConnectionSession): JsonValue {
  const actions = session.receive(frame(hello(), true));
  expect(actions).toHaveLength(1);
  const values = sentValues(actions);
  expect(values).toHaveLength(1);
  expect(parseServerBootstrapEnvelope(values[0]).ok).toBe(true);
  expect(session.state).toBe("authenticated");
  return values[0] as JsonValue;
}

describe("daemon connection session", () => {
  it("authenticates a fragmented hello before accepting RPC", () => {
    const session = createSession();
    const encoded = frame(hello());
    const split = Math.floor(encoded.byteLength / 2);
    expect(session.receive(encoded.subarray(0, split))).toEqual([]);
    const actions = session.receive(encoded.subarray(split));
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

  it("processes hello and health frames in order from one chunk", () => {
    const session = createSession({ uptimeMs: () => 1_250.9 });
    const actions = session.receive(joinedFrames(hello(), rpc("health-1", "system.health", {})));
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

  it("serves a validated account snapshot after authentication", () => {
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
    authenticate(session);

    const actions = session.receive(frame(rpc("account-1", "account.status", {})));
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

  it("fails closed on authentication failure without echoing secrets", () => {
    const session = createSession();
    const wrongCapability = `${"B".repeat(42)}A`;
    const actions = session.receive(frame(hello(wrongCapability)));
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

  it("rejects RPC before hello and repeated hello after authentication", () => {
    const beforeHello = createSession();
    const firstActions = beforeHello.receive(frame(rpc("health-1", "system.health", {})));
    expect(sentValues(firstActions)[0]).toMatchObject({
      kind: "bootstrap-error",
      error: { code: RPC_ERROR_CODES.invalidMessage },
    });
    expect(beforeHello.state).toBe("closed");

    const repeated = createSession();
    authenticate(repeated);
    const repeatedActions = repeated.receive(frame(hello()));
    expect(sentValues(repeatedActions)[0]).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.invalidMessage },
    });
    expect(repeated.state).toBe("closed");
  });

  it("marks resume attempts for conservative resynchronization", () => {
    const session = createSession();
    const response = sentValues(session.receive(frame(hello(STARTUP_CAPABILITY, true))))[0];
    expect(response).toMatchObject({
      result: { stream: { id: STREAM_ID, resyncRequired: true } },
    });
  });

  it("fails closed when version or required capability negotiation fails", () => {
    const unsupportedVersion = createSession();
    const versionActions = unsupportedVersion.receive(
      frame(hello(STARTUP_CAPABILITY, false, { versions: ["2.0"] })),
    );
    expect(sentValues(versionActions)[0]).toMatchObject({
      kind: "bootstrap-error",
      error: { code: RPC_ERROR_CODES.unsupportedProtocolVersion },
    });
    expect(versionActions.at(-1)).toEqual({ type: "close", reason: "protocol_violation" });

    const unsupportedCapability = createSession();
    const capabilityActions = unsupportedCapability.receive(
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

  it("emits one shutdown request and rejects later work while closing", () => {
    const session = createSession();
    authenticate(session);
    const shutdownActions = session.receive(
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

    const laterActions = session.receive(frame(rpc("health-2", "system.health", {})));
    expect(sentValues(laterActions)[0]).toMatchObject({
      kind: "error",
      id: "health-2",
      error: { code: RPC_ERROR_CODES.unavailable },
    });
    expect(laterActions.some((action) => action.type === "shutdown_requested")).toBe(false);
  });

  it("does not enter closing state for invalid shutdown parameters", () => {
    const session = createSession();
    authenticate(session);
    const actions = session.receive(
      frame(rpc("shutdown-invalid", "system.shutdown", { reason: "not valid" })),
    );
    expect(sentValues(actions)[0]).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.invalidParams },
    });
    expect(actions.some((action) => action.type === "shutdown_requested")).toBe(false);
    expect(session.state).toBe("authenticated");
  });

  it("keeps unknown methods non-fatal", () => {
    const session = createSession();
    authenticate(session);
    const actions = session.receive(frame(rpc("future-1", "future.method", {})));
    expect(sentValues(actions)[0]).toMatchObject({
      kind: "error",
      id: "future-1",
      error: { code: RPC_ERROR_CODES.methodNotFound },
    });
    expect(session.state).toBe("authenticated");
  });

  it("reports injected internal failures without blaming the peer", () => {
    const invalidRandomSource = new ConnectionSession({
      startupCapability: STARTUP_CAPABILITY,
      serverVersion: "0.0.0",
      streamIdFactory: () => "invalid-stream-id",
    });
    const bootstrapActions = invalidRandomSource.receive(frame(hello()));
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
    authenticate(failingClock);
    clockFails = true;
    const rpcActions = failingClock.receive(frame(rpc("health-clock", "system.health", {})));
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

  it("closes on invalid UTF-8 and reports truncated EOF conservatively", () => {
    const invalidUtf8 = createSession();
    authenticate(invalidUtf8);
    const invalidActions = invalidUtf8.receive(Uint8Array.of(0xff, 0x0a));
    expect(invalidActions.at(-1)).toEqual({ type: "close", reason: "protocol_violation" });
    expect(invalidUtf8.state).toBe("closed");

    const truncated = createSession();
    expect(truncated.receive(encoder.encode("partial"))).toEqual([]);
    expect(truncated.end()).toEqual([{ type: "close", reason: "truncated_frame" }]);
  });

  it("never throws for arbitrary byte input", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 8192 }), (input) => {
        const session = createSession();
        expect(() => session.receive(input)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});
