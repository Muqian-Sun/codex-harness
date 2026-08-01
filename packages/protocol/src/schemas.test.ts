import { describe, expect, it } from "vitest";

import {
  APPLICATION_PROTOCOL_VERSION,
  APPLICATION_VERSION_PATTERN,
  BOOTSTRAP_WIRE_VERSION,
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  MAX_APPLICATION_VERSION_COUNT,
  MAX_APPLICATION_VERSION_BYTES,
  MAX_NAMESPACED_TOKEN_BYTES,
  MAX_RPC_ID_BYTES,
  RPC_ERROR_CODES,
} from "./constants.js";
import {
  ApplicationVersionSchema,
  BootstrapErrorResponseSchema,
  RpcErrorCodeSchema,
  RpcErrorResponseSchema,
  RpcEventSchema,
  RpcIdSchema,
  MethodNameSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  StartupCapabilitySchema,
  StreamIdSchema,
  SystemHelloParamsSchema,
  SystemHelloResultSchema,
} from "./schemas.js";
import { createHelloParams, createRpcRequest, TEST_STREAM_ID } from "./test-fixtures.js";

describe("protocol schemas", () => {
  it("accepts every known error code and future well-formed codes", () => {
    for (const code of Object.values(RPC_ERROR_CODES)) {
      expect(RpcErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(RpcErrorCodeSchema.safeParse("vendor.future_code").success).toBe(true);
  });

  it("enforces error-code and application-version grammar boundaries", () => {
    expect(RpcErrorCodeSchema.safeParse("UPPER.invalid").success).toBe(false);
    expect(RpcErrorCodeSchema.safeParse(`a${"b".repeat(MAX_NAMESPACED_TOKEN_BYTES)}`).success).toBe(
      false,
    );
    expect(ApplicationVersionSchema.safeParse("1.0").success).toBe(true);
    expect(ApplicationVersionSchema.safeParse("1.0.0-alpha.1").success).toBe(true);
    expect(APPLICATION_VERSION_PATTERN.test("01.0")).toBe(false);
    expect(
      ApplicationVersionSchema.safeParse(`1.${"0".repeat(MAX_APPLICATION_VERSION_BYTES)}`).success,
    ).toBe(false);
  });

  it("enforces RPC identifier and method-name byte boundaries", () => {
    expect(RpcIdSchema.safeParse("").success).toBe(false);
    expect(RpcIdSchema.safeParse("a").success).toBe(true);
    expect(RpcIdSchema.safeParse("a".repeat(MAX_RPC_ID_BYTES)).success).toBe(true);
    expect(RpcIdSchema.safeParse("a".repeat(MAX_RPC_ID_BYTES + 1)).success).toBe(false);
    expect(RpcIdSchema.safeParse("invalid id").success).toBe(false);

    expect(MethodNameSchema.safeParse("").success).toBe(false);
    expect(MethodNameSchema.safeParse("a").success).toBe(true);
    expect(
      MethodNameSchema.safeParse(`a${"b".repeat(MAX_NAMESPACED_TOKEN_BYTES - 1)}`).success,
    ).toBe(true);
    expect(MethodNameSchema.safeParse(`a${"b".repeat(MAX_NAMESPACED_TOKEN_BYTES)}`).success).toBe(
      false,
    );
    expect(MethodNameSchema.safeParse("System.Health").success).toBe(false);
  });

  it("requires client required capabilities to be a unique supported subset", () => {
    const valid = createHelloParams();
    valid.capabilities.required = ["harness.events.replay.v1"];
    expect(SystemHelloParamsSchema.safeParse(valid).success).toBe(true);

    const missing = createHelloParams();
    missing.capabilities.required = ["harness.approvals.v1"];
    expect(SystemHelloParamsSchema.safeParse(missing).success).toBe(false);

    const duplicate = createHelloParams();
    duplicate.capabilities.supported = ["harness.events.replay.v1", "harness.events.replay.v1"];
    expect(SystemHelloParamsSchema.safeParse(duplicate).success).toBe(false);
  });

  it("validates startup capability and resume boundaries", () => {
    const valid = createHelloParams();
    valid.resume = { streamId: TEST_STREAM_ID, lastSequence: 0 };
    expect(SystemHelloParamsSchema.safeParse(valid).success).toBe(true);

    for (const lastSequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidSequence = createHelloParams();
      invalidSequence.resume = { streamId: TEST_STREAM_ID, lastSequence };
      expect(SystemHelloParamsSchema.safeParse(invalidSequence).success).toBe(false);
    }

    const invalidStream = createHelloParams();
    invalidStream.resume = { streamId: "short", lastSequence: 0 };
    expect(SystemHelloParamsSchema.safeParse(invalidStream).success).toBe(false);

    const invalidResumeShape = createHelloParams() as ReturnType<typeof createHelloParams> & {
      resume: { streamId: string; lastSequence: number; unexpected: boolean };
    };
    invalidResumeShape.resume = {
      streamId: TEST_STREAM_ID,
      lastSequence: 0,
      unexpected: true,
    };
    expect(SystemHelloParamsSchema.safeParse(invalidResumeShape).success).toBe(false);

    const invalidCapability = createHelloParams();
    invalidCapability.startupCapability = "_".repeat(42) + "!";
    expect(SystemHelloParamsSchema.safeParse(invalidCapability).success).toBe(false);

    expect(StartupCapabilitySchema.safeParse("A".repeat(42) + "E").success).toBe(true);
    expect(StartupCapabilitySchema.safeParse("A".repeat(42) + "B").success).toBe(false);
    expect(StreamIdSchema.safeParse("B".repeat(21) + "Q").success).toBe(true);
    expect(StreamIdSchema.safeParse("B".repeat(21) + "B").success).toBe(false);
  });

  it("requires between one and the configured maximum application versions", () => {
    const empty = createHelloParams();
    empty.supportedProtocolVersions = [];
    expect(SystemHelloParamsSchema.safeParse(empty).success).toBe(false);

    const atLimit = createHelloParams();
    atLimit.supportedProtocolVersions = Array.from(
      { length: MAX_APPLICATION_VERSION_COUNT },
      (_, index) => `1.${index}`,
    );
    expect(SystemHelloParamsSchema.safeParse(atLimit).success).toBe(true);

    const overLimit = createHelloParams();
    overLimit.supportedProtocolVersions = Array.from(
      { length: MAX_APPLICATION_VERSION_COUNT + 1 },
      (_, index) => `1.${index}`,
    );
    expect(SystemHelloParamsSchema.safeParse(overLimit).success).toBe(false);
  });

  it("enforces stream counters and their cross-field relationship", () => {
    const valid = {
      selectedProtocolVersion: APPLICATION_PROTOCOL_VERSION,
      server: { name: "harnessd", version: "0.0.0" },
      enabledCapabilities: [],
      stream: {
        id: TEST_STREAM_ID,
        nextSequence: 2,
        replayWindowStart: 1,
        resyncRequired: false,
      },
    };
    expect(SystemHelloResultSchema.safeParse(valid).success).toBe(true);
    expect(
      SystemHelloResultSchema.safeParse({
        ...valid,
        stream: { ...valid.stream, replayWindowStart: 3 },
      }).success,
    ).toBe(false);
    for (const sequence of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        RpcEventSchema.safeParse({
          kind: "event",
          wireVersion: BOOTSTRAP_WIRE_VERSION,
          protocolVersion: APPLICATION_PROTOCOL_VERSION,
          streamId: TEST_STREAM_ID,
          sequence,
          method: "system.ready",
          params: {},
        }).success,
      ).toBe(false);
    }
  });

  it("keeps requests strict while accepting unknown response fields", () => {
    expect(RpcRequestSchema.safeParse({ ...createRpcRequest(), unexpected: true }).success).toBe(
      false,
    );
    expect(
      RpcResponseSchema.safeParse({
        kind: "response",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: "request-1",
        result: {},
        futureField: true,
      }).success,
    ).toBe(true);
  });

  it("uses the open error-code schema for bootstrap errors", () => {
    expect(
      BootstrapErrorResponseSchema.safeParse({
        kind: "bootstrap-error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        id: null,
        error: { code: "vendor.future_error", message: "Unavailable" },
      }).success,
    ).toBe(true);

    for (const code of [
      RPC_ERROR_CODES.methodNotFound,
      RPC_ERROR_CODES.invalidParams,
      RPC_ERROR_CODES.conflict,
    ]) {
      expect(
        BootstrapErrorResponseSchema.safeParse({
          kind: "bootstrap-error",
          wireVersion: BOOTSTRAP_WIRE_VERSION,
          id: null,
          error: { code, message: "Invalid during bootstrap" },
        }).success,
      ).toBe(false);
    }
  });

  it("accepts valid application response, error, and event envelopes", () => {
    expect(
      RpcResponseSchema.safeParse({
        kind: "response",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: "request-1",
        result: { status: "ok" },
      }).success,
    ).toBe(true);
    expect(
      RpcErrorResponseSchema.safeParse({
        kind: "error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: "request-1",
        error: {
          code: "vendor.future_error",
          message: "Unavailable",
          futureErrorField: true,
        },
        futureEnvelopeField: true,
      }).success,
    ).toBe(true);
    expect(
      RpcEventSchema.safeParse({
        kind: "event",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        streamId: TEST_STREAM_ID,
        sequence: 1,
        method: "system.ready",
        params: {},
        futureEnvelopeField: true,
      }).success,
    ).toBe(true);
  });

  it("enforces restricted internal errors for bootstrap and application envelopes", () => {
    const unsafeError = {
      code: RPC_ERROR_CODES.internalError,
      message: "sentinel-secret",
      data: { stack: "sentinel-stack" },
    };

    expect(
      BootstrapErrorResponseSchema.safeParse({
        kind: "bootstrap-error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        id: null,
        error: unsafeError,
      }).success,
    ).toBe(false);
    expect(
      BootstrapErrorResponseSchema.safeParse({
        kind: "bootstrap-error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        id: null,
        error: {
          code: RPC_ERROR_CODES.internalError,
          message: INTERNAL_ERROR_PUBLIC_MESSAGE,
          data: { correlationId: "correlation-1" },
        },
      }).success,
    ).toBe(true);

    expect(
      RpcErrorResponseSchema.safeParse({
        kind: "error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: "request-1",
        error: unsafeError,
      }).success,
    ).toBe(false);

    expect(
      RpcErrorResponseSchema.safeParse({
        kind: "error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: "request-1",
        error: {
          code: RPC_ERROR_CODES.internalError,
          message: INTERNAL_ERROR_PUBLIC_MESSAGE,
          data: { correlationId: "correlation-1" },
        },
      }).success,
    ).toBe(true);

    expect(
      RpcErrorResponseSchema.safeParse({
        kind: "error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: "request-1",
        error: {
          code: RPC_ERROR_CODES.internalError,
          message: INTERNAL_ERROR_PUBLIC_MESSAGE,
          data: { correlationId: "correlation-1", unexpected: true },
        },
      }).success,
    ).toBe(false);
  });
});
