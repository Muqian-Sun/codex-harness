import { useEffect, useState } from "react";

import {
  decodeDesktopProjectTaskCreation,
  decodeDesktopProjectTaskCandidatePlanConfirmation,
  decodeDesktopProjectTaskCandidatePlanGeneration,
  decodeDesktopProjectTaskRequirementRevision,
} from "../shared/bootstrap-state.js";
import type {
  DesktopAccountPlanType,
  DesktopAccountStatus,
  DesktopBootstrapState,
  DesktopModelCatalogSummary,
  DesktopProjectCatalog,
  DesktopProjectRoutingBindingMutationResult,
  DesktopProjectRoutingBindings,
  DesktopProjectSelectionResult,
  DesktopProjectSummary,
  DesktopProjectTaskCatalog,
  DesktopProjectTaskCatalogResult,
  DesktopProjectTaskCandidatePlanConfirmation,
  DesktopProjectTaskCandidatePlanConfirmationResult,
  DesktopProjectTaskCandidatePlanGeneration,
  DesktopProjectTaskCandidatePlanMutationResult,
  DesktopProjectTaskCreation,
  DesktopProjectTaskDetail,
  DesktopProjectTaskDetailResult,
  DesktopProjectTaskMutationResult,
  DesktopProjectTaskRequirementMutationResult,
  DesktopProjectTaskRequirementRevision,
  DesktopProjectTaskSelection,
  DesktopTaskStage,
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

const unavailableRouting: DesktopRoutingConfiguration = Object.freeze({
  configured: false,
  profileVersion: 0,
  configurationRevisionId: null,
  tiers: null,
  availability: null,
});

const unavailableAccount: DesktopAccountStatus = Object.freeze({
  status: "not_required",
  credentialKind: null,
  planType: null,
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

const taskStageLabels: Readonly<Record<DesktopTaskStage, string>> = Object.freeze({
  requirements_only: "需求已持久化",
  candidate_plan: "候选计划待确认",
  confirmed_plan: "计划已确认·待建图",
  active_graph: "DAG 已建立",
  active_graph_with_candidate: "DAG 活动·新计划待确认",
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const presentation = phasePresentation[state.phase];

  if (state.phase === "ready") {
    return (
      <main className="shell phase-ready" data-bootstrap-phase="ready">
        <ProjectTaskPanel
          projects={state.projects}
          projectRoutingBindings={state.projectRoutingBindings}
          routing={state.routing}
          account={state.account}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsOpen ? (
          <SettingsWorkspace state={state} onClose={() => setSettingsOpen(false)} />
        ) : null}
      </main>
    );
  }

  return (
    <main
      className={`shell lifecycle-shell phase-${state.phase}`}
      data-bootstrap-phase={state.phase}
    >
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

        <BoundaryCard />
      </section>

      <footer className="footer-note">
        <span>
          工作区、路由配置与 Task 需求修订可持久化；TODO /
          DAG、实际模型选择与执行仍由后续安全门禁控制。
        </span>
        <span className="footer-rule" aria-hidden="true" />
        <span>LOCAL ONLY</span>
      </footer>
    </main>
  );
}

export function SettingsWorkspace({
  state,
  onClose,
}: Readonly<{
  state: Extract<DesktopBootstrapState, { phase: "ready" }>;
  onClose: () => void;
}>) {
  return (
    <section
      className="settings-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Harness 设置"
      data-settings-workspace
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
    >
      <header className="settings-titlebar">
        <div>
          <span>CODEX HARNESS</span>
          <h1>设置</h1>
        </div>
        <button type="button" data-settings-close onClick={onClose} aria-label="关闭设置" autoFocus>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="设置目录">
          <a href="#settings-runtime">运行状态</a>
          <a href="#settings-projects">Projects</a>
          <a href="#settings-routing">模型路由</a>
          <a href="#settings-models">模型目录</a>
          <footer>
            <span className="settings-safe-dot" aria-hidden="true" />
            <span>本地状态已连接</span>
          </footer>
        </nav>
        <div className="settings-content">
          <section id="settings-runtime" className="settings-section">
            <header>
              <span>RUNTIME</span>
              <h2>运行状态</h2>
              <p>只展示由受控链路验证的去敏状态，不提供凭据输入或执行入口。</p>
            </header>
            <AccountObservationCard account={state.account} />
          </section>
          <section id="settings-projects" className="settings-section">
            <ProjectRegistryPanel
              projects={state.projects}
              projectRoutingBindings={state.projectRoutingBindings}
              routingConfigured={state.routing.configured}
            />
          </section>
          <section id="settings-routing" className="settings-section">
            <RoutingConfigurationPanel routing={state.routing} catalog={state.catalog} />
          </section>
          <section id="settings-models" className="settings-section">
            <ModelCatalogSummary catalog={state.catalog} />
          </section>
        </div>
      </div>
    </section>
  );
}

export function ProjectRegistryPanel({
  projects,
  projectRoutingBindings,
  routingConfigured,
}: Readonly<{
  projects: DesktopProjectCatalog;
  projectRoutingBindings: DesktopProjectRoutingBindings;
  routingConfigured: boolean;
}>) {
  const [selectionState, setSelectionState] = useState<
    "idle" | "choosing" | "registered" | "existing" | "unavailable"
  >("idle");
  const [selectedProject, setSelectedProject] = useState<DesktopProjectSummary | undefined>();
  const [bindingMutation, setBindingMutation] = useState<
    Readonly<{
      status: "idle" | "binding" | DesktopProjectRoutingBindingMutationResult["status"];
      projectId?: string;
    }>
  >({ status: "idle" });

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

  const bindDefaultRouting = async (projectId: string): Promise<void> => {
    if (bindingMutation.status === "binding") {
      return;
    }
    setBindingMutation({ status: "binding", projectId });
    try {
      const result = await desktopProjectApi().bindProjectToDefaultRouting(projectId);
      setBindingMutation({ status: result.status, projectId });
    } catch {
      setBindingMutation({ status: "unavailable", projectId });
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
          {projects.projects.map((project, index) => {
            const binding = projectRoutingBindings.bindings[index]!;
            const pending = bindingMutation.status === "binding";
            return (
              <li
                key={project.projectId}
                data-project-id={project.projectId}
                data-project-routing={binding.status}
              >
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
                  <span data-project-routing-status={binding.status}>
                    {projectRoutingBindingLabel(binding.status)}
                  </span>
                </div>
                <div className="project-routing-action">
                  <span>策略引用 · V{binding.bindingVersion ?? 0}</span>
                  <button
                    type="button"
                    data-project-routing-bind={project.projectId}
                    disabled={!routingConfigured || pending || binding.status === "default_bound"}
                    onClick={() => void bindDefaultRouting(project.projectId)}
                  >
                    {pending && bindingMutation.projectId === project.projectId
                      ? "正在绑定"
                      : binding.status === "default_bound"
                        ? "已绑定默认路由"
                        : binding.status === "other_profile_bound"
                          ? "切换到默认路由"
                          : "绑定默认路由"}
                  </button>
                </div>
              </li>
            );
          })}
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
        <span data-project-feedback>
          {projectBindingFeedback(bindingMutation.status, routingConfigured) ??
            projectSelectionFeedback(selectionState)}
        </span>
        <span>{projects.hasMore ? "另有 Project 未在首屏展开" : "EXECUTION LOCKED"}</span>
      </footer>
    </section>
  );
}

type TaskCatalogViewState =
  | Readonly<{ status: "idle" | "loading" | "unavailable" }>
  | Readonly<{ status: "loaded"; catalog: DesktopProjectTaskCatalog }>;

type TaskDetailViewState =
  | Readonly<{ status: "idle" | "loading" | "unavailable" }>
  | Readonly<{ status: "loaded"; detail: DesktopProjectTaskDetail }>;

export function ProjectTaskPanel({
  projects,
  projectRoutingBindings,
  routing = unavailableRouting,
  account = unavailableAccount,
  onOpenSettings,
}: Readonly<{
  projects: DesktopProjectCatalog;
  projectRoutingBindings: DesktopProjectRoutingBindings;
  routing?: DesktopRoutingConfiguration;
  account?: DesktopAccountStatus;
  onOpenSettings?: () => void;
}>) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(() =>
    preferredTaskProjectId(projects, projectRoutingBindings),
  );
  const [catalogState, setCatalogState] = useState<TaskCatalogViewState>({ status: "idle" });
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [detailState, setDetailState] = useState<TaskDetailViewState>({ status: "idle" });
  const [title, setTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [requirementSource, setRequirementSource] = useState("");
  const [mutationStatus, setMutationStatus] = useState<
    "idle" | "creating" | DesktopProjectTaskMutationResult["status"]
  >("idle");
  const [revisionStatus, setRevisionStatus] = useState<
    "idle" | "revising" | DesktopProjectTaskRequirementMutationResult["status"]
  >("idle");
  const [planStatus, setPlanStatus] = useState<
    "idle" | "generating" | DesktopProjectTaskCandidatePlanMutationResult["status"]
  >("idle");
  const [planConfirmationStatus, setPlanConfirmationStatus] = useState<
    | "idle"
    | "reviewing"
    | "confirming"
    | DesktopProjectTaskCandidatePlanConfirmationResult["status"]
  >("idle");

  useEffect(() => {
    if (
      selectedProjectId === undefined ||
      !projects.projects.some((project) => project.projectId === selectedProjectId)
    ) {
      setSelectedProjectId(preferredTaskProjectId(projects, projectRoutingBindings));
    }
  }, [projectRoutingBindings, projects, selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId === undefined) {
      setCatalogState({ status: "idle" });
      setSelectedTaskId(undefined);
      setDetailState({ status: "idle" });
      return;
    }
    let active = true;
    setCatalogState({ status: "loading" });
    setSelectedTaskId(undefined);
    setDetailState({ status: "idle" });
    setRequirementSource("");
    setRevisionStatus("idle");
    setPlanStatus("idle");
    setPlanConfirmationStatus("idle");
    void desktopTaskApi()
      .readProjectTaskCatalog(selectedProjectId)
      .then((result) => {
        if (active) {
          setCatalogState(
            result.status === "loaded"
              ? { status: "loaded", catalog: result.catalog }
              : { status: "unavailable" },
          );
          if (result.status === "loaded") {
            setSelectedTaskId(result.catalog.tasks[0]?.taskId);
          }
        }
      })
      .catch(() => {
        if (active) {
          setCatalogState({ status: "unavailable" });
        }
      });
    return () => {
      active = false;
    };
  }, [selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId === undefined || selectedTaskId === undefined) {
      setDetailState({ status: "idle" });
      return;
    }
    let active = true;
    setDetailState({ status: "loading" });
    setRevisionStatus("idle");
    setPlanStatus("idle");
    setPlanConfirmationStatus("idle");
    void desktopTaskApi()
      .readProjectTaskDetail({ projectId: selectedProjectId, taskId: selectedTaskId })
      .then((result) => {
        if (!active) {
          return;
        }
        if (result.status === "loaded") {
          setDetailState({ status: "loaded", detail: result.detail });
          setRequirementSource(result.detail.activeRequirement.sourceText);
        } else {
          setDetailState({ status: "unavailable" });
        }
      })
      .catch(() => {
        if (active) {
          setDetailState({ status: "unavailable" });
        }
      });
    return () => {
      active = false;
    };
  }, [selectedProjectId, selectedTaskId]);

  const selectedProject = projects.projects.find(
    (project) => project.projectId === selectedProjectId,
  );
  const selectedBinding = projectRoutingBindings.bindings.find(
    (binding) => binding.projectId === selectedProjectId,
  );
  const creation =
    selectedProject === undefined
      ? undefined
      : decodeDesktopProjectTaskCreation({
          projectId: selectedProject.projectId,
          title,
          sourceText,
        });
  const canCreate =
    creation !== undefined &&
    selectedBinding?.status === "default_bound" &&
    mutationStatus !== "creating" &&
    revisionStatus !== "revising" &&
    planStatus !== "generating" &&
    planConfirmationStatus !== "reviewing" &&
    planConfirmationStatus !== "confirming";
  const requirementRevision =
    detailState.status !== "loaded"
      ? undefined
      : decodeDesktopProjectTaskRequirementRevision({
          projectId: detailState.detail.projectId,
          taskId: detailState.detail.taskId,
          expectedTaskVersion: detailState.detail.taskVersion,
          sourceText: requirementSource,
        });
  const canRevise =
    requirementRevision !== undefined &&
    detailState.status === "loaded" &&
    requirementSource !== detailState.detail.activeRequirement.sourceText &&
    revisionStatus !== "revising" &&
    mutationStatus !== "creating" &&
    planStatus !== "generating" &&
    planConfirmationStatus !== "reviewing" &&
    planConfirmationStatus !== "confirming";
  const planGeneration =
    detailState.status !== "loaded"
      ? undefined
      : decodeDesktopProjectTaskCandidatePlanGeneration({
          projectId: detailState.detail.projectId,
          taskId: detailState.detail.taskId,
          expectedTaskVersion: detailState.detail.taskVersion,
        });
  const canGeneratePlan =
    planGeneration !== undefined &&
    detailState.status === "loaded" &&
    selectedBinding?.status === "default_bound" &&
    routing.configured &&
    routing.availability?.deep === "observed_available" &&
    requirementSource === detailState.detail.activeRequirement.sourceText &&
    mutationStatus !== "creating" &&
    revisionStatus !== "revising" &&
    planStatus !== "generating" &&
    planConfirmationStatus !== "reviewing" &&
    planConfirmationStatus !== "confirming";
  const planConfirmation =
    detailState.status !== "loaded" || detailState.detail.candidatePlan === null
      ? undefined
      : decodeDesktopProjectTaskCandidatePlanConfirmation({
          projectId: detailState.detail.projectId,
          taskId: detailState.detail.taskId,
          expectedTaskVersion: detailState.detail.taskVersion,
          candidatePlanRevisionNumber: detailState.detail.candidatePlan.revisionNumber,
        });
  const canBeginPlanConfirmation =
    planConfirmation !== undefined &&
    detailState.status === "loaded" &&
    requirementSource === detailState.detail.activeRequirement.sourceText &&
    mutationStatus !== "creating" &&
    revisionStatus !== "revising" &&
    planStatus !== "generating" &&
    planConfirmationStatus !== "confirming";
  const taskMutationPending =
    mutationStatus === "creating" ||
    revisionStatus === "revising" ||
    planStatus === "generating" ||
    planConfirmationStatus === "reviewing" ||
    planConfirmationStatus === "confirming";

  const createTask = async (): Promise<void> => {
    if (!canCreate || creation === undefined) {
      return;
    }
    setMutationStatus("creating");
    try {
      const result = await desktopTaskApi().createProjectTask(creation);
      if (result.status === "created" || result.status === "existing") {
        setCatalogState({ status: "loaded", catalog: result.catalog });
        setSelectedTaskId(result.taskId);
        setTitle("");
        setSourceText("");
      }
      setMutationStatus(result.status);
    } catch {
      setMutationStatus("unavailable");
    }
  };

  const reviseRequirement = async (): Promise<void> => {
    if (!canRevise || requirementRevision === undefined) {
      return;
    }
    setRevisionStatus("revising");
    try {
      const result = await desktopTaskApi().reviseProjectTaskRequirement(requirementRevision);
      if (result.status === "revised" || result.status === "existing") {
        setCatalogState({ status: "loaded", catalog: result.catalog });
        setDetailState({ status: "loaded", detail: result.detail });
        setRequirementSource(result.detail.activeRequirement.sourceText);
      } else if (result.status === "conflict") {
        const [currentDetail, currentCatalog] = await Promise.allSettled([
          desktopTaskApi().readProjectTaskDetail({
            projectId: requirementRevision.projectId,
            taskId: requirementRevision.taskId,
          }),
          desktopTaskApi().readProjectTaskCatalog(requirementRevision.projectId),
        ]);
        if (currentDetail.status === "fulfilled" && currentDetail.value.status === "loaded") {
          setDetailState({ status: "loaded", detail: currentDetail.value.detail });
        }
        if (currentCatalog.status === "fulfilled" && currentCatalog.value.status === "loaded") {
          setCatalogState({ status: "loaded", catalog: currentCatalog.value.catalog });
        }
      }
      setRevisionStatus(result.status);
    } catch {
      setRevisionStatus("unavailable");
    }
  };

  const generateCandidatePlan = async (): Promise<void> => {
    if (!canGeneratePlan || planGeneration === undefined) {
      return;
    }
    setPlanStatus("generating");
    setPlanConfirmationStatus("idle");
    try {
      const result = await desktopTaskApi().generateProjectTaskCandidatePlan(planGeneration);
      if (result.status === "generated" || result.status === "existing") {
        setCatalogState({ status: "loaded", catalog: result.catalog });
        setDetailState({ status: "loaded", detail: result.detail });
        setRequirementSource(result.detail.activeRequirement.sourceText);
      } else if (result.status === "conflict") {
        const [currentDetail, currentCatalog] = await Promise.allSettled([
          desktopTaskApi().readProjectTaskDetail({
            projectId: planGeneration.projectId,
            taskId: planGeneration.taskId,
          }),
          desktopTaskApi().readProjectTaskCatalog(planGeneration.projectId),
        ]);
        if (currentDetail.status === "fulfilled" && currentDetail.value.status === "loaded") {
          setDetailState({ status: "loaded", detail: currentDetail.value.detail });
          setRequirementSource(currentDetail.value.detail.activeRequirement.sourceText);
        }
        if (currentCatalog.status === "fulfilled" && currentCatalog.value.status === "loaded") {
          setCatalogState({ status: "loaded", catalog: currentCatalog.value.catalog });
        }
      }
      setPlanStatus(result.status);
    } catch {
      setPlanStatus("unavailable");
    }
  };

  const confirmCandidatePlan = async (): Promise<void> => {
    if (planConfirmationStatus !== "reviewing" || planConfirmation === undefined) {
      return;
    }
    setPlanConfirmationStatus("confirming");
    try {
      const result = await desktopTaskApi().confirmProjectTaskCandidatePlan(planConfirmation);
      if (result.status === "confirmed" || result.status === "existing") {
        setCatalogState({ status: "loaded", catalog: result.catalog });
        setDetailState({ status: "loaded", detail: result.detail });
        setRequirementSource(result.detail.activeRequirement.sourceText);
        setPlanStatus("idle");
      } else if (result.status === "conflict") {
        const [currentDetail, currentCatalog] = await Promise.allSettled([
          desktopTaskApi().readProjectTaskDetail({
            projectId: planConfirmation.projectId,
            taskId: planConfirmation.taskId,
          }),
          desktopTaskApi().readProjectTaskCatalog(planConfirmation.projectId),
        ]);
        if (currentDetail.status === "fulfilled" && currentDetail.value.status === "loaded") {
          setDetailState({ status: "loaded", detail: currentDetail.value.detail });
          setRequirementSource(currentDetail.value.detail.activeRequirement.sourceText);
        }
        if (currentCatalog.status === "fulfilled" && currentCatalog.value.status === "loaded") {
          setCatalogState({ status: "loaded", catalog: currentCatalog.value.catalog });
        }
        setPlanStatus("idle");
      }
      setPlanConfirmationStatus(result.status);
    } catch {
      setPlanConfirmationStatus("unavailable");
    }
  };

  const tasks = catalogState.status === "loaded" ? catalogState.catalog.tasks : [];
  const accountLabel =
    account.status === "authenticated"
      ? account.credentialKind === "chatgpt"
        ? `ChatGPT · ${account.planType === null ? "已认证" : planLabels[account.planType]}`
        : `${account.credentialKind === null ? "账户" : credentialLabels[account.credentialKind]} · 已认证`
      : account.status === "authentication_required"
        ? "Codex 需要认证"
        : "本地 Codex";
  return (
    <section
      className="project-tasks workspace-frame"
      aria-label="Project Task 工作台"
      data-task-project={selectedProjectId ?? "none"}
      data-task-catalog-status={catalogState.status}
      data-task-count={String(tasks.length)}
    >
      <aside className="workspace-sidebar" aria-label="Project 与 Task 导航">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark" aria-hidden="true">
            H
          </span>
          <div>
            <strong>Harness</strong>
            <small>Local workspace</small>
          </div>
          <span className="sidebar-ready-dot" title="本地运行时已就绪" />
        </div>

        <button
          type="button"
          className="sidebar-new-task"
          data-task-new
          disabled={selectedProject === undefined || taskMutationPending}
          onClick={() => {
            setSelectedTaskId(undefined);
            setDetailState({ status: "idle" });
            setRequirementSource("");
            setRevisionStatus("idle");
            setPlanStatus("idle");
            setPlanConfirmationStatus("idle");
          }}
        >
          <span aria-hidden="true">＋</span>
          新建 Task
        </button>

        <label className="project-switcher">
          <span>当前 Project</span>
          <select
            data-task-project-select
            value={selectedProjectId ?? ""}
            disabled={projects.projects.length === 0 || taskMutationPending}
            onChange={(event) => {
              setSelectedProjectId(readInputValue(event.currentTarget) || undefined);
              setSelectedTaskId(undefined);
              setDetailState({ status: "idle" });
              setRequirementSource("");
              setMutationStatus("idle");
              setRevisionStatus("idle");
              setPlanStatus("idle");
              setPlanConfirmationStatus("idle");
            }}
          >
            {projects.projects.length === 0 ? <option value="">尚无 Project</option> : null}
            {projects.projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.displayName}
              </option>
            ))}
          </select>
        </label>

        <div className="task-catalog">
          <header>
            <span>最近 Tasks</span>
            <small>{tasks.length}</small>
          </header>
          {catalogState.status === "loading" ? <p>正在读取本地 Task…</p> : null}
          {catalogState.status === "unavailable" ? (
            <p>当前无法确认 Task 目录；不会自动重放写入。</p>
          ) : null}
          {catalogState.status === "loaded" && tasks.length === 0 ? (
            <p>这个 Project 还没有 Task。</p>
          ) : null}
          {tasks.length > 0 ? (
            <ol>
              {tasks.map((task) => (
                <li
                  key={task.taskId}
                  data-task-id={task.taskId}
                  data-task-stage={task.stage}
                  data-task-selected={String(task.taskId === selectedTaskId)}
                >
                  <button
                    type="button"
                    data-task-open
                    disabled={taskMutationPending}
                    onClick={() => {
                      setSelectedTaskId(task.taskId);
                      setDetailState({ status: "loading" });
                      setRequirementSource("");
                      setRevisionStatus("idle");
                      setPlanStatus("idle");
                      setPlanConfirmationStatus("idle");
                    }}
                  >
                    <span className="task-list-icon" aria-hidden="true">
                      {task.title.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <strong>{task.title}</strong>
                      <p>{task.objective}</p>
                      <small>
                        V{task.taskVersion} · {taskStageLabels[task.stage]}
                      </small>
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {catalogState.status === "loaded" && catalogState.catalog.hasMore ? (
            <small className="task-catalog-more">另有 Task 未在首屏展开</small>
          ) : null}
        </div>

        <button
          type="button"
          className="sidebar-account"
          data-open-settings
          data-account-status={account.status}
          data-account-credential={account.credentialKind ?? "none"}
          data-account-plan={account.planType ?? "not_applicable"}
          onClick={onOpenSettings}
          aria-label="打开设置；当前账户观察"
        >
          <span className="sidebar-account-avatar" aria-hidden="true">
            CH
          </span>
          <span>
            <strong>{accountLabel}</strong>
            <small>设置与本地状态</small>
          </span>
          <span aria-hidden="true">···</span>
        </button>
      </aside>

      <div className="task-stage">
        <header className="task-stage-header">
          <div>
            <span>{selectedProject?.displayName ?? "LOCAL WORKSPACE"}</span>
            <strong>
              {detailState.status === "loaded" ? detailState.detail.title : "从一个清晰目标开始"}
            </strong>
          </div>
          <div className="stage-security-status">
            <span aria-hidden="true" />
            EXECUTION LOCKED
          </div>
        </header>

        <div className="task-stage-scroll">
          <div
            className="task-detail"
            data-task-detail-status={detailState.status}
            data-task-revision-status={revisionStatus}
            data-task-version={detailState.status === "loaded" ? detailState.detail.taskVersion : 0}
            data-task-requirement-revision={
              detailState.status === "loaded"
                ? detailState.detail.activeRequirement.revisionNumber
                : 0
            }
          >
            {detailState.status === "idle" ? (
              <div className="task-empty-state">
                <span aria-hidden="true">H</span>
                <h1>把复杂工作变成可恢复的计划。</h1>
                <p>
                  在下方描述目标。Harness
                  会先保存权威需求，再让高级档位生成一份只能审阅、不能执行的候选计划。
                </p>
              </div>
            ) : null}
            {detailState.status === "loading" ? (
              <div className="task-loading-state">
                <span aria-hidden="true" />
                <p>正在读取当前 Requirement…</p>
              </div>
            ) : null}
            {detailState.status === "unavailable" ? (
              <div className="task-unavailable-state">
                <strong>无法确认 Task 详情</strong>
                <p>不会把未知状态解释为空需求，也不会自动重放写入。</p>
              </div>
            ) : null}
            {detailState.status === "loaded" ? (
              <article className="requirement-document">
                <header>
                  <div>
                    <span>REQUIREMENT R{detailState.detail.activeRequirement.revisionNumber}</span>
                    <small>
                      TASK V{detailState.detail.taskVersion} ·{" "}
                      {taskStageLabels[detailState.detail.stage]}
                    </small>
                  </div>
                  <h1>{detailState.detail.activeRequirement.objective}</h1>
                </header>
                <label>
                  <span>需求原文修订</span>
                  <textarea
                    data-task-revision-source
                    value={requirementSource}
                    maxLength={16 * 1_024}
                    disabled={taskMutationPending}
                    onChange={(event) => {
                      setRequirementSource(readInputValue(event.currentTarget));
                      if (planStatus !== "generating") {
                        setPlanStatus("idle");
                      }
                      if (revisionStatus !== "revising") {
                        setRevisionStatus("idle");
                      }
                      if (planConfirmationStatus !== "confirming") {
                        setPlanConfirmationStatus("idle");
                      }
                    }}
                  />
                </label>
                {requirementSource !== detailState.detail.activeRequirement.sourceText ? (
                  <div className="task-authoritative-requirement">
                    <span>当前已持久化原文</span>
                    <p>{detailState.detail.activeRequirement.sourceText}</p>
                  </div>
                ) : null}
                {detailState.detail.activeRequirement.constraints.length > 0 ? (
                  <RequirementItems
                    title="当前约束"
                    items={detailState.detail.activeRequirement.constraints}
                  />
                ) : null}
                {detailState.detail.activeRequirement.acceptanceCriteria.length > 0 ? (
                  <RequirementItems
                    title="当前验收条件"
                    items={detailState.detail.activeRequirement.acceptanceCriteria}
                  />
                ) : null}
                <footer>
                  <button
                    type="button"
                    data-task-revise
                    disabled={!canRevise}
                    onClick={() => void reviseRequirement()}
                  >
                    {revisionStatus === "revising" ? "正在提交新修订" : "保存 Requirement Revision"}
                  </button>
                  <span data-task-revision-feedback aria-live="polite">
                    {taskRequirementFeedback(revisionStatus)}
                  </span>
                </footer>
              </article>
            ) : null}
          </div>
        </div>

        <div className="task-intake-form" id="task-composer">
          <div className="composer-title-row">
            <span aria-hidden="true">＋</span>
            <input
              data-task-title
              value={title}
              maxLength={256}
              disabled={selectedProject === undefined || taskMutationPending}
              onChange={(event) => setTitle(readInputValue(event.currentTarget))}
              placeholder="Task 标题"
              aria-label="Task 标题"
            />
          </div>
          <textarea
            data-task-source
            value={sourceText}
            maxLength={16 * 1_024}
            disabled={selectedProject === undefined || taskMutationPending}
            onChange={(event) => setSourceText(readInputValue(event.currentTarget))}
            placeholder="描述你希望 Harness 完成的目标、约束和验收预期…"
            aria-label="需求原文"
          />
          <footer>
            <span data-task-feedback aria-live="polite">
              {taskMutationFeedback(mutationStatus, selectedBinding?.status)}
            </span>
            <button
              type="button"
              data-task-create
              disabled={!canCreate}
              onClick={() => void createTask()}
              aria-label="创建持久 Task"
            >
              {mutationStatus === "creating" ? "…" : "↑"}
            </button>
          </footer>
        </div>
      </div>

      <aside className="task-inspector" aria-label="计划检查器">
        <header className="inspector-header">
          <div>
            <span>PLAN</span>
            <strong>任务计划</strong>
          </div>
          <small>LOCAL · PERSISTED</small>
        </header>
        <div className="inspector-security-note">
          <span aria-hidden="true">!</span>
          <div>
            <strong>执行保持锁定</strong>
            <p>确认只设置权威计划，不会创建 DAG、Run 或工具调用。</p>
          </div>
        </div>
        {detailState.status === "loaded" ? (
          <div className="inspector-plan-content">
            <div className="task-plan-divider" aria-hidden="true">
              <span>
                {detailState.detail.candidatePlan !== null
                  ? "CANDIDATE PLAN"
                  : detailState.detail.confirmedPlan !== null
                    ? "CONFIRMED PLAN"
                    : "PLAN"}
              </span>
              <i />
              <small>
                {detailState.detail.candidatePlan !== null
                  ? "UNCONFIRMED"
                  : detailState.detail.confirmedPlan !== null
                    ? "WAITING FOR DAG"
                    : "NOT CREATED"}
              </small>
            </div>
            {detailState.detail.candidatePlan !== null ? (
              <>
                {detailState.detail.confirmedPlan !== null ? (
                  <div className="task-plan-authority-summary" data-task-plan-authority-summary>
                    <span>CURRENT AUTHORITY</span>
                    <strong>
                      P{detailState.detail.confirmedPlan.revisionNumber} ·{" "}
                      {detailState.detail.confirmedPlan.steps.length} STEPS
                    </strong>
                    <p>新候选尚未替换当前权威计划。</p>
                  </div>
                ) : null}
                <CandidatePlan plan={detailState.detail.candidatePlan} kind="candidate" />
                {planConfirmationStatus === "reviewing" ||
                planConfirmationStatus === "confirming" ? (
                  <div
                    className="plan-confirmation-card"
                    data-task-plan-confirmation
                    role="group"
                    aria-labelledby="plan-confirmation-title"
                    aria-describedby="plan-confirmation-description"
                  >
                    <span>AUTHORITY CHANGE</span>
                    <strong id="plan-confirmation-title">
                      确认 P{detailState.detail.candidatePlan.revisionNumber}？
                    </strong>
                    <p id="plan-confirmation-description">
                      {detailState.detail.stage === "active_graph_with_candidate"
                        ? "这会把候选步骤设为新的权威计划，并使当前 DAG 失效。不会创建新 DAG、Run 或启动执行。"
                        : "这会把候选步骤复制为新的权威 Plan Revision。不会创建 DAG、Run 或启动执行。"}
                    </p>
                    <div>
                      <button
                        type="button"
                        data-task-plan-confirm-cancel
                        disabled={planConfirmationStatus === "confirming"}
                        onClick={() => setPlanConfirmationStatus("idle")}
                      >
                        返回审阅
                      </button>
                      <button
                        type="button"
                        data-task-plan-confirm-commit
                        disabled={planConfirmationStatus === "confirming"}
                        onClick={() => void confirmCandidatePlan()}
                      >
                        {planConfirmationStatus === "confirming"
                          ? "正在提交确认"
                          : "确认并设为权威计划"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="plan-confirm-button"
                    data-task-plan-confirm
                    disabled={!canBeginPlanConfirmation}
                    onClick={() => setPlanConfirmationStatus("reviewing")}
                  >
                    确认此计划
                  </button>
                )}
              </>
            ) : detailState.detail.confirmedPlan !== null ? (
              <CandidatePlan plan={detailState.detail.confirmedPlan} kind="confirmed" />
            ) : (
              <div className="task-plan-empty">
                <span aria-hidden="true">◇</span>
                <strong>还没有候选计划</strong>
                <p>高级档位会只读分析当前 Project，并生成一份持久、可审阅的步骤清单。</p>
              </div>
            )}
            {detailState.detail.candidatePlan !== null || planConfirmationStatus !== "idle" ? (
              <span
                className="plan-confirmation-feedback"
                data-task-plan-confirmation-status={planConfirmationStatus}
                data-task-plan-confirm-feedback
                aria-live="polite"
              >
                {taskCandidatePlanConfirmationFeedback(planConfirmationStatus)}
              </span>
            ) : null}
            <button
              type="button"
              className="plan-generate-button"
              data-task-plan-generate
              disabled={!canGeneratePlan}
              onClick={() => void generateCandidatePlan()}
            >
              {planStatus === "generating"
                ? "高级档位正在分析"
                : detailState.detail.candidatePlan === null
                  ? "生成候选计划"
                  : "重新生成候选计划"}
            </button>
            <span className="plan-feedback" data-task-plan-feedback aria-live="polite">
              {taskCandidatePlanFeedback(
                planStatus,
                selectedBinding?.status,
                routing,
                requirementSource !== detailState.detail.activeRequirement.sourceText,
              )}
            </span>
          </div>
        ) : (
          <div className="inspector-empty">
            <span aria-hidden="true">↗</span>
            <p>选择一个 Task 后，这里会显示它的真实候选计划。</p>
          </div>
        )}
        <footer className="inspector-route-summary">
          <span>高级档位</span>
          <strong>
            {routing.availability?.deep === "observed_available" ? "READY" : "NOT READY"}
          </strong>
        </footer>
      </aside>
    </section>
  );
}

export function CandidatePlan({
  plan,
  kind = "candidate",
}: Readonly<{
  plan: NonNullable<DesktopProjectTaskDetail["candidatePlan"]>;
  kind?: "candidate" | "confirmed";
}>) {
  return (
    <section
      className="task-candidate-plan"
      data-task-plan-kind={kind}
      data-task-plan-revision={plan.revisionNumber}
    >
      <header>
        <div>
          <span>PLAN REVISION</span>
          <strong>P{plan.revisionNumber}</strong>
        </div>
        <small>
          {plan.steps.length} STEPS · {kind === "confirmed" ? "AUTHORITATIVE" : "REVIEW REQUIRED"}
        </small>
      </header>
      <ol>
        {plan.steps.map((step, index) => (
          <li key={`${index}:${step.title}`}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.description}</p>
              {step.acceptanceCriteria.length > 0 ? (
                <ul>
                  {step.acceptanceCriteria.map((criterion, criterionIndex) => (
                    <li key={`${criterionIndex}:${criterion}`}>{criterion}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RequirementItems({
  title,
  items,
}: Readonly<{ title: string; items: readonly string[] }>) {
  return (
    <div className="task-requirement-items">
      <span>{title}</span>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function preferredTaskProjectId(
  projects: DesktopProjectCatalog,
  bindings: DesktopProjectRoutingBindings,
): string | undefined {
  return (
    bindings.bindings.find((binding) => binding.status === "default_bound")?.projectId ??
    projects.projects[0]?.projectId
  );
}

function taskMutationFeedback(
  status: "idle" | "creating" | DesktopProjectTaskMutationResult["status"],
  bindingStatus: "unbound" | "default_bound" | "other_profile_bound" | undefined,
): string {
  if (status === "idle" && bindingStatus !== "default_bound") {
    return "请先为 Project 绑定默认路由；这仍不会开放执行权限。";
  }
  switch (status) {
    case "idle":
      return "创建后只进入 Requirement 阶段，不会自动调用模型。";
    case "creating":
      return "正在原子提交 Task 与 Project 归属。";
    case "created":
      return "Task 与初始需求已持久化；计划和执行仍未开始。";
    case "existing":
      return "相同命令已经提交，已重新读取当前目录。";
    case "conflict":
      return "Project 或绑定状态已变化，请核对后重试。";
    case "routing_unbound":
      return "Project 尚未绑定默认路由。";
    case "unavailable":
      return "结果当前未知；请先重启核对目录，不要盲目重复创建。";
  }
}

export function taskRequirementFeedback(
  status: "idle" | "revising" | DesktopProjectTaskRequirementMutationResult["status"],
): string {
  switch (status) {
    case "idle":
      return "保存会创建新修订；旧 Requirement 保留在历史中，计划与执行不会自动开始。";
    case "revising":
      return "正在校验 Task 与 Project 归属并提交新 Requirement Revision。";
    case "revised":
      return "新 Requirement Revision 已持久化；旧候选计划或 DAG 不会继续作为当前状态。";
    case "existing":
      return "相同修订命令已经提交，已重新读取当前权威详情。";
    case "conflict":
      return "Task 已发生变化；已刷新权威详情，草稿仍保留，请比较当前原文后再提交。";
    case "unavailable":
      return "结果当前未知；请重启并核对 Requirement 修订号，不要盲目重复提交。";
  }
}

export function taskCandidatePlanFeedback(
  status: "idle" | "generating" | DesktopProjectTaskCandidatePlanMutationResult["status"],
  bindingStatus: "unbound" | "default_bound" | "other_profile_bound" | undefined,
  routing: DesktopRoutingConfiguration,
  hasRequirementDraft: boolean,
): string {
  if (status === "idle" && hasRequirementDraft) {
    return "请先保存或撤销 Requirement 草稿；候选计划只绑定当前权威修订。";
  }
  if (status === "idle" && bindingStatus !== "default_bound") {
    return "当前 Project 未绑定默认路由，不能解析高级档位。";
  }
  if (
    status === "idle" &&
    (!routing.configured || routing.availability?.deep !== "observed_available")
  ) {
    return "高级档位当前不可用；不会静默回退到其他模型。";
  }
  switch (status) {
    case "idle":
      return "将使用当前高级档位进行一次只读、禁网分析；结果仍需用户确认。";
    case "generating":
      return "正在只读分析工作区并复核 Task、路由和模型目录，期间不会修改文件。";
    case "generated":
      return "候选计划已持久化并可在重启后恢复；它尚未确认，也不能执行。";
    case "existing":
      return "相同生成命令已经落盘，已重新读取当前权威候选计划。";
    case "conflict":
      return "分析期间 Task、路由或模型目录已变化；结果未写入，已刷新当前状态。";
    case "unavailable":
      return "结果当前未知；请重启并核对 Plan 修订号，不要盲目重复生成。";
  }
}

export function taskCandidatePlanConfirmationFeedback(
  status:
    | "idle"
    | "reviewing"
    | "confirming"
    | DesktopProjectTaskCandidatePlanConfirmationResult["status"],
): string {
  switch (status) {
    case "idle":
      return "确认需要再次核对；确认本身不会创建 DAG 或启动执行。";
    case "reviewing":
      return "请核对权威状态变化；仍需第二次明确确认。";
    case "confirming":
      return "正在复核 Task、Requirement 与候选 Plan 栅栏并提交确认。";
    case "confirmed":
      return "权威 Plan Revision 已持久化；执行仍锁定，下一步需单独创建 DAG。";
    case "existing":
      return "相同确认命令已经落盘，已重新读取当前权威计划。";
    case "conflict":
      return "Task 或候选计划已经变化；已刷新权威详情，请重新审阅后再确认。";
    case "unavailable":
      return "结果当前未知；请重启并核对 confirmed Plan 修订号，不要盲目重复确认。";
  }
}

function projectRoutingBindingLabel(
  status: "unbound" | "default_bound" | "other_profile_bound",
): string {
  switch (status) {
    case "unbound":
      return "ROUTING UNBOUND";
    case "default_bound":
      return "DEFAULT ROUTING";
    case "other_profile_bound":
      return "OTHER PROFILE";
  }
}

export function projectBindingFeedback(
  status: "idle" | "binding" | DesktopProjectRoutingBindingMutationResult["status"],
  routingConfigured: boolean,
): string | undefined {
  if (!routingConfigured && status === "idle") {
    return "请先保存完整三级模型配置，再为 Project 绑定默认路由。";
  }
  switch (status) {
    case "idle":
      return undefined;
    case "binding":
      return "正在校验 Project、绑定版本与当前路由配置。";
    case "bound":
      return "Project 已绑定默认路由；执行权限仍未开放。";
    case "existing":
      return "Project 已处于相同默认路由绑定，无需重复写入。";
    case "conflict":
      return "绑定或路由配置已变化，已刷新权威状态，请重新确认。";
    case "routing_unconfigured":
      return "默认路由尚未配置，请先保存完整三级模型配置。";
    case "unavailable":
      return "当前无法确认绑定结果，请刷新或重启后核对。";
  }
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
          <p className="card-index">05 / ROUTING MATRIX</p>
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
  bindProjectToDefaultRouting(
    projectId: string,
  ): Promise<DesktopProjectRoutingBindingMutationResult>;
}> {
  return (
    globalThis as unknown as {
      codexHarness: Readonly<{
        chooseProjectWorkspace(): Promise<DesktopProjectSelectionResult>;
        bindProjectToDefaultRouting(
          projectId: string,
        ): Promise<DesktopProjectRoutingBindingMutationResult>;
      }>;
    }
  ).codexHarness;
}

function desktopTaskApi(): Readonly<{
  readProjectTaskCatalog(projectId: string): Promise<DesktopProjectTaskCatalogResult>;
  createProjectTask(
    creation: DesktopProjectTaskCreation,
  ): Promise<DesktopProjectTaskMutationResult>;
  readProjectTaskDetail(
    selection: DesktopProjectTaskSelection,
  ): Promise<DesktopProjectTaskDetailResult>;
  reviseProjectTaskRequirement(
    revision: DesktopProjectTaskRequirementRevision,
  ): Promise<DesktopProjectTaskRequirementMutationResult>;
  generateProjectTaskCandidatePlan(
    input: DesktopProjectTaskCandidatePlanGeneration,
  ): Promise<DesktopProjectTaskCandidatePlanMutationResult>;
  confirmProjectTaskCandidatePlan(
    input: DesktopProjectTaskCandidatePlanConfirmation,
  ): Promise<DesktopProjectTaskCandidatePlanConfirmationResult>;
}> {
  return (
    globalThis as unknown as {
      codexHarness: Readonly<{
        readProjectTaskCatalog(projectId: string): Promise<DesktopProjectTaskCatalogResult>;
        createProjectTask(
          creation: DesktopProjectTaskCreation,
        ): Promise<DesktopProjectTaskMutationResult>;
        readProjectTaskDetail(
          selection: DesktopProjectTaskSelection,
        ): Promise<DesktopProjectTaskDetailResult>;
        reviseProjectTaskRequirement(
          revision: DesktopProjectTaskRequirementRevision,
        ): Promise<DesktopProjectTaskRequirementMutationResult>;
        generateProjectTaskCandidatePlan(
          input: DesktopProjectTaskCandidatePlanGeneration,
        ): Promise<DesktopProjectTaskCandidatePlanMutationResult>;
        confirmProjectTaskCandidatePlan(
          input: DesktopProjectTaskCandidatePlanConfirmation,
        ): Promise<DesktopProjectTaskCandidatePlanConfirmationResult>;
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
          <p className="card-index">06 / MODEL ROSTER</p>
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
