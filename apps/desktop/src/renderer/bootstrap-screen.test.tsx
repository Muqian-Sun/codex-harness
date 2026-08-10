import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BootstrapScreen,
  createRoutingDraftInputUpdate,
  projectBindingFeedback,
} from "./bootstrap-screen.js";

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

const UNCONFIGURED_ROUTING = Object.freeze({
  configured: false,
  profileVersion: 0,
  configurationRevisionId: null,
  tiers: null,
  availability: null,
});

const CONFIGURED_ROUTING = Object.freeze({
  configured: true,
  profileVersion: 1,
  configurationRevisionId: "00000000-0000-4000-8000-000000000881",
  tiers: Object.freeze({
    fast: Object.freeze({ provider: "openai", model: "gpt-fast", reasoningEffort: "low" }),
    standard: Object.freeze({
      provider: "openai",
      model: "gpt-standard",
      reasoningEffort: "medium",
    }),
    deep: Object.freeze({ provider: "openai", model: "gpt-standard", reasoningEffort: "high" }),
  }),
  availability: Object.freeze({
    fast: "observed_available" as const,
    standard: "observed_available" as const,
    deep: "observed_available" as const,
  }),
});

const EMPTY_PROJECTS = Object.freeze({ projects: Object.freeze([]), hasMore: false });
const EMPTY_PROJECT_ROUTING_BINDINGS = Object.freeze({ bindings: Object.freeze([]) });
const PROJECTS = Object.freeze({
  projects: Object.freeze([
    Object.freeze({
      projectId: "00000000-0000-4000-8000-000000000891",
      projectVersion: 1 as const,
      displayName: "workspace<script>",
      workspace: Object.freeze({
        platform: "macos" as const,
        absolutePath: "/Users/example/workspace<script>",
        identityStatus: "unverified" as const,
      }),
    }),
  ]),
  hasMore: false,
});
const PROJECT_ROUTING_BINDINGS = Object.freeze({
  bindings: Object.freeze([
    Object.freeze({
      projectId: PROJECTS.projects[0]!.projectId,
      status: "unbound" as const,
      bindingVersion: null,
    }),
  ]),
});

describe("desktop bootstrap screen", () => {
  it.each([
    ["idle", true, undefined],
    ["idle", false, "请先保存完整三级模型配置，再为 Project 绑定默认路由。"],
    ["binding", true, "正在校验 Project、绑定版本与当前路由配置。"],
    ["bound", true, "Project 已绑定默认路由；执行权限仍未开放。"],
    ["existing", true, "Project 已处于相同默认路由绑定，无需重复写入。"],
    ["conflict", true, "绑定或路由配置已变化，已刷新权威状态，请重新确认。"],
    ["routing_unconfigured", true, "默认路由尚未配置，请先保存完整三级模型配置。"],
    ["unavailable", true, "当前无法确认绑定结果，请刷新或重启后核对。"],
  ] as const)("formats stable %s binding feedback", (status, configured, expected) => {
    expect(projectBindingFeedback(status, configured)).toBe(expected);
  });

  it("captures routing input before React runs the state updater", () => {
    const draft = Object.freeze({
      fast: Object.freeze({ model: "", reasoningEffort: "" }),
      standard: Object.freeze({ model: "", reasoningEffort: "" }),
      deep: Object.freeze({ model: "", reasoningEffort: "" }),
    });
    const modelInput = { value: "gpt-fast" };
    const effortInput = { value: "low" };

    const updateModel = createRoutingDraftInputUpdate("fast", "model", modelInput);
    const updateEffort = createRoutingDraftInputUpdate("fast", "reasoningEffort", effortInput);
    modelInput.value = "changed-after-handler";
    effortInput.value = "changed-after-handler";

    const updated = updateEffort(updateModel(draft));
    expect(updated.fast).toEqual({ model: "gpt-fast", reasoningEffort: "low" });
    expect(updated.standard).toBe(draft.standard);
    expect(updated.deep).toBe(draft.deep);
  });

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
            routing: UNCONFIGURED_ROUTING,
            projects: EMPTY_PROJECTS,
            projectRoutingBindings: EMPTY_PROJECT_ROUTING_BINDINGS,
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
          routing: CONFIGURED_ROUTING,
          projects: PROJECTS,
          projectRoutingBindings: PROJECT_ROUTING_BINDINGS,
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
    expect(markup).toContain('data-routing-configured="true"');
    expect(markup).toContain('data-routing-revision="1"');
    expect(markup).toContain('data-routing-tier="fast"');
    expect(markup).toContain('data-routing-availability="observed_available"');
    expect(markup).toContain("保存路由配置");
    expect(markup).toContain("EXECUTION LOCKED");
    expect(markup).toContain('data-project-count="1"');
    expect(markup).toContain('data-project-identity="unverified"');
    expect(markup).toContain("UNVERIFIED IDENTITY");
    expect(markup).toContain("workspace&lt;script&gt;");
    expect(markup).not.toContain("workspace<script>");
    expect(markup).toContain("添加工作区");
    expect(markup).toContain('data-project-routing="unbound"');
    expect(markup).toContain('data-project-routing-status="unbound"');
    expect(markup).toContain("ROUTING UNBOUND");
    expect(markup).toContain("绑定默认路由");
  });

  it("renders a stable empty observation when Codex reports no visible model", () => {
    const markup = renderToStaticMarkup(
      <BootstrapScreen
        state={{
          phase: "ready",
          account: { status: "not_required", credentialKind: null, planType: null },
          catalog: { provider: "openai", totalVisibleModels: 0, models: [], hasMore: false },
          routing: UNCONFIGURED_ROUTING,
          projects: EMPTY_PROJECTS,
          projectRoutingBindings: EMPTY_PROJECT_ROUTING_BINDINGS,
        }}
      />,
    );

    expect(markup).toContain("当前 Codex 会话没有报告可见模型");
    expect(markup).toContain('data-model-catalog-count="0"');
    expect(markup).toContain('data-routing-configured="false"');
    expect(markup).toContain("尚未校验");
    expect(markup).toContain("disabled");
    expect(markup).toContain("尚未注册 Project");
  });

  it.each([
    ["default_bound", 2, "DEFAULT ROUTING", "已绑定默认路由", true],
    ["other_profile_bound", 3, "OTHER PROFILE", "切换到默认路由", false],
  ] as const)(
    "renders the %s Project routing state without exposing profile identity",
    (status, bindingVersion, badge, action, disabled) => {
      const markup = renderToStaticMarkup(
        <BootstrapScreen
          state={{
            phase: "ready",
            account: { status: "authenticated", credentialKind: "chatgpt", planType: "plus" },
            catalog: CATALOG,
            routing: CONFIGURED_ROUTING,
            projects: PROJECTS,
            projectRoutingBindings: {
              bindings: [{ projectId: PROJECTS.projects[0]!.projectId, status, bindingVersion }],
            },
          }}
        />,
      );

      expect(markup).toContain(`data-project-routing="${status}"`);
      expect(markup).toContain(badge);
      expect(markup).toContain(action);
      expect(markup).toContain(`策略引用 · V${bindingVersion}`);
      if (disabled) {
        expect(markup).toMatch(/data-project-routing-bind="[^"]+" disabled=""/u);
      }
      expect(markup).not.toContain("00000000-0000-4000-8000-000000000901");
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
