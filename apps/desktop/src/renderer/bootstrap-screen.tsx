import type {
  DesktopAccountPlanType,
  DesktopAccountStatus,
  DesktopBootstrapState,
  DesktopModelCatalogSummary,
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

        {state.phase === "ready" ? <ModelCatalogSummary catalog={state.catalog} /> : null}
      </section>

      <footer className="footer-note">
        <span>模型目录仅供观察；配置、任务、TODO / DAG 与智能路由仍由后续安全门禁控制。</span>
        <span className="footer-rule" aria-hidden="true" />
        <span>LOCAL ONLY</span>
      </footer>
    </main>
  );
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
          <p className="card-index">03 / MODEL ROSTER</p>
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
