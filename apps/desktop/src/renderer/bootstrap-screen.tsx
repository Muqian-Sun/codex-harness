import { useState } from "react";

import type {
  DesktopAccountPlanType,
  DesktopAccountStatus,
  DesktopBootstrapState,
  DesktopModelCatalogSummary,
  DesktopProjectCatalog,
  DesktopProjectSelectionResult,
  DesktopProjectSummary,
  DesktopRoutingAvailabilityStatus,
  DesktopRoutingConfiguration,
  DesktopRoutingConfigurationMutationResult,
  DesktopRoutingConfigurationUpdate,
  DesktopRoutingTier,
  DesktopRoutingTierTargets,
} from "../shared/bootstrap-state.js";

const credentialLabels = Object.freeze({
  amazon_bedrock: "Amazon Bedrock",
  api_key: "API Key",
  chatgpt: "ChatGPT",
});

const planLabels: Readonly<Record<DesktopAccountPlanType, string>> = Object.freeze({
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_usage_based: "Business（自助按量）",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise（按量）",
  enterprise: "Enterprise",
  edu: "Education",
  unknown: "方案未知",
});

const modalityLabels = Object.freeze({
  audio: "Audio",
  image: "Image",
  text: "Text",
});

const routingTierPresentation: Readonly<
  Record<DesktopRoutingTier, Readonly<{ index: string; title: string; summary: string }>>
> = Object.freeze({
  fast: Object.freeze({ index: "A", title: "FAST", summary: "低成本 · 简单任务" }),
  standard: Object.freeze({ index: "B", title: "STANDARD", summary: "代码编写 · 常规任务" }),
  deep: Object.freeze({ index: "C", title: "DEEP", summary: "架构决策 · 系统性问题" }),
});

const availabilityLabels: Readonly<Record<DesktopRoutingAvailabilityStatus, string>> =
  Object.freeze({
    observed_available: "当前可用",
    provider_unobserved: "Provider 未观察",
    model_unavailable: "模型不可用",
    reasoning_effort_unsupported: "推理强度不支持",
  });

const phasePresentation = Object.freeze({
  starting: Object.freeze({
    eyebrow: "CONTROL PLANE / BOOTSTRAP",
    title: "正在建立受控运行时",
    summary: "正在验证本地资源、启动 Harness daemon，并等待 Codex 模型目录完成校验。",
    label: "启动中",
    detail: "安全边界正在闭合",
  }),
  ready: Object.freeze({
    eyebrow: "CONTROL PLANE / READY",
    title: "Harness 已就绪",
    summary: "daemon、Codex App Server、首批可见模型与去敏账户观察已通过启动门禁。",
    label: "本地在线",
    detail: "受控进程链已连接",
  }),
  failed: Object.freeze({
    eyebrow: "CONTROL PLANE / ATTENTION",
    title: "运行时未能就绪",
    summary: "启动已安全停止。没有任务被执行，也不会自动重试或切换可执行文件。",
    label: "需要处理",
    detail: "故障已隔离",
  }),
  stopping: Object.freeze({
    eyebrow: "CONTROL PLANE / DRAINING",
    title: "正在关闭受控进程",
    summary: "Harness 正在排空连接，并确认 daemon 与 worker 已离开受控进程域。",
    label: "关闭中",
    detail: "正在验证进程包含",
  }),
});

