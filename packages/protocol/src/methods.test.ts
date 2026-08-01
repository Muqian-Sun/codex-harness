import { describe, expect, it } from "vitest";

import { INTERNAL_ERROR_PUBLIC_MESSAGE } from "./constants.js";
import { createInternalErrorResponse } from "./internal-error.js";
import { decodeRequestParams, decodeResponseResult } from "./methods.js";
import { TEST_STREAM_ID } from "./test-fixtures.js";

describe("method contracts", () => {
  it("validates health and shutdown parameters and results", () => {
    expect(decodeRequestParams("system.health", {}).ok).toBe(true);
    expect(decodeRequestParams("system.health", { unexpected: true }).ok).toBe(false);
    expect(
      decodeResponseResult("system.health", {
        status: "ok",
        streamId: TEST_STREAM_ID,
        uptimeMs: 0,
        futureField: true,
      }).ok,
    ).toBe(true);
    expect(decodeRequestParams("system.shutdown", { reason: "user_exit" }).ok).toBe(true);
    expect(decodeRequestParams("system.shutdown", { reason: "user exit" }).ok).toBe(false);
    expect(decodeRequestParams("system.shutdown", { reason: "" }).ok).toBe(false);
    expect(decodeResponseResult("system.shutdown", { accepted: true }).ok).toBe(true);
  });

  it("rejects unknown methods and method-specific mismatches", () => {
    expect(decodeRequestParams("unknown.method", {}).ok).toBe(false);
    expect(decodeResponseResult("system.health", { status: "bad" }).ok).toBe(false);
  });
});

describe("internal error responses", () => {
  it("emits only a fixed public message and correlation ID", () => {
    const sentinel = "sentinel-secret-stack-and-environment";
    const runtimeError = new Error(sentinel);
    const response = createInternalErrorResponse("request-1", "correlation-1", runtimeError);

    expect(response.error.message).toBe(INTERNAL_ERROR_PUBLIC_MESSAGE);
    expect(JSON.stringify(response)).not.toContain(runtimeError.message);
    expect(response.error.data).toEqual({ correlationId: "correlation-1" });
  });

  it("rejects invalid trusted identifiers without echoing them", () => {
    const sentinel = "invalid id sentinel";
    expect(() => createInternalErrorResponse(sentinel, "correlation-1")).toThrow(
      "Invalid RPC response identifier.",
    );
    expect(() => createInternalErrorResponse("request-1", sentinel)).toThrow(
      "Invalid internal error correlation identifier.",
    );
  });
});
