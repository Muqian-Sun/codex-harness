import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_APP_SERVER_FRAME_BYTES, parseAppServerJson, parseAppServerMessage } from "./wire.js";

describe("App Server wire parser", () => {
  it("classifies requests, notifications, successes, and errors", () => {
    expect(
      parseAppServerMessage({ id: "1", method: "turn/start", params: { threadId: "t" } }),
    ).toEqual({
      ok: true,
      value: {
        kind: "request",
        id: "1",
        method: "turn/start",
        params: { threadId: "t" },
      },
    });
    expect(parseAppServerMessage({ method: "turn/started", params: { turn: {} } })).toEqual({
      ok: true,
      value: {
        kind: "notification",
        method: "turn/started",
        params: { turn: {} },
      },
    });
    expect(parseAppServerMessage({ id: "2", result: {} })).toEqual({
      ok: true,
      value: { kind: "success", id: "2", result: {} },
    });
    expect(parseAppServerMessage({ id: 3, error: { code: -32601, message: "not found" } })).toEqual(
      {
        ok: true,
        value: {
          kind: "error",
          id: 3,
          error: { code: -32601, message: "not found", data: undefined },
        },
      },
    );
  });

  it("rejects JSON-RPC 2.0 markers and ambiguous envelopes", () => {
    expect(parseAppServerMessage({ jsonrpc: "2.0", id: "1", result: {} })).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    });
    expect(parseAppServerMessage({ id: "1", result: {}, error: {} })).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    });
    expect(parseAppServerJson("not-json")).toMatchObject({
      ok: false,
      error: { code: "invalid_json" },
    });
    expect(parseAppServerJson("")).toMatchObject({
      ok: false,
      error: { code: "empty_frame" },
    });
    expect(parseAppServerJson("x".repeat(MAX_APP_SERVER_FRAME_BYTES + 1))).toMatchObject({
      ok: false,
      error: { code: "frame_too_large" },
    });
  });

  it("never throws for arbitrary values", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => parseAppServerMessage(input)).not.toThrow();
      }),
    );
  });
});