export function BootstrapScreen({ state }: Readonly<{ state: DesktopBootstrapState }>) {
  const presentation = phasePresentation[state.phase];
  return (
    <main className={`shell phase-${state.phase}`} data-bootstrap-phase={state.phase}>
      <div className="atmosphere" aria-hidden="true" />
      <header className="masthead">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            CH
          </span>
          <div>
            <p className="product-name">Codex Harness</p>
            <p className="product-edition">LOCAL ORCHESTRATION LAYER</p>
          </div>
        </div>
        <div className="platform-chip">macOS · V1</div>
      </header>

      <section className="status-grid" aria-live="polite" aria-atomic="true">
        <div className="status-copy">
          <p className="eyebrow">{presentation.eyebrow}</p>
          <h1>{presentation.title}</h1>
          <p className="summary">{presentation.summary}</p>

          <div className="readiness-line">
            <span className="signal" aria-hidden="true">
              <span />
            </span>
            <div>
              <p className="readiness-label">{presentation.label}</p>
              <p className="readiness-detail">{presentation.detail}</p>
            </div>
          </div>

          {state.phase === "failed" ? (
            <p className="failure-code" data-bootstrap-code={state.code}>
              <span>故障代码</span>
              <code>{state.code}</code>
            </p>
          ) : null}
        </div>

        {state.phase === "ready" ? (
          <AccountObservationCard account={state.account} />
        ) : (
          <BoundaryCard />
        )}

        {state.phase === "ready" ? <ProjectRegistryPanel projects={state.projects} /> : null}

        {state.phase === "ready" ? (
          <RoutingConfigurationPanel routing={state.routing} catalog={state.catalog} />
        ) : null}

        {state.phase === "ready" ? <ModelCatalogSummary catalog={state.catalog} /> : null}
      </section>

      <footer className="footer-note">
        <span>
          工作区与路由配置可持久化；任务、TODO / DAG、实际模型选择与执行仍由后续安全门禁控制。
        </span>
        <span className="footer-rule" aria-hidden="true" />
        <span>LOCAL ONLY</span>
      </footer>
    </main>
  );
}

