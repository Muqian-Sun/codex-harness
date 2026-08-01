import { describe, expect, it } from "vitest";

import { AppServerProtocolAdapter } from "./adapter.js";

function initializedAdapter(): AppServerProtocolAdapter {
  const adapter = new AppServerProtocolAdapter();
  const initialize = adapter.beginInitialize({
    name: "codex-harness",
    title: "Codex Harness",
    version: "0.0.0",
  });
  expect(initialize.ok).toBe(true);
  if (!initialize.ok) {
    throw new Error("initialize request was not created");
  }
  expect(initialize.value.params).toEqual({
    clientInfo: {
      name: "codex-harness",
      title: "Codex Harness",
      version: "0.0.0",
    },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  expect(
    adapter.accept({
      kind: "success",
      id: initialize.value.id,
      result: {
        userAgent: "codex_cli_rs/0.146.0-alpha.9.2",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    }),
  ).toMatchObject({ ok: true, value: { type: "initialized" } });
  expect(adapter.state).toBe("awaiting_initialized");
  expect(adapter.completeInitialize()).toEqual({
    ok: true,
    value: { method: "initialized" },
  });
  expect(adapter.state).toBe("ready");
  return adapter;
}

describe("App Server protocol adapter", () => {
  it("rejects server traffic outside the initialized connection state", () => {
    const adapter = new AppServerProtocolAdapter();
    expect(adapter.accept({ kind: "notification", method: "warning", params: {} })).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });

    const initialize = adapter.beginInitialize({
      name: "codex-harness",
      title: null,
      version: "0.0.0",
    });
    expect(initialize.ok).toBe(true);
    expect(
      adapter.accept({ kind: "request", id: "server-1", method: "unknown", params: {} }),
    ).toMatchObject({ ok: false, error: { code: "not_ready" } });
  });

  it("enforces initialize ordering and correlates stable requests", () => {
    const adapter = new AppServerProtocolAdapter();
    expect(adapter.createRequest("model/list", {})).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });

    const ready = initializedAdapter();
    const request = ready.createRequest("thread/read", {
      threadId: "019-test-thread",
      includeTurns: true,
    });
    expect(request.ok).toBe(true);
    if (!request.ok) {
      throw new Error("thread/read request was not created");
    }
    expect(
      ready.accept({
        kind: "success",
        id: request.value.id,
        result: { thread: { id: "019-test-thread", futureField: true } },
      }),
    ).toEqual({
      ok: true,
      value: {
        type: "request_completed",
        request: { id: request.value.id, method: "thread/read" },
        result: { thread: { id: "019-test-thread", futureField: true } },
      },
    });
    expect(ready.pendingRequestCount).toBe(0);
  });

  it("deep-freezes validated outgoing parameters", () => {
    const adapter = initializedAdapter();
    const request = adapter.createRequest("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(request.ok).toBe(true);
    if (!request.ok) {
      throw new Error("turn/start request was not created");
    }
    expect(Object.isFrozen(request.value.params)).toBe(true);
    const params = request.value.params as {
      input: Array<{ text_elements: unknown[] }>;
      sandboxPolicy: { type: string };
    };
    expect(Object.isFrozen(params.input)).toBe(true);
    expect(Object.isFrozen(params.input[0]?.text_elements)).toBe(true);
    expect(Object.isFrozen(params.sandboxPolicy)).toBe(true);
  });

  it("preserves unknown notifications for forward compatibility", () => {
    const adapter = initializedAdapter();
    expect(
      adapter.accept({
        kind: "notification",
        method: "future/event",
        params: { newField: "value" },
      }),
    ).toEqual({
      ok: true,
      value: {
        type: "notification",
        method: "future/event",
        params: { newField: "value" },
      },
    });
  });

  it("surfaces server requests but never approves them", () => {
    const adapter = initializedAdapter();
    expect(
      adapter.accept({
        kind: "request",
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: { command: "git status" },
      }),
    ).toEqual({
      ok: true,
      value: {
        type: "server_request",
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: { command: "git status" },
        disposition: "command_approval",
      },
    });
  });

  it("redacts upstream errors and closes on malformed successful results", () => {
    const adapter = initializedAdapter();
    const failedRequest = adapter.createRequest("model/list", {});
    expect(failedRequest.ok).toBe(true);
    if (!failedRequest.ok) {
      throw new Error("model/list request was not created");
    }
    expect(
      adapter.accept({
        kind: "error",
        id: failedRequest.value.id,
        error: {
          code: -32_000,
          message: "secret path /private/example",
          data: { secret: "token" },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        type: "request_failed",
        request: { id: failedRequest.value.id, method: "model/list" },
        error: { code: -32_000, message: "The App Server request failed." },
      },
    });

    const malformedRequest = adapter.createRequest("thread/read", { threadId: "thread-1" });
    expect(malformedRequest.ok).toBe(true);
    if (!malformedRequest.ok) {
      throw new Error("thread/read request was not created");
    }
    expect(
      adapter.accept({ kind: "success", id: malformedRequest.value.id, result: {} }),
    ).toMatchObject({ ok: false, error: { code: "invalid_response" } });
    expect(adapter.state).toBe("closed");
  });

  it("returns pending work when closed and then rejects more work", () => {
    const adapter = initializedAdapter();
    const request = adapter.createRequest("model/list", {});
    expect(request.ok).toBe(true);
    expect(adapter.close()).toHaveLength(1);
    expect(adapter.state).toBe("closed");
    expect(adapter.createRequest("model/list", {})).toMatchObject({
      ok: false,
      error: { code: "closed" },
    });
  });
});
