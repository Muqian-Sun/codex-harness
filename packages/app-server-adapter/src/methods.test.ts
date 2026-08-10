import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_APP_SERVER_METHODS,
  EXPLICITLY_SENSITIVE_APP_SERVER_METHODS,
  classifyServerRequest,
  validateMethodParams,
  validateMethodResult,
} from "./methods.js";

describe("App Server method policy", () => {
  it("exposes only the stable Harness subset", () => {
    expect(ALLOWED_APP_SERVER_METHODS).toEqual([
      "account/read",
      "model/list",
      "thread/start",
      "thread/resume",
      "thread/fork",
      "thread/read",
      "thread/list",
      "thread/compact/start",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ]);
    expect(EXPLICITLY_SENSITIVE_APP_SERVER_METHODS).toContain("thread/shellCommand");
    expect(validateMethodParams("thread/shellCommand", {})).toMatchObject({
      ok: false,
      error: { code: "unsupported_method" },
    });
    expect(validateMethodParams("model/list", null)).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });

  it("allows only a non-refreshing account observation and strips sensitive response fields", () => {
    expect(validateMethodParams("account/read", { refreshToken: false })).toMatchObject({
      ok: true,
      value: { refreshToken: false },
    });
    for (const params of [{}, { refreshToken: true }, { refreshToken: false, extra: true }]) {
      expect(validateMethodParams("account/read", params)).toMatchObject({
        ok: false,
        error: { code: "invalid_params" },
      });
    }

    expect(
      validateMethodResult("account/read", {
        account: {
          type: "chatgpt",
          email: "private@example.com",
          planType: "plus",
          accessToken: "must-not-survive",
        },
        requiresOpenaiAuth: true,
        futureSecret: "must-not-survive",
      }),
    ).toEqual({
      ok: true,
      value: {
        account: { type: "chatgpt", planType: "plus" },
        requiresOpenaiAuth: true,
      },
    });
    expect(
      validateMethodResult("account/read", {
        account: { type: "futureAccount" },
        requiresOpenaiAuth: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_response" } });
    expect(
      validateMethodResult("account/read", {
        account: { type: "chatgpt", email: null, planType: "future-plan" },
        requiresOpenaiAuth: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_response" } });
  });

  it("rejects unsafe sandbox and raw configuration overrides", () => {
    expect(validateMethodParams("thread/start", { sandbox: "danger-full-access" })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(validateMethodParams("thread/start", { config: { foo: true } })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(
      validateMethodParams("turn/start", {
        threadId: "thread-1",
        input: [{ type: "text", text: "hello", text_elements: [] }],
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_params" } });

    const outputSchema = {
      type: "object",
      required: ["kind"],
      properties: { kind: { type: "string" } },
      additionalProperties: false,
    };
    const validated = validateMethodParams("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema,
    });
    expect(validated).toMatchObject({ ok: true, value: { outputSchema } });
    if (!validated.ok) {
      throw new Error("turn/start parameters were not validated");
    }
    expect(Object.isFrozen((validated.value as { outputSchema: unknown }).outputSchema)).toBe(true);
  });

  it("classifies approval requests without deciding them", () => {
    expect(classifyServerRequest("item/commandExecution/requestApproval")).toBe("command_approval");
    expect(classifyServerRequest("mcpServer/elicitation/request")).toBe("mcp_elicitation");
    expect(classifyServerRequest("item/tool/call")).toBe("dynamic_tool");
    expect(classifyServerRequest("experimental/unknown")).toBe("unsupported");
    expect(classifyServerRequest("__proto__")).toBe("unsupported");
    expect(classifyServerRequest("constructor")).toBe("unsupported");
  });

  it("never throws while validating untrusted parameters", () => {
    fc.assert(
      fc.property(fc.anything(), (params) => {
        expect(() => validateMethodParams("model/list", params)).not.toThrow();
      }),
    );

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "limit", {
      enumerable: true,
      get() {
        throw new Error("must not escape validation");
      },
    });
    expect(validateMethodParams("model/list", accessor)).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });
});