function ProjectRegistryPanel({ projects }: Readonly<{ projects: DesktopProjectCatalog }>) {
  const [selectionState, setSelectionState] = useState<
    "idle" | "choosing" | "registered" | "existing" | "unavailable"
  >("idle");
  const [selectedProject, setSelectedProject] = useState<DesktopProjectSummary | undefined>();

  const choose = async (): Promise<void> => {
    if (selectionState === "choosing") {
      return;
    }
    setSelectionState("choosing");
    setSelectedProject(undefined);
    try {
      const result = await desktopProjectApi().chooseProjectWorkspace();
      if (result.status === "cancelled") {
        setSelectionState("idle");
        return;
      }
      if (result.status === "selected") {
        setSelectedProject(result.project);
      }
      setSelectionState(result.status === "selected" ? result.registrationStatus : "unavailable");
    } catch {
      setSelectionState("unavailable");
    }
  };

  return (
    <section
      className="project-registry"
      aria-label="已注册工作区"
      data-project-count={String(projects.projects.length)}
    >
      <header className="project-header">
        <div>
          <p className="card-index">03 / PROJECT REGISTRY</p>
          <h2>工作区注册表</h2>
          <p>目录由原生选择器明确授予；当前只保存路径身份，不读取文件，也不授予执行权限。</p>
        </div>
        <button
          type="button"
          data-project-choose
          disabled={selectionState === "choosing"}
          onClick={choose}
        >
          {selectionState === "choosing" ? "正在打开目录选择器" : "添加工作区"}
        </button>
      </header>

      {projects.projects.length === 0 ? (
        <div className="project-empty">
          <strong>尚未注册 Project</strong>
          <span>选择一个本地目录，为后续 Task 归属建立稳定身份。</span>
        </div>
      ) : (
        <ol className="project-list">
          {projects.projects.map((project, index) => (
            <li key={project.projectId} data-project-id={project.projectId}>
              <span className="project-sequence">{String(index + 1).padStart(2, "0")}</span>
              <div className="project-identity">
                <strong>{project.displayName}</strong>
                <code data-project-path={project.workspace.absolutePath}>
                  {project.workspace.absolutePath}
                </code>
              </div>
              <div className="project-badges">
                <span data-project-platform={project.workspace.platform}>
                  {project.workspace.platform.toUpperCase()}
                </span>
                <span data-project-identity={project.workspace.identityStatus}>
                  UNVERIFIED IDENTITY
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}

      {selectedProject === undefined ? null : (
        <div className="project-selection" data-project-selected={selectedProject.projectId}>
          <span>本次选择</span>
          <strong>{selectedProject.displayName}</strong>
          <code>{selectedProject.workspace.absolutePath}</code>
        </div>
      )}

      <footer className="project-note" aria-live="polite">
        <span data-project-feedback>{projectSelectionFeedback(selectionState)}</span>
        <span>{projects.hasMore ? "另有 Project 未在首屏展开" : "EXECUTION LOCKED"}</span>
      </footer>
    </section>
  );
}

function projectSelectionFeedback(
  state: "idle" | "choosing" | "registered" | "existing" | "unavailable",
): string {
  switch (state) {
    case "idle":
      return "注册不代表目录已验证，也不会启动 Codex。";
    case "choosing":
      return "等待原生目录选择结果。";
    case "registered":
      return "工作区已持久化；Task 与执行仍未开放。";
    case "existing":
      return "该工作区已存在，已加载权威记录。";
    case "unavailable":
      return "当前无法确认注册结果，请重新选择或重启后核对。";
  }
}

type RoutingDraft = Readonly<
  Record<DesktopRoutingTier, Readonly<{ model: string; reasoningEffort: string }>>
>;

function RoutingConfigurationPanel({
  routing,
  catalog,
}: Readonly<{
  routing: DesktopRoutingConfiguration;
  catalog: DesktopModelCatalogSummary;
}>) {
  const [draft, setDraft] = useState<RoutingDraft>(() => initialRoutingDraft(routing));
  const [mutationState, setMutationState] = useState<
    "idle" | "saving" | "saved" | "conflict" | "unavailable"
  >("idle");
  const complete = (Object.keys(routingTierPresentation) as DesktopRoutingTier[]).every(
    (tier) => draft[tier].model.length > 0 && draft[tier].reasoningEffort.length > 0,
  );

  const save = async (): Promise<void> => {
    if (!complete || mutationState === "saving") {
      return;
    }
    setMutationState("saving");
    try {
      const result = await desktopRoutingApi().setRoutingConfiguration({
        expectedProfileVersion: routing.profileVersion,
        previousConfigurationRevisionId: routing.configurationRevisionId,
        tiers: buildRoutingTargets(catalog.provider, draft),
      });
      if (result.status !== "unavailable") {
        setDraft(initialRoutingDraft(result.routing));
      }
      setMutationState(result.status);
    } catch {
      setMutationState("unavailable");
    }
  };

  return (
    <section
      className="routing-matrix"
      aria-label="三级模型路由配置"
      data-routing-configured={String(routing.configured)}
      data-routing-revision={String(routing.profileVersion)}
    >
      <header className="routing-header">
        <div>
          <p className="card-index">04 / ROUTING MATRIX</p>
          <h2>三级模型控制台</h2>
          <p>模型与推理强度由用户明确配置；Harness 只保存精确映射，不根据名称猜测能力。</p>
        </div>
        <div className="routing-meta">
          <span>{catalog.provider}</span>
          <strong>V{routing.profileVersion.toString().padStart(2, "0")}</strong>
          <small>{routing.configured ? "PERSISTED" : "CONFIGURATION REQUIRED"}</small>
        </div>
      </header>

      <div className="routing-lanes">
        {(Object.keys(routingTierPresentation) as DesktopRoutingTier[]).map((tier) => {
          const lane = routingTierPresentation[tier];
          const model = catalog.models.find((entry) => entry.model === draft[tier].model);
          const efforts = model?.supportedReasoningEfforts ?? uniqueCatalogEfforts(catalog);
          const availability = routing.availability?.[tier];
          return (
            <fieldset className={`routing-lane tier-${tier}`} key={tier}>
              <legend>
                <span>{lane.index}</span>
                <strong>{lane.title}</strong>
                <small>{lane.summary}</small>
              </legend>
              <label>
                <span>PROVIDER</span>
                <output>{catalog.provider}</output>
              </label>
              <label>
                <span>MODEL</span>
                <input
                  data-routing-tier={tier}
                  data-routing-field="model"
                  value={draft[tier].model}
                  list="routing-model-options"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="输入精确模型名称"
                  onChange={(event) =>
                    setDraft(createRoutingDraftInputUpdate(tier, "model", event.currentTarget))
                  }
                />
              </label>
              <label>
                <span>REASONING EFFORT</span>
                <input
                  data-routing-tier={tier}
                  data-routing-field="reasoningEffort"
                  value={draft[tier].reasoningEffort}
                  list={`routing-efforts-${tier}`}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="输入精确推理强度"
                  onChange={(event) =>
                    setDraft(
                      createRoutingDraftInputUpdate(tier, "reasoningEffort", event.currentTarget),
                    )
                  }
                />
                <datalist id={`routing-efforts-${tier}`}>
                  {efforts.map((effort) => (
                    <option key={effort} value={effort} />
                  ))}
                </datalist>
              </label>
              <p
                className={`lane-availability availability-${availability ?? "unconfigured"}`}
                data-routing-availability={availability ?? "unconfigured"}
              >
                <span aria-hidden="true" />
                {availability === undefined ? "尚未校验" : availabilityLabels[availability]}
              </p>
            </fieldset>
          );
        })}
      </div>

      <datalist id="routing-model-options">
        {catalog.models.map((model) => (
          <option key={model.model} value={model.model} />
        ))}
      </datalist>

      <footer className="routing-actions">
        <div aria-live="polite">
          <strong>EXECUTION LOCKED</strong>
          <span data-routing-feedback>{routingFeedback(mutationState)}</span>
        </div>
        <button
          type="button"
          data-routing-save
          disabled={!complete || mutationState === "saving"}
          onClick={save}
        >
          {mutationState === "saving" ? "正在校验并保存" : "保存路由配置"}
        </button>
      </footer>
    </section>
  );
}

function initialRoutingDraft(routing: DesktopRoutingConfiguration): RoutingDraft {
  return Object.freeze({
    fast: Object.freeze({
      model: routing.tiers?.fast.model ?? "",
      reasoningEffort: routing.tiers?.fast.reasoningEffort ?? "",
    }),
    standard: Object.freeze({
      model: routing.tiers?.standard.model ?? "",
      reasoningEffort: routing.tiers?.standard.reasoningEffort ?? "",
    }),
    deep: Object.freeze({
      model: routing.tiers?.deep.model ?? "",
      reasoningEffort: routing.tiers?.deep.reasoningEffort ?? "",
    }),
  });
}

function updateRoutingDraft(
  current: RoutingDraft,
  tier: DesktopRoutingTier,
  field: "model" | "reasoningEffort",
  value: string,
): RoutingDraft {
  return Object.freeze({
    ...current,
    [tier]: Object.freeze({ ...current[tier], [field]: value }),
  });
}

export function createRoutingDraftInputUpdate(
  tier: DesktopRoutingTier,
  field: "model" | "reasoningEffort",
  input: unknown,
): (current: RoutingDraft) => RoutingDraft {
  const value = readInputValue(input);
  return (current) => updateRoutingDraft(current, tier, field, value);
}

function buildRoutingTargets(provider: string, draft: RoutingDraft): DesktopRoutingTierTargets {
  return Object.freeze({
    fast: Object.freeze({ provider, ...draft.fast }),
    standard: Object.freeze({ provider, ...draft.standard }),
    deep: Object.freeze({ provider, ...draft.deep }),
  });
}

function uniqueCatalogEfforts(catalog: DesktopModelCatalogSummary): readonly string[] {
  return [...new Set(catalog.models.flatMap((model) => model.supportedReasoningEfforts))].sort();
}

function routingFeedback(state: "idle" | "saving" | "saved" | "conflict" | "unavailable"): string {
  switch (state) {
    case "idle":
      return "保存只更新配置，不会启动任务或模型调用。";
    case "saving":
      return "正在用当前 Codex 模型目录校验三个精确目标。";
    case "saved":
      return "配置已持久化；实际执行仍未开放。";
    case "conflict":
      return "配置已被其他更新改变，已加载最新版本，请重新确认。";
    case "unavailable":
      return "当前无法保存；未改变已有配置，请稍后重试。";
  }
}

function desktopRoutingApi(): Readonly<{
  setRoutingConfiguration(
    update: DesktopRoutingConfigurationUpdate,
  ): Promise<DesktopRoutingConfigurationMutationResult>;
}> {
  return (
    globalThis as unknown as {
      codexHarness: Readonly<{
        setRoutingConfiguration(
          update: DesktopRoutingConfigurationUpdate,
        ): Promise<DesktopRoutingConfigurationMutationResult>;
      }>;
    }
  ).codexHarness;
}

function desktopProjectApi(): Readonly<{
  chooseProjectWorkspace(): Promise<DesktopProjectSelectionResult>;
}> {
  return (
    globalThis as unknown as {
      codexHarness: Readonly<{
        chooseProjectWorkspace(): Promise<DesktopProjectSelectionResult>;
      }>;
    }
  ).codexHarness;
}

function readInputValue(input: unknown): string {
  return (input as { value: string }).value;
}

function ModelCatalogSummary({ catalog }: Readonly<{ catalog: DesktopModelCatalogSummary }>) {
  const undisplayed = catalog.totalVisibleModels - catalog.models.length;
  return (
    <section
      className="model-catalog"
      aria-label="当前可见模型观察"
      data-model-catalog-provider={catalog.provider}
      data-model-catalog-count={String(catalog.totalVisibleModels)}
    >
      <header className="catalog-header">
        <div>
          <p className="card-index">05 / MODEL ROSTER</p>
          <h2>可见模型目录</h2>
        </div>
        <div className="catalog-summary">
          <span>{catalog.provider}</span>
          <strong>{catalog.totalVisibleModels.toString().padStart(2, "0")}</strong>
          <small>OBSERVED · READ ONLY</small>
        </div>
      </header>

      {catalog.models.length === 0 ? (
        <p className="catalog-empty">当前 Codex 会话没有报告可见模型。</p>
      ) : (
        <ol className="model-list">
          {catalog.models.map((model, index) => (
            <li key={model.model} data-model-name={model.model}>
              <div className="model-identity">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{model.model}</strong>
              </div>
              <div className="model-detail">
                <span className="detail-label">默认推理</span>
                <strong>{model.defaultReasoningEffort}</strong>
              </div>
              <div className="model-tags" aria-label="支持的推理强度">
                {model.supportedReasoningEfforts.map((effort) => (
                  <span key={effort} className="model-tag">
                    {effort}
                  </span>
                ))}
              </div>
              <div className="model-tags modalities" aria-label="输入模态">
                {model.inputModalities.map((modality) => (
                  <span key={modality} className="model-tag">
                    {modalityLabels[modality]}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}

      <footer className="catalog-note">
        <span>EXECUTION LOCKED</span>
        {catalog.hasMore ? <span>另有 {undisplayed} 个可见模型未在首屏展开</span> : null}
      </footer>
    </section>
  );
}

function AccountObservationCard({ account }: Readonly<{ account: DesktopAccountStatus }>) {
  const statusLabel =
    account.status === "authenticated"
      ? "已认证"
      : account.status === "authentication_required"
        ? "需要认证"
        : "无需认证";
  const description =
    account.status === "authenticated"
      ? "Harness 已通过受控链路验证当前账户类别，并会接收后续去敏更新。这不代表任务或工具已获得执行权。"
      : account.status === "authentication_required"
        ? "Codex 当前需要 OpenAI 认证。Harness 尚未开放登录流程或凭据输入。"
        : "当前 Codex 运行方式不需要 OpenAI 认证。这仍不会开放任务执行。";
  const credentialLabel =
    account.credentialKind === null ? "未检测到" : credentialLabels[account.credentialKind];
  const planLabel = account.planType === null ? "不适用" : planLabels[account.planType];

  return (
    <aside className="boundary-card account-card" aria-label="当前账户观察">
      <p className="card-index">02 / ACCOUNT</p>
      <h2>账户边界已观察</h2>
      <p>{description}</p>
      <dl>
        <div>
          <dt>状态</dt>
          <dd data-account-status={account.status}>{statusLabel}</dd>
        </div>
        <div>
          <dt>凭据类别</dt>
          <dd data-account-credential={account.credentialKind ?? "none"}>{credentialLabel}</dd>
        </div>
        <div>
          <dt>方案</dt>
          <dd data-account-plan={account.planType ?? "not_applicable"}>{planLabel}</dd>
        </div>
        <div>
          <dt>Execution</dt>
          <dd>Locked</dd>
        </div>
      </dl>
      <p className="observation-note">实时去敏观察 · 不提供账户操作</p>
    </aside>
  );
}

function BoundaryCard() {
  return (
    <aside className="boundary-card" aria-label="当前能力边界">
      <p className="card-index">01 / READINESS</p>
      <h2>现在只验证底座</h2>
      <p>当前界面不会创建任务、调用工具或执行路由。状态为“已就绪”只表示本地控制链完整可达。</p>
      <dl>
        <div>
          <dt>Renderer</dt>
          <dd>Sandboxed</dd>
        </div>
        <div>
          <dt>IPC</dt>
          <dd>Allowlisted</dd>
        </div>
        <div>
          <dt>Execution</dt>
          <dd>Locked</dd>
        </div>
      </dl>
    </aside>
  );
}
