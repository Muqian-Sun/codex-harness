import { TextEncoder } from "node:util";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  MAX_FRAME_BYTES,
} from "./constants.js";
import {
  decodeClientBootstrapFrame,
  decodeClientRpcFrame,
  decodeServerBootstrapFrame,
  decodeServerRpcFrame,
  parseClientBootstrapEnvelope,
  parseClientRpcEnvelope,
  parseServerBootstrapEnvelope,
  parseServerRpcEnvelope,
} from "./parser.js";
import {
  createBootstrapRequest,
  createBootstrapResponse,
  createRpcRequest,
  TEST_STREAM_ID,
} from "./test-fixtures.js";

const encoder = new TextEncoder();

describe("role-aware envelope parsing", () => {
  it("accepts envelopes only in their allowed direction", () => {
    const request = createBootstrapRequest();
    const response = createBootstrapResponse();

    expect(parseClientBootstrapEnvelope(request).ok).toBe(true);
    expect(parseServerBootstrapEnvelope(response).ok).toBe(true);
    expect(
      parseServerBootstrapEnvelope({
        kind: "bootstrap-error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        id: "hello-1",
        error: { code: "service.unavailable", message: "Unavailable" },
      }).ok,
    ).toBe(true);
    expect(parseClientBootstrapEnvelope(response).ok).toBe(false);
    expect(parseServerBootstrapEnvelope(request).ok).toBe(false);

    const rpcRequest = createRpcRequest();
    const rpcResponse = {
      kind: "response",
      wireVersion: "1",
      protocolVersion: "1.0",
      id: "request-1",
      result: {},
    };
    expect(parseClientRpcEnvelope(rpcRequest).ok).toBe(true);
    expect(parseServerRpcEnvelope(rpcResponse).ok).toBe(true);
    expect(parseClientRpcEnvelope(rpcResponse).ok).toBe(false);
    expect(parseServerRpcEnvelope(rpcRequest).ok).toBe(false);
    expect(
      parseServerRpcEnvelope({
        kind: "error",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        id: "request-1",
        error: { code: "service.unavailable", message: "Unavailable" },
      }).ok,
    ).toBe(true);
    expect(
      parseServerRpcEnvelope({
        kind: "event",
        wireVersion: BOOTSTRAP_WIRE_VERSION,
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        streamId: TEST_STREAM_ID,
        sequence: 1,
        method: "system.ready",
        params: {},
      }).ok,
    ).toBe(true);
  });

  it("returns redacted failures for invalid secrets", () => {
    const request = createBootstrapRequest();
    const sentinel = "sentinel-secret-that-must-not-appear";
    request.params.startupCapability = sentinel;

    const result = parseClientBootstrapEnvelope(request);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("rejects unknown kinds and application protocol mismatches", () => {
    expect(
      parseClientBootstrapEnvelope({
        ...createBootstrapRequest(),
        kind: "future-bootstrap-kind",
      }).ok,
    ).toBe(false);
    expect(
      parseClientRpcEnvelope({
        ...createRpcRequest(),
        protocolVersion: "2.0",
      }).ok,
    ).toBe(false);
  });

  it("rejects non-JSON runtime payload values", () => {
    expect(
      parseClientRpcEnvelope({
        ...createRpcRequest(),
        params: { value: Number.NaN },
      }).ok,
    ).toBe(false);
    expect(
      parseClientRpcEnvelope({
        ...createRpcRequest(),
        params: { value: undefined },
      }).ok,
    ).toBe(false);
  });

  it("does not throw for cyclic, deep, or property-generated values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => parseClientRpcEnvelope(cyclic)).not.toThrow();

    let deep: unknown = {};
    for (let index = 0; index < 100; index += 1) {
      deep = { nested: deep };
    }
    expect(() => parseClientRpcEnvelope(deep)).not.toThrow();

    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => parseClientRpcEnvelope(value)).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("raw frame decoding", () => {
  it("decodes valid UTF-8 JSON with an optional carriage return", () => {
    const encoded = encoder.encode(JSON.stringify(createBootstrapRequest()));
    expect(decodeClientBootstrapFrame(encoded).ok).toBe(true);

    const withCarriageReturn = new Uint8Array(encoded.length + 1);
    withCarriageReturn.set(encoded);
    withCarriageReturn[withCarriageReturn.length - 1] = 0x0d;
    expect(decodeClientBootstrapFrame(withCarriageReturn).ok).toBe(true);

    expect(
      decodeServerBootstrapFrame(encoder.encode(JSON.stringify(createBootstrapResponse()))).ok,
    ).toBe(true);
    expect(
      decodeServerRpcFrame(
        encoder.encode(
          JSON.stringify({
            kind: "event",
            wireVersion: BOOTSTRAP_WIRE_VERSION,
            protocolVersion: APPLICATION_PROTOCOL_VERSION,
            streamId: TEST_STREAM_ID,
            sequence: 1,
            method: "system.ready",
            params: {},
          }),
        ),
      ).ok,
    ).toBe(true);
    expect(decodeServerRpcFrame(encoder.encode(JSON.stringify(createRpcRequest()))).ok).toBe(false);
  });

  it("accepts valid JSON envelopes immediately below and at the frame limit", () => {
    const createPaddedFrame = (targetBytes: number): Uint8Array => {
      const request = createRpcRequest();
      request.params = { padding: "" };
      const empty = encoder.encode(JSON.stringify(request));
      const paddingLength = targetBytes - empty.byteLength;
      expect(paddingLength).toBeGreaterThan(0);
      request.params = { padding: "x".repeat(paddingLength) };
      const encoded = encoder.encode(JSON.stringify(request));
      expect(encoded.byteLength).toBe(targetBytes);
      return encoded;
    };

    expect(decodeClientRpcFrame(createPaddedFrame(MAX_FRAME_BYTES - 1)).ok).toBe(true);
    const exact = createPaddedFrame(MAX_FRAME_BYTES);
    expect(decodeClientRpcFrame(exact).ok).toBe(true);

    const exactWithCarriageReturn = new Uint8Array(exact.byteLength + 1);
    exactWithCarriageReturn.set(exact);
    exactWithCarriageReturn[exactWithCarriageReturn.length - 1] = 0x0d;
    expect(decodeClientRpcFrame(exactWithCarriageReturn).ok).toBe(true);
  });

  it("rejects empty, oversized, invalid UTF-8, and invalid JSON frames", () => {
    expect(decodeClientRpcFrame(new Uint8Array()).ok).toBe(false);

    const exactLimit = new Uint8Array(MAX_FRAME_BYTES).fill(0x20);
    const exactResult = decodeClientRpcFrame(exactLimit);
    expect(exactResult.ok).toBe(false);
    if (!exactResult.ok) {
      expect(exactResult.error.code).toBe("invalid_json");
    }

    const oversized = new Uint8Array(MAX_FRAME_BYTES + 1).fill(0x20);
    const oversizedResult = decodeClientRpcFrame(oversized);
    expect(oversizedResult.ok).toBe(false);
    if (!oversizedResult.ok) {
      expect(oversizedResult.error.code).toBe("frame_too_large");
    }

    const invalidUtf8 = decodeClientRpcFrame(Uint8Array.of(0xff));
    expect(invalidUtf8.ok).toBe(false);
    if (!invalidUtf8.ok) {
      expect(invalidUtf8.error.code).toBe("invalid_utf8");
    }

    const invalidJson = decodeClientRpcFrame(encoder.encode("not-json"));
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) {
      expect(invalidJson.error.code).toBe("invalid_json");
    }
  });

  it("rejects non-byte runtime input without throwing", () => {
    const decodeUnknown = decodeClientRpcFrame as unknown as (value: unknown) => unknown;
    expect(() => decodeUnknown(null)).not.toThrow();
  });
});
