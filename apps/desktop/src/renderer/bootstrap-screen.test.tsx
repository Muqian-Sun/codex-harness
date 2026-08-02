import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BootstrapScreen } from "./bootstrap-screen.js";

describe("desktop bootstrap screen", () => {
  it.each([
    ["starting", "正在建立受控运行时"],
    ["stopping", "正在关闭受控进程"],
  ] as const)("renders the %s state without claiming execution is available", (phase, title) => {
    const markup = renderToStaticMarkup(<BootstrapScreen state={{ phase }} />);

    expect(markup).toContain(`data-bootstrap-phase="${phase}"`);
    expect(markup).toContain(title);
    expect(markup).toContain("Execution");
    expect(markup).toContain("Locked");
  });

  it.each([
    ["authentication_required", null, null, "需要认证", "未检测到", "不适用"],
    ["not_required", null, null, "无需认证", "未检测到", "不适用"],
    ["authenticated", "api_key", null, "已认证", "API Key", "不适用"],
    ["authenticated", "amazon_bedrock", null, "已认证", "Amazon Bedrock", "不适用"],
    ["authenticated", "chatgpt", "plus", "已认证", "ChatGPT", "Plus"],
  ] as const)(
    "renders the %s account observation without exposing raw account data",
    (status, credentialKind, planType, statusLabel, credentialLabel, planLabel) => {
      const markup = renderToStaticMarkup(
        <BootstrapScreen
          state={{ phase: "ready", account: { status, credentialKind, planType } }}
        />,
      );

      expect(markup).toContain('data-bootstrap-phase="ready"');
      expect(markup).toContain(`data-account-status="${status}"`);
      expect(markup).toContain(
        `data-account-credential="${credentialKind === null ? "none" : credentialKind}"`,
      );
      expect(markup).toContain(
        `data-account-plan="${planType === null ? "not_applicable" : planType}"`,
      );
      expect(markup).toContain(statusLabel);
      expect(markup).toContain(credentialLabel);
      expect(markup).toContain(planLabel);
      expect(markup).toContain("Execution");
      expect(markup).toContain("Locked");
      expect(markup).not.toContain("email");
      expect(markup).not.toContain("snapshotId");
      expect(markup).not.toContain("workerSessionId");
    },
  );

  it("renders only the stable failure code", () => {
    const markup = renderToStaticMarkup(
      <BootstrapScreen state={{ phase: "failed", code: "daemon_startup_failed" }} />,
    );

    expect(markup).toContain('data-bootstrap-code="daemon_startup_failed"');
    expect(markup).toContain("启动已安全停止");
  });
});
