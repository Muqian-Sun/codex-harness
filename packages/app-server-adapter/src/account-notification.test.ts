import { describe, expect, it } from "vitest";

import { parseAppServerAccountNotification } from "./account-notification.js";

describe("App Server account notifications", () => {
  it("reduces valid account updates to a payload-free invalidation signal", () => {
    const result = parseAppServerAccountNotification("account/updated", {
      authMode: "chatgpt",
      planType: "pro",
      email: "private@example.com",
      accessToken: "must-not-survive",
    });

    expect(result).toEqual({ kind: "signal" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private@example.com");
    expect(JSON.stringify(result)).not.toContain("must-not-survive");
  });

  it.each([
    "apikey",
    "chatgpt",
    "chatgptAuthTokens",
    "headers",
    "agentIdentity",
    "personalAccessToken",
    "bedrockApiKey",
  ])("accepts the fixed auth mode %s", (authMode) => {
    expect(parseAppServerAccountNotification("account/updated", { authMode })).toEqual({
      kind: "signal",
    });
  });

  it.each([
    "free",
    "go",
    "plus",
    "pro",
    "prolite",
    "team",
    "self_serve_business_usage_based",
    "business",
    "ent26",
    "enterprise_cbp_usage_based",
    "enterprise",
    "edu",
    "unknown",
  ])("accepts the fixed plan type %s", (planType) => {
    expect(parseAppServerAccountNotification("account/updated", { planType })).toEqual({
      kind: "signal",
    });
  });

  it.each([{}, { authMode: null }, { planType: null }])(
    "accepts omitted and nullable fixed fields",
    (params) => {
      expect(parseAppServerAccountNotification("account/updated", params)).toEqual({
        kind: "signal",
      });
    },
  );

  it.each([
    undefined,
    null,
    [],
    { authMode: "future-auth-mode" },
    { planType: "future-plan" },
    { authMode: 7 },
  ])("rejects malformed known account updates", (params) => {
    expect(parseAppServerAccountNotification("account/updated", params)).toEqual({
      kind: "invalid",
    });
  });

  it("leaves unknown notifications unrecognized", () => {
    expect(parseAppServerAccountNotification("future/account-event", { account: null })).toEqual({
      kind: "unrecognized",
    });
  });
});
