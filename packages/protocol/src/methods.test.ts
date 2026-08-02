import { describe, expect, it } from "vitest";

import { INTERNAL_ERROR_PUBLIC_MESSAGE } from "./constants.js";
import { createInternalErrorResponse } from "./internal-error.js";
import {
  ACCOUNT_PLAN_TYPES,
  MAX_MODEL_CATALOG_PAGE_SIZE,
  MAX_MODEL_REASONING_EFFORTS,
  decodeEventParams,
  decodeRequestParams,
  decodeResponseResult,
} from "./methods.js";
import { TEST_STREAM_ID } from "./test-fixtures.js";

describe("method contracts", () => {
  it("strictly validates account status parameters, fields, and semantic invariants", () => {
    const base = {
      schemaVersion: 1,
      snapshotId: "00000000-0000-4000-8000-000000000801",
      workerSessionId: "00000000-0000-4000-8000-000000000802",
      observedAtMs: 1_750_000_000_001,
    } as const;

    expect(decodeRequestParams("account.status", {}).ok).toBe(true);
    expect(decodeRequestParams("account.status", { refresh: true }).ok).toBe(false);
    expect(
      decodeResponseResult("account.status", {
        ...base,
        status: "authentication_required",
        credentialKind: null,
        planType: null,
      }).ok,
    ).toBe(true);
    expect(
      decodeResponseResult("account.status", {
        ...base,
        status: "not_required",
        credentialKind: null,
        planType: null,
      }).ok,
    ).toBe(true);
    for (const credentialKind of ["api_key", "amazon_bedrock"] as const) {
      expect(
        decodeResponseResult("account.status", {
          ...base,
          status: "authenticated",
          credentialKind,
          planType: null,
        }).ok,
      ).toBe(true);
    }
    for (const planType of ACCOUNT_PLAN_TYPES) {
      expect(
        decodeResponseResult("account.status", {
          ...base,
          status: "authenticated",
          credentialKind: "chatgpt",
          planType,
        }).ok,
      ).toBe(true);
    }

    for (const invalid of [
      { ...base, status: "authenticated", credentialKind: null, planType: null },
      { ...base, status: "not_required", credentialKind: "api_key", planType: null },
      { ...base, status: "authenticated", credentialKind: "api_key", planType: "plus" },
      {
        ...base,
        status: "authenticated",
        credentialKind: "chatgpt",
        planType: "plus",
        email: "private@example.com",
      },
      {
        ...base,
        snapshotId: "invalid",
        status: "authentication_required",
        credentialKind: null,
        planType: null,
      },
    ]) {
      expect(decodeResponseResult("account.status", invalid).ok).toBe(false);
    }
  });

  it("strictly validates bounded model catalog page parameters and results", () => {
    const cursor = `00000000-0000-4000-8000-000000000821.${Buffer.from("model-1").toString("base64url")}`;
    const entry = {
      model: "gpt-model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
      inputModalities: ["image", "text"],
    } as const;
    const result = {
      schemaVersion: 1,
      provider: "openai",
      totalVisibleModels: 2,
      models: [entry],
      nextCursor: cursor,
    } as const;

    expect(decodeRequestParams("model.catalog_page", { cursor: null, limit: 12 }).ok).toBe(true);
    expect(decodeRequestParams("model.catalog_page", { cursor, limit: 1 }).ok).toBe(true);
    expect(decodeResponseResult("model.catalog_page", result).ok).toBe(true);
    expect(
      decodeResponseResult("model.catalog_page", {
        ...result,
        models: [],
        nextCursor: null,
        totalVisibleModels: 0,
      }).ok,
    ).toBe(true);

    for (const invalid of [
      { cursor: null, limit: 0 },
      { cursor: null, limit: MAX_MODEL_CATALOG_PAGE_SIZE + 1 },
      { cursor: "not-a-cursor", limit: 1 },
      { cursor: null, limit: 1, unexpected: true },
    ]) {
      expect(decodeRequestParams("model.catalog_page", invalid).ok).toBe(false);
    }

    for (const invalid of [
      { ...result, unexpected: true },
      { ...result, models: [], nextCursor: cursor },
      { ...result, totalVisibleModels: 0 },
      { ...result, models: [entry, entry], totalVisibleModels: 2, nextCursor: null },
      {
        ...result,
        models: [{ ...entry, defaultReasoningEffort: "xhigh" }],
        nextCursor: null,
      },
      {
        ...result,
        models: [{ ...entry, inputModalities: ["text", "text"] }],
        nextCursor: null,
      },
      {
        ...result,
        models: [
          {
            ...entry,
            supportedReasoningEfforts: Array.from(
              { length: MAX_MODEL_REASONING_EFFORTS + 1 },
              (_, index) => `effort-${String(index)}`,
            ),
          },
        ],
        nextCursor: null,
      },
    ]) {
      expect(decodeResponseResult("model.catalog_page", invalid).ok).toBe(false);
    }
  });

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

  it("strictly validates the account status changed event contract", () => {
    const valid = {
      schemaVersion: 1,
      snapshotId: "00000000-0000-4000-8000-000000000811",
      workerSessionId: "00000000-0000-4000-8000-000000000812",
      observedAtMs: 1_750_000_000_002,
      status: "authenticated",
      credentialKind: "chatgpt",
      planType: "pro",
    } as const;

    for (const planType of ACCOUNT_PLAN_TYPES) {
      expect(decodeEventParams("account.status_changed", { ...valid, planType }).ok).toBe(true);
    }
    expect(
      decodeEventParams("account.status_changed", { ...valid, email: "private@example.com" }).ok,
    ).toBe(false);
    expect(
      decodeEventParams("account.status_changed", {
        ...valid,
        credentialKind: "api_key",
        planType: "pro",
      }).ok,
    ).toBe(false);
    expect(decodeEventParams("future.event", valid)).toMatchObject({
      ok: false,
      error: { code: "unknown_event" },
    });
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
