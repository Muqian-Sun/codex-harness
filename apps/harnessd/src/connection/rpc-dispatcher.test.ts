import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  RPC_ERROR_CODES,
  type RpcRequest,
} from "@codex-harness/protocol";
import { describe, expect, it, vi } from "vitest";

import { dispatchRpcRequest, type RpcDispatchContext } from "./rpc-dispatcher.js";

const ACCOUNT_STATUS = Object.freeze({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000811",
  workerSessionId: "00000000-0000-4000-8000-000000000812",
  observedAtMs: 1_750_000_000_001,
  status: "authenticated",
  credentialKind: "chatgpt",
  planType: "plus",
});

const MODEL_CATALOG_PAGE = Object.freeze({
  schemaVersion: 1,
  provider: "openai",
  totalVisibleModels: 1,
  models: Object.freeze([
    Object.freeze({
      model: "gpt-model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium"]),
      inputModalities: Object.freeze(["text"]),
    }),
  ]),
  nextCursor: null,
});

function request(method: string, params: unknown = {}): RpcRequest {
  return {
    kind: "request",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id: "request-1",
    method,
    params,
  } as RpcRequest;
}

function context(
  readAccountStatus: () => unknown,
  readModelCatalogPage: (params: unknown) => unknown = () => MODEL_CATALOG_PAGE,
): RpcDispatchContext {
  return {
    streamId: `${"A".repeat(21)}A`,
    uptimeMs: 1,
    closing: false,
    readAccountStatus,
    readModelCatalogPage,
  };
}

describe("RPC dispatcher account status", () => {
  it("returns an exact validated snapshot only for the account method", () => {
    const readAccountStatus = vi.fn(() => ACCOUNT_STATUS);
    const dispatched = dispatchRpcRequest(request("account.status"), context(readAccountStatus));

    expect(dispatched).toMatchObject({
      envelope: { kind: "response", id: "request-1", result: ACCOUNT_STATUS },
      shutdownRequested: false,
    });
    expect(readAccountStatus).toHaveBeenCalledTimes(1);

    dispatchRpcRequest(request("system.health"), context(readAccountStatus));
    expect(readAccountStatus).toHaveBeenCalledTimes(1);
  });

  it("returns a stable unavailable error for absent, invalid, or throwing providers", () => {
    for (const readAccountStatus of [
      () => null,
      () => ({ ...ACCOUNT_STATUS, email: "private@example.com" }),
      () => {
        throw new Error("private provider detail");
      },
    ]) {
      const dispatched = dispatchRpcRequest(request("account.status"), context(readAccountStatus));
      expect(dispatched.envelope).toMatchObject({
        kind: "error",
        id: "request-1",
        error: {
          code: RPC_ERROR_CODES.unavailable,
          message: "The account status is unavailable.",
        },
      });
      expect(JSON.stringify(dispatched)).not.toContain("private");
    }
  });

  it("does not consult the provider while the connection is closing", () => {
    const readAccountStatus = vi.fn(() => ACCOUNT_STATUS);
    const dispatched = dispatchRpcRequest(request("account.status"), {
      ...context(readAccountStatus),
      closing: true,
    });

    expect(dispatched.envelope).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.unavailable },
    });
    expect(readAccountStatus).not.toHaveBeenCalled();
  });
});

describe("RPC dispatcher model catalog", () => {
  it("passes validated page parameters to the provider and validates the result", () => {
    const readModelCatalogPage = vi.fn(() => MODEL_CATALOG_PAGE);
    const params = { cursor: null, limit: 12 };
    const dispatched = dispatchRpcRequest(
      request("model.catalog_page", params),
      context(() => ACCOUNT_STATUS, readModelCatalogPage),
    );

    expect(dispatched).toMatchObject({
      envelope: { kind: "response", id: "request-1", result: MODEL_CATALOG_PAGE },
      shutdownRequested: false,
    });
    expect(readModelCatalogPage).toHaveBeenCalledWith(params);
  });

  it("returns a fixed unavailable error for an invalid or throwing catalog provider", () => {
    for (const readModelCatalogPage of [
      () => ({ ...MODEL_CATALOG_PAGE, internalModelId: "private-id" }),
      () => {
        throw new Error("private catalog detail");
      },
    ]) {
      const dispatched = dispatchRpcRequest(
        request("model.catalog_page", { cursor: null, limit: 12 }),
        context(() => ACCOUNT_STATUS, readModelCatalogPage),
      );
      expect(dispatched.envelope).toMatchObject({
        kind: "error",
        id: "request-1",
        error: {
          code: RPC_ERROR_CODES.unavailable,
          message: "The model catalog is unavailable.",
        },
      });
      expect(JSON.stringify(dispatched)).not.toContain("private");
    }
  });

  it("rejects invalid parameters before consulting the catalog provider", () => {
    const readModelCatalogPage = vi.fn(() => MODEL_CATALOG_PAGE);
    const dispatched = dispatchRpcRequest(
      request("model.catalog_page", { cursor: null, limit: 17 }),
      context(() => ACCOUNT_STATUS, readModelCatalogPage),
    );

    expect(dispatched.envelope).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.invalidParams },
    });
    expect(readModelCatalogPage).not.toHaveBeenCalled();
  });
});
