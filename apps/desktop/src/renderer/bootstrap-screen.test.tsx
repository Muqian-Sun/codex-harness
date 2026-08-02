import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BootstrapScreen } from "./bootstrap-screen.js";

const CATALOG = Object.freeze({
  provider: "openai",
  totalVisibleModels: 2,
  models: Object.freeze([
    Object.freeze({
      model: "gpt-standard",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high"]),
      inputModalities: Object.freeze(["text", "image"] as const),
    }),
    Object.freeze({
      model: "gpt-fast",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: Object.freeze(["low"]),
      inputModalities: Object.freeze(["text"] as const),
    }),
  ]),
  hasMore: false,
});

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
          state={{
            phase: "ready",
            account: { status, credentialKind, planType },
            catalog: CATALOG,
          }}
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
      expect(markup).toContain("实时去敏观察");
      expect(markup).toContain('aria-label="当前账户观察"');
      expect(markup).not.toContain("email");
      expect(markup).not.toContain("snapshotId");
      expect(markup).not.toContain("workerSessionId");
    },
  );

  it("renders the observed model roster without claiming configuration or leaking cursors", () => {
    const markup = renderToStaticMarkup(
      <BootstrapScreen
        state={{
          phase: "ready",
          account: { status: "authenticated", credentialKind: "chatgpt", planType: "plus" },
          catalog: { ...CATALOG, totalVisibleModels: 5, hasMore: true },
        }}
      />,
    );

    expect(markup).toContain('data-model-catalog-provider="openai"');
    expect(markup).toContain('data-model-catalog-count="5"');
    expect(markup).toContain('data-model-name="gpt-standard"');
    expect(markup).toContain("medium");
    expect(markup).toContain("Image");
    expect(markup).toContain("OBSERVED · READ ONLY");
    expect(markup).toContain("另有 3 个可见模型未在首屏展开");
    expect(markup).not.toContain("nextCursor");
    expect(markup).not.toContain("snapshotId");
    expect(markup).not.toContain("workerSessionId");
  });

  it("renders a stable empty observation when Codex reports no visible model", () => {
    const markup = renderToStaticMarkup(
      <BootstrapScreen
        state={{
          phase: "ready",
          account: { status: "not_required", credentialKind: null, planType: null },
          catalog: { provider: "openai", totalVisibleModels: 0, models: [], hasMore: false },
        }}
      />,
    );

    expect(markup).toContain("当前 Codex 会话没有报告可见模型");
    expect(markup).toContain('data-model-catalog-count="0"');
  });

  it("renders only the stable failure code", () => {
    const markup = renderToStaticMarkup(
      <BootstrapScreen state={{ phase: "failed", code: "daemon_startup_failed" }} />,
    );

    expect(markup).toContain('data-bootstrap-code="daemon_startup_failed"');
    expect(markup).toContain("启动已安全停止");
  });
});
