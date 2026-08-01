import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_APP_SERVER_METHODS,
  EXPLICITLY_SENSITIVE_APP_SERVER_METHODS,
  classifyServerRequest,
  validateMethodParams,
} from "./methods.js";

describe("App Server method policy", () => {
  it("exposes only the stable Harness subset", () => {
    expect(ALLOWED_APP_SERVER_METHODS).toEqual([
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
