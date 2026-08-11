import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "00000000-0000-4000-8000-000000000891";
const hooks = vi.hoisted(() => ({
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  setters: [
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  ],
  values: [] as unknown[],
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effects.push(effect);
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor;
    hooks.cursor += 1;
    const value =
      index < hooks.values.length
        ? hooks.values[index]
        : typeof initial === "function"
          ? (initial as () => unknown)()
          : initial;
    return [value, hooks.setters[index]];
  },
}));

import {
  BootstrapScreen,
  CandidatePlan,
  ProjectRegistryPanel,
  ProjectTaskPanel,
  RequirementItems,
  TaskGraph,
  SettingsWorkspace,
  taskCandidatePlanFeedback,
  taskCandidatePlanConfirmationFeedback,
  taskGraphMaterializationFeedback,
} from "./bootstrap-screen.js";

const PROJECTS = {
  projects: [
    {
      projectId: PROJECT_ID,
      projectVersion: 1 as const,
      displayName: "workspace",
      workspace: {
        platform: "macos" as const,
        absolutePath: "/Users/example/workspace",
        identityStatus: "unverified" as const,
      },
    },
  ],
  hasMore: false,
};

function findBindingButton(root: unknown): Readonly<{ props: Record<string, unknown> }> {
  const queue = [root];
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const props = (candidate as { props?: Record<string, unknown> }).props;
    if (props !== undefined) {
      if (props["data-project-routing-bind"] === PROJECT_ID) {
        return { props };
      }
      const children = props.children;
      queue.push(...(Array.isArray(children) ? children : [children]));
    }
  }
  throw new Error("binding button was not rendered");
}

function findElementByType(
  root: unknown,
  type: unknown,
): Readonly<{ props: Record<string, unknown> }> | undefined {
  const queue = [root];
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const element = candidate as { type?: unknown; props?: Record<string, unknown> };
    if (element.type === type && element.props !== undefined) {
      return { props: element.props };
    }
    if (element.props !== undefined) {
      const children = element.props.children;
      queue.push(...(Array.isArray(children) ? children : [children]));
    }
  }
  return undefined;
}

function renderPanel(bindingState: unknown = { status: "idle" }) {
  hooks.cursor = 0;
  hooks.values = ["idle", undefined, bindingState];
  return ProjectRegistryPanel({
    projects: PROJECTS,
    projectRoutingBindings: {
      bindings: [{ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }],
    },
    routingConfigured: true,
  });
}

function findTaskCreateButton(root: unknown): Readonly<{ props: Record<string, unknown> }> {
  const queue = [root];
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const props = (candidate as { props?: Record<string, unknown> }).props;
    if (props !== undefined) {
      if (props["data-task-create"] === true) {
        return { props };
      }
      const children = props.children;
      queue.push(...(Array.isArray(children) ? children : [children]));
    }
  }
  throw new Error("Task create button was not rendered");
}

function findTaskControl(
  root: unknown,
  attribute:
    | "data-task-open"
    | "data-task-new"
    | "data-task-plan-generate"
    | "data-task-plan-confirm"
    | "data-task-plan-confirm-commit"
    | "data-task-plan-confirm-cancel"
    | "data-task-graph-materialize"
    | "data-task-project-select"
    | "data-task-revise"
    | "data-task-revision-source"
    | "data-task-source"
    | "data-task-title",
): Readonly<{ props: Record<string, unknown> }> {
  const queue = [root];
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const props = (candidate as { props?: Record<string, unknown> }).props;
    if (props !== undefined) {
      if (props[attribute] === true) {
        return { props };
      }
      const children = props.children;
      queue.push(...(Array.isArray(children) ? children : [children]));
    }
  }
  throw new Error(`Task control ${attribute} was not rendered`);
}

function renderTaskPanel(mutationStatus: unknown = "idle") {
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.values = [
    PROJECT_ID,
    {
      status: "loaded",
      catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false },
    },
    undefined,
    { status: "idle" },
    "Task title",
    "Persist this requirement.",
    "",
    mutationStatus,
    "idle",
  ];
  return ProjectTaskPanel({
    projects: PROJECTS,
    projectRoutingBindings: {
      bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
    },
  });
}

beforeEach(() => {
  hooks.effects = [];
  for (const setter of hooks.setters) {
    setter.mockReset();
  }
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "codexHarness");
});

describe("desktop workspace shell interaction", () => {
  it("opens and closes the settings workspace without changing bootstrap state", () => {
    const readyState = {
      phase: "ready" as const,
      account: { status: "not_required" as const, credentialKind: null, planType: null },
      catalog: { provider: "openai", totalVisibleModels: 0, models: [], hasMore: false },
      routing: {
        configured: false as const,
        profileVersion: 0,
        configurationRevisionId: null,
        tiers: null,
        availability: null,
      },
      projects: { projects: [], hasMore: false },
      projectRoutingBindings: { bindings: [] },
    };
    hooks.cursor = 0;
    hooks.values = [false];
    const closed = BootstrapScreen({ state: readyState });
    const taskWorkspace = findElementByType(closed, ProjectTaskPanel);

    expect(taskWorkspace).toBeDefined();
    expect(findElementByType(closed, SettingsWorkspace)).toBeUndefined();
    (taskWorkspace!.props.onOpenSettings as () => void)();
    expect(hooks.setters[0]).toHaveBeenCalledWith(true);

    hooks.cursor = 0;
    hooks.values = [true];
    const open = BootstrapScreen({ state: readyState });
    const settings = findElementByType(open, SettingsWorkspace);
    expect(settings).toBeDefined();
    (settings!.props.onClose as () => void)();
    expect(hooks.setters[0]).toHaveBeenCalledWith(false);
  });

  it("closes settings with Escape and focuses the explicit close control", () => {
    const onClose = vi.fn();
    const settings = SettingsWorkspace({
      state: {
        phase: "ready",
        account: { status: "not_required", credentialKind: null, planType: null },
        catalog: { provider: "openai", totalVisibleModels: 0, models: [], hasMore: false },
        routing: {
          configured: false,
          profileVersion: 0,
          configurationRevisionId: null,
          tiers: null,
          availability: null,
        },
        projects: { projects: [], hasMore: false },
        projectRoutingBindings: { bindings: [] },
      },
      onClose,
    });

    (settings.props.onKeyDown as (event: Readonly<{ key: string }>) => void)({ key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    (settings.props.onKeyDown as (event: Readonly<{ key: string }>) => void)({ key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    const closeButton = findElementByType(settings, "button");
    expect(closeButton?.props.autoFocus).toBe(true);
  });
});

describe("Project routing binding interaction", () => {
  it("serializes local submissions and publishes stable success or unavailable state", async () => {
    const bindProjectToDefaultRouting = vi.fn(async () => ({ status: "bound" as const }));
    Object.assign(globalThis, {
      codexHarness: {
        bindProjectToDefaultRouting,
        chooseProjectWorkspace: vi.fn(),
      },
    });

    const successButton = findBindingButton(renderPanel());
    await (successButton.props.onClick as () => Promise<void>)();
    expect(hooks.setters[2]).toHaveBeenNthCalledWith(1, {
      status: "binding",
      projectId: PROJECT_ID,
    });
    expect(hooks.setters[2]).toHaveBeenNthCalledWith(2, {
      status: "bound",
      projectId: PROJECT_ID,
    });

    bindProjectToDefaultRouting.mockRejectedValueOnce(new Error("contained"));
    const failureButton = findBindingButton(renderPanel());
    await (failureButton.props.onClick as () => Promise<void>)();
    expect(hooks.setters[2]).toHaveBeenLastCalledWith({
      status: "unavailable",
      projectId: PROJECT_ID,
    });

    const pendingButton = findBindingButton(
      renderPanel({ status: "binding", projectId: PROJECT_ID }),
    );
    await (pendingButton.props.onClick as () => Promise<void>)();
    expect(bindProjectToDefaultRouting).toHaveBeenCalledTimes(2);
  });
});

describe("Project Task interaction", () => {
  it("returns to the new Task composer without discarding its draft", () => {
    const panel = renderTaskPanel();
    const newTask = findTaskControl(panel, "data-task-new");

    (newTask.props.onClick as () => void)();

    expect(hooks.setters[2]).toHaveBeenCalledWith(undefined);
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "idle" });
    expect(hooks.setters[6]).toHaveBeenCalledWith("");
    expect(hooks.setters[8]).toHaveBeenCalledWith("idle");
    expect(hooks.setters[9]).toHaveBeenCalledWith("idle");
    expect(hooks.setters[4]).not.toHaveBeenCalled();
    expect(hooks.setters[5]).not.toHaveBeenCalled();
  });

  it("renders candidate steps and reports every user-visible generation state", () => {
    const plan = CandidatePlan({
      plan: {
        revisionNumber: 2,
        steps: [
          {
            title: "Review the proposal",
            description: "Keep the model output explicitly unconfirmed.",
            acceptanceCriteria: ["No execution starts."],
          },
          {
            title: "Record the decision",
            description: "Persist the later user decision.",
            acceptanceCriteria: [],
          },
        ],
      },
    });
    expect(plan.props["data-task-plan-revision"]).toBe(2);

    const routing = {
      configured: true as const,
      profileVersion: 1,
      configurationRevisionId: "00000000-0000-4000-8000-000000000899",
      tiers: {
        fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
        standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
      },
      availability: {
        fast: "observed_available" as const,
        standard: "observed_available" as const,
        deep: "observed_available" as const,
      },
    } as const;
    expect(taskCandidatePlanFeedback("idle", "unbound", routing, false)).toContain("未绑定");
    expect(taskCandidatePlanFeedback("generating", "default_bound", routing, false)).toContain(
      "正在只读分析",
    );
    expect(taskCandidatePlanFeedback("generated", "default_bound", routing, false)).toContain(
      "尚未确认",
    );
    expect(taskCandidatePlanFeedback("existing", "default_bound", routing, false)).toContain(
      "已经落盘",
    );
    expect(taskCandidatePlanFeedback("conflict", "default_bound", routing, false)).toContain(
      "结果未写入",
    );
    expect(taskCandidatePlanFeedback("unavailable", "default_bound", routing, false)).toContain(
      "结果当前未知",
    );
    expect(taskCandidatePlanConfirmationFeedback("reviewing")).toContain("第二次");
    expect(taskCandidatePlanConfirmationFeedback("confirming")).toContain("正在复核");
    expect(taskCandidatePlanConfirmationFeedback("confirmed")).toContain("下一步需单独创建 DAG");
    expect(taskCandidatePlanConfirmationFeedback("existing")).toContain("已经落盘");
    expect(taskCandidatePlanConfirmationFeedback("conflict")).toContain("重新审阅");
    expect(taskCandidatePlanConfirmationFeedback("unavailable")).toContain("结果当前未知");
  });

  it("generates and renders an explicitly unconfirmed candidate Plan", async () => {
    const detail = {
      projectId: PROJECT_ID,
      taskId: "00000000-0000-4000-8000-000000000892",
      taskVersion: 1,
      title: "Candidate Task",
      stage: "requirements_only" as const,
      activeRequirement: {
        revisionNumber: 1,
        sourceText: "Generate a review-only plan.",
        objective: "Generate a review-only plan.",
        constraints: [],
        acceptanceCriteria: [],
      },
      candidatePlan: null,
      confirmedPlan: null,
      activeGraph: null,
    } as const;
    const generatedDetail = {
      ...detail,
      taskVersion: 2,
      stage: "candidate_plan" as const,
      candidatePlan: {
        revisionNumber: 1,
        steps: [
          {
            title: "Persist candidate",
            description: "Store a review-only step.",
            acceptanceCriteria: ["The step survives restart."],
          },
        ],
      },
    };
    const generateProjectTaskCandidatePlan = vi.fn(async () => ({
      status: "generated" as const,
      taskId: detail.taskId,
      detail: generatedDetail,
      catalog: {
        projectId: PROJECT_ID,
        tasks: [
          {
            taskId: detail.taskId,
            projectId: PROJECT_ID,
            taskVersion: 2,
            title: detail.title,
            objective: detail.activeRequirement.objective,
            stage: "candidate_plan" as const,
          },
        ],
        hasMore: false,
      },
    }));
    Object.assign(globalThis, {
      codexHarness: {
        generateProjectTaskCandidatePlan,
        readProjectTaskCatalog: vi.fn(),
        readProjectTaskDetail: vi.fn(),
      },
    });
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = [
      PROJECT_ID,
      { status: "loaded", catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false } },
      detail.taskId,
      { status: "loaded", detail },
      "",
      "",
      detail.activeRequirement.sourceText,
      "idle",
      "idle",
      "idle",
    ];
    const root = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
      routing: {
        configured: true,
        profileVersion: 1,
        configurationRevisionId: "00000000-0000-4000-8000-000000000899",
        tiers: {
          fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
          standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
          deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
        },
        availability: {
          fast: "observed_available",
          standard: "observed_available",
          deep: "observed_available",
        },
      },
    });
    const button = findTaskControl(root, "data-task-plan-generate");
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    await vi.waitFor(() =>
      expect(generateProjectTaskCandidatePlan).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        taskId: detail.taskId,
        expectedTaskVersion: 1,
      }),
    );
    expect(hooks.setters[9]).toHaveBeenNthCalledWith(1, "generating");
    expect(hooks.setters[9]).toHaveBeenLastCalledWith("generated");
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "loaded", detail: generatedDetail });
  });

  it("requires two explicit actions to confirm a candidate and keeps execution locked", async () => {
    const taskId = "00000000-0000-4000-8000-000000000893";
    const plan = {
      revisionNumber: 2,
      steps: [
        {
          title: "Confirm candidate",
          description: "Promote only after a second explicit action.",
          acceptanceCriteria: ["No DAG or Run is created."],
        },
      ],
    };
    const detail = {
      projectId: PROJECT_ID,
      taskId,
      taskVersion: 5,
      title: "Confirmation Task",
      stage: "active_graph_with_candidate" as const,
      activeRequirement: {
        revisionNumber: 1,
        sourceText: "Confirm only after review.",
        objective: "Confirm only after review.",
        constraints: [],
        acceptanceCriteria: [],
      },
      candidatePlan: plan,
      confirmedPlan: { ...plan, revisionNumber: 1 },
      activeGraph: {
        revisionNumber: 1,
        schedulePreview: { state: "dependency_eligible" as const, nodeNumber: 1 },
        nodes: [
          {
            nodeNumber: 1,
            sourcePlanStepNumber: 1,
            title: "Previous authority",
            description: "Current graph remains visible until confirmation.",
            acceptanceCriteria: [],
            dependsOnNodeNumbers: [],
            status: "pending" as const,
          },
        ],
      },
    };
    const confirmedDetail = {
      ...detail,
      taskVersion: 6,
      stage: "confirmed_plan" as const,
      candidatePlan: null,
      confirmedPlan: { ...plan, revisionNumber: 3 },
      activeGraph: null,
    };
    const catalog = {
      projectId: PROJECT_ID,
      tasks: [
        {
          taskId,
          projectId: PROJECT_ID,
          taskVersion: 6,
          title: detail.title,
          objective: detail.activeRequirement.objective,
          stage: "confirmed_plan" as const,
        },
      ],
      hasMore: false,
    };
    const confirmProjectTaskCandidatePlan = vi.fn(async () => ({
      status: "confirmed" as const,
      taskId,
      detail: confirmedDetail,
      catalog,
    }));
    Object.assign(globalThis, {
      codexHarness: {
        confirmProjectTaskCandidatePlan,
        readProjectTaskCatalog: vi.fn(),
        readProjectTaskDetail: vi.fn(),
      },
    });
    const render = (currentDetail: typeof detail | typeof confirmedDetail, status: string) => {
      hooks.cursor = 0;
      hooks.effects = [];
      hooks.values = [
        PROJECT_ID,
        { status: "loaded", catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false } },
        taskId,
        { status: "loaded", detail: currentDetail },
        "",
        "",
        currentDetail.activeRequirement.sourceText,
        "idle",
        "idle",
        "idle",
        status,
      ];
      return ProjectTaskPanel({
        projects: PROJECTS,
        projectRoutingBindings: {
          bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
        },
      });
    };

    const initial = render(detail, "idle");
    const begin = findTaskControl(initial, "data-task-plan-confirm");
    expect(begin.props.disabled).toBe(false);
    (begin.props.onClick as () => void)();
    expect(hooks.setters[10]).toHaveBeenLastCalledWith("reviewing");
    expect(confirmProjectTaskCandidatePlan).not.toHaveBeenCalled();

    const review = render(detail, "reviewing");
    expect(JSON.stringify(review)).toContain("使当前 DAG 失效");
    const commit = findTaskControl(review, "data-task-plan-confirm-commit");
    (commit.props.onClick as () => void)();
    await vi.waitFor(() =>
      expect(confirmProjectTaskCandidatePlan).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        taskId,
        expectedTaskVersion: 5,
        candidatePlanRevisionNumber: 2,
      }),
    );
    expect(hooks.setters[10]).toHaveBeenCalledWith("confirming");
    expect(hooks.setters[10]).toHaveBeenLastCalledWith("confirmed");
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "loaded", detail: confirmedDetail });
    expect(hooks.setters[1]).toHaveBeenCalledWith({ status: "loaded", catalog });

    const authority = render(confirmedDetail, "confirmed");
    const confirmedPlan = findElementByType(authority, CandidatePlan);
    expect(confirmedPlan?.props.kind).toBe("confirmed");
    expect(JSON.stringify(authority)).toContain("WAITING FOR DAG");
    expect(JSON.stringify(authority)).toContain("EXECUTION LOCKED");
  });

  it("materializes and renders a confirmed Plan as a locked pending DAG", async () => {
    const taskId = "00000000-0000-4000-8000-000000000898";
    const confirmedPlan = {
      revisionNumber: 2,
      steps: [
        {
          title: "Persist graph",
          description: "Create deterministic pending nodes.",
          acceptanceCriteria: ["No Run is created."],
        },
      ],
    };
    const detail = {
      projectId: PROJECT_ID,
      taskId,
      taskVersion: 3,
      title: "DAG Task",
      stage: "confirmed_plan" as const,
      activeRequirement: {
        revisionNumber: 1,
        sourceText: "Materialize a local DAG.",
        objective: "Materialize a local DAG.",
        constraints: [],
        acceptanceCriteria: [],
      },
      candidatePlan: null,
      confirmedPlan,
      activeGraph: null,
    };
    const graph = {
      revisionNumber: 1,
      schedulePreview: { state: "dependency_eligible" as const, nodeNumber: 1 },
      nodes: [
        {
          nodeNumber: 1,
          sourcePlanStepNumber: 1,
          title: "Persist graph",
          description: "Create deterministic pending nodes.",
          acceptanceCriteria: ["No Run is created."],
          dependsOnNodeNumbers: [],
          status: "pending" as const,
        },
      ],
    };
    const graphDetail = {
      ...detail,
      taskVersion: 4,
      stage: "active_graph" as const,
      activeGraph: graph,
    };
    const catalog = {
      projectId: PROJECT_ID,
      tasks: [
        {
          taskId,
          projectId: PROJECT_ID,
          taskVersion: 4,
          title: detail.title,
          objective: detail.activeRequirement.objective,
          stage: "active_graph" as const,
        },
      ],
      hasMore: false,
    };
    const materializeProjectTaskGraph = vi.fn(
      async (
        _input: unknown,
      ): Promise<
        | Readonly<{
            status: "materialized";
            taskId: string;
            detail: typeof graphDetail;
            catalog: typeof catalog;
          }>
        | Readonly<{ status: "conflict" }>
      > => {
        void _input;
        return {
          status: "materialized",
          taskId,
          detail: graphDetail,
          catalog,
        };
      },
    );
    const readProjectTaskCatalog = vi.fn();
    const readProjectTaskDetail = vi.fn();
    Object.assign(globalThis, {
      codexHarness: {
        materializeProjectTaskGraph,
        readProjectTaskCatalog,
        readProjectTaskDetail,
      },
    });
    const render = (currentDetail: typeof detail | typeof graphDetail, graphState: string) => {
      hooks.cursor = 0;
      hooks.effects = [];
      hooks.values = [
        PROJECT_ID,
        { status: "loaded", catalog },
        taskId,
        { status: "loaded", detail: currentDetail },
        "",
        "",
        currentDetail.activeRequirement.sourceText,
        "idle",
        "idle",
        "idle",
        "idle",
        graphState,
      ];
      return ProjectTaskPanel({
        projects: PROJECTS,
        projectRoutingBindings: {
          bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
        },
      });
    };

    const confirmed = render(detail, "idle");
    const create = findTaskControl(confirmed, "data-task-graph-materialize");
    expect(create.props.disabled).toBe(false);
    (create.props.onClick as () => void)();
    await vi.waitFor(() =>
      expect(materializeProjectTaskGraph).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        taskId,
        expectedTaskVersion: 3,
        confirmedPlanRevisionNumber: 2,
      }),
    );
    expect(hooks.setters[11]).toHaveBeenNthCalledWith(1, "materializing");
    expect(hooks.setters[11]).toHaveBeenLastCalledWith("materialized");
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "loaded", detail: graphDetail });

    const active = render(graphDetail, "materialized");
    const graphElement = findElementByType(active, TaskGraph);
    expect(graphElement?.props.graph).toBe(graph);
    expect(JSON.stringify(TaskGraph({ graph }))).toContain("EXECUTION LOCKED");
    expect(JSON.stringify(TaskGraph({ graph }))).toContain("T01 的依赖已满足");
    expect(JSON.stringify(TaskGraph({ graph }))).toContain("审批、路由与证据门禁尚未开放");
    expect(JSON.stringify(TaskGraph({ graph }))).toContain("起始节点");
    expect(JSON.stringify(TaskGraph({ graph }))).toContain("No Run is created.");
    for (const [schedulePreview, expectedHeadline, expectedExplanation] of [
      [
        { state: "awaiting_claim" as const, nodeNumber: 1 },
        "T01 等待串行领取",
        "当前产品仍不创建 Run",
      ],
      [{ state: "busy" as const, nodeNumber: 1 }, "T01 正在运行", "不会同时领取第二个节点"],
      [{ state: "blocked" as const, blockerNodeNumbers: [1] }, "阻塞于 T01", "不会绕过依赖"],
      [{ state: "complete" as const }, "DAG 已完成", "所有节点的权威状态均为 succeeded"],
    ] as const) {
      const rendered = JSON.stringify(TaskGraph({ graph: { ...graph, schedulePreview } }));
      expect(rendered).toContain(expectedHeadline);
      expect(rendered).toContain(expectedExplanation);
    }
    expect(taskGraphMaterializationFeedback("idle", false)).toContain("不调用模型");
    expect(taskGraphMaterializationFeedback("idle", true)).toContain("pending");
    expect(taskGraphMaterializationFeedback("materializing", false)).toContain("原子提交");
    expect(taskGraphMaterializationFeedback("existing", true)).toContain("已经落盘");
    expect(taskGraphMaterializationFeedback("conflict", false)).toContain("已刷新");
    expect(taskGraphMaterializationFeedback("unavailable", false)).toContain("结果当前未知");

    materializeProjectTaskGraph.mockResolvedValueOnce({ status: "conflict" as const });
    readProjectTaskDetail.mockResolvedValueOnce({ status: "loaded", detail });
    readProjectTaskCatalog.mockResolvedValueOnce({ status: "loaded", catalog });
    const conflicted = render(detail, "idle");
    (findTaskControl(conflicted, "data-task-graph-materialize").props.onClick as () => void)();
    await vi.waitFor(() => expect(readProjectTaskDetail).toHaveBeenCalled());
    expect(hooks.setters[3]).toHaveBeenLastCalledWith({ status: "loaded", detail });
    expect(hooks.setters[1]).toHaveBeenLastCalledWith({ status: "loaded", catalog });

    materializeProjectTaskGraph.mockRejectedValueOnce(new Error("contained"));
    const unavailable = render(detail, "idle");
    (findTaskControl(unavailable, "data-task-graph-materialize").props.onClick as () => void)();
    await vi.waitFor(() => expect(hooks.setters[11]).toHaveBeenLastCalledWith("unavailable"));
  });

  it("refreshes authority after confirmation conflicts and contains confirmation failures", async () => {
    const taskId = "00000000-0000-4000-8000-000000000894";
    const detail = {
      projectId: PROJECT_ID,
      taskId,
      taskVersion: 4,
      title: "Concurrent confirmation Task",
      stage: "candidate_plan" as const,
      activeRequirement: {
        revisionNumber: 2,
        sourceText: "Refresh after a stale confirmation.",
        objective: "Refresh after a stale confirmation.",
        constraints: [],
        acceptanceCriteria: [],
      },
      candidatePlan: {
        revisionNumber: 2,
        basedOnRequirementRevisionNumber: 2,
        status: "candidate" as const,
        steps: [
          {
            title: "Review concurrent authority",
            description: "Do not confirm a stale candidate.",
            acceptanceCriteria: ["The current authority is reloaded."],
          },
        ],
      },
      confirmedPlan: null,
      activeGraph: null,
    };
    const catalog = {
      projectId: PROJECT_ID,
      tasks: [
        {
          taskId,
          projectId: PROJECT_ID,
          taskVersion: detail.taskVersion,
          title: detail.title,
          objective: detail.activeRequirement.objective,
          stage: detail.stage,
        },
      ],
      hasMore: false,
    };
    const confirmProjectTaskCandidatePlan = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict" })
      .mockRejectedValueOnce(new Error("contained"));
    const readProjectTaskDetail = vi.fn(async () => ({ status: "loaded" as const, detail }));
    const readProjectTaskCatalog = vi.fn(async () => ({ status: "loaded" as const, catalog }));
    Object.assign(globalThis, {
      codexHarness: {
        confirmProjectTaskCandidatePlan,
        readProjectTaskCatalog,
        readProjectTaskDetail,
      },
    });
    const render = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      hooks.values = [
        PROJECT_ID,
        { status: "loaded", catalog },
        taskId,
        { status: "loaded", detail },
        "",
        "",
        detail.activeRequirement.sourceText,
        "idle",
        "idle",
        "idle",
        "reviewing",
      ];
      return ProjectTaskPanel({
        projects: PROJECTS,
        projectRoutingBindings: {
          bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
        },
      });
    };

    const conflicted = render();
    expect(JSON.stringify(conflicted)).toContain("不会创建 DAG、Run");
    (findTaskControl(conflicted, "data-task-plan-confirm-commit").props.onClick as () => void)();
    await vi.waitFor(() => expect(hooks.setters[10]).toHaveBeenLastCalledWith("conflict"));
    expect(readProjectTaskDetail).toHaveBeenCalledWith({ projectId: PROJECT_ID, taskId });
    expect(readProjectTaskCatalog).toHaveBeenCalledWith(PROJECT_ID);
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "loaded", detail });
    expect(hooks.setters[1]).toHaveBeenCalledWith({ status: "loaded", catalog });
    expect(hooks.setters[6]).toHaveBeenCalledWith(detail.activeRequirement.sourceText);
    expect(hooks.setters[9]).toHaveBeenCalledWith("idle");

    const unavailable = render();
    (findTaskControl(unavailable, "data-task-plan-confirm-commit").props.onClick as () => void)();
    await vi.waitFor(() => expect(hooks.setters[10]).toHaveBeenLastCalledWith("unavailable"));
  });

  it("refreshes authority after generation conflicts and contains unknown failures", async () => {
    const taskId = "00000000-0000-4000-8000-000000000892";
    const detail = {
      projectId: PROJECT_ID,
      taskId,
      taskVersion: 2,
      title: "Concurrent candidate Task",
      stage: "requirements_only" as const,
      activeRequirement: {
        revisionNumber: 2,
        sourceText: "Concurrent requirement.",
        objective: "Concurrent requirement.",
        constraints: [],
        acceptanceCriteria: [],
      },
      candidatePlan: null,
      confirmedPlan: null,
      activeGraph: null,
    };
    const catalog = {
      projectId: PROJECT_ID,
      tasks: [
        {
          taskId,
          projectId: PROJECT_ID,
          taskVersion: 2,
          title: detail.title,
          objective: detail.activeRequirement.objective,
          stage: "requirements_only" as const,
        },
      ],
      hasMore: false,
    };
    const generateProjectTaskCandidatePlan = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict" })
      .mockRejectedValueOnce(new Error("contained"));
    const readProjectTaskDetail = vi.fn(async () => ({ status: "loaded" as const, detail }));
    const readProjectTaskCatalog = vi.fn(async () => ({ status: "loaded" as const, catalog }));
    Object.assign(globalThis, {
      codexHarness: {
        generateProjectTaskCandidatePlan,
        readProjectTaskCatalog,
        readProjectTaskDetail,
      },
    });
    const routing = {
      configured: true as const,
      profileVersion: 1,
      configurationRevisionId: "00000000-0000-4000-8000-000000000899",
      tiers: {
        fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
        standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
      },
      availability: {
        fast: "observed_available" as const,
        standard: "observed_available" as const,
        deep: "observed_available" as const,
      },
    } as const;
    const values = [
      PROJECT_ID,
      { status: "loaded", catalog },
      taskId,
      { status: "loaded", detail },
      "",
      "",
      detail.activeRequirement.sourceText,
      "idle",
      "idle",
      "idle",
    ];

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values;
    const conflicted = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
      routing,
    });
    (findTaskControl(conflicted, "data-task-plan-generate").props.onClick as () => void)();
    await vi.waitFor(() => expect(hooks.setters[9]).toHaveBeenLastCalledWith("conflict"));
    expect(readProjectTaskDetail).toHaveBeenCalledWith({ projectId: PROJECT_ID, taskId });
    expect(readProjectTaskCatalog).toHaveBeenCalledWith(PROJECT_ID);
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "loaded", detail });
    expect(hooks.setters[1]).toHaveBeenCalledWith({ status: "loaded", catalog });
    expect(hooks.setters[6]).toHaveBeenCalledWith(detail.activeRequirement.sourceText);

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values;
    const unavailable = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
      routing,
    });
    (findTaskControl(unavailable, "data-task-plan-generate").props.onClick as () => void)();
    await vi.waitFor(() => expect(hooks.setters[9]).toHaveBeenLastCalledWith("unavailable"));
  });

  it("submits one bounded Task draft and replaces the local catalog from authority", async () => {
    const catalog = {
      projectId: PROJECT_ID,
      tasks: [
        {
          taskId: "00000000-0000-4000-8000-000000000892",
          projectId: PROJECT_ID,
          taskVersion: 1,
          title: "Task title",
          objective: "Persist this requirement.",
          stage: "requirements_only" as const,
        },
      ],
      hasMore: false,
    };
    const createProjectTask = vi.fn(async () => ({
      status: "created" as const,
      taskId: catalog.tasks[0]!.taskId,
      catalog,
    }));
    Object.assign(globalThis, {
      codexHarness: {
        createProjectTask,
        readProjectTaskCatalog: vi.fn(),
      },
    });

    const button = findTaskCreateButton(renderTaskPanel());
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(createProjectTask).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT_ID,
      title: "Task title",
      sourceText: "Persist this requirement.",
    });
    expect(hooks.setters[7]).toHaveBeenNthCalledWith(1, "creating");
    expect(hooks.setters[1]).toHaveBeenCalledWith({ status: "loaded", catalog });
    expect(hooks.setters[2]).toHaveBeenCalledWith(catalog.tasks[0]!.taskId);
    expect(hooks.setters[4]).toHaveBeenCalledWith("");
    expect(hooks.setters[5]).toHaveBeenCalledWith("");
    expect(hooks.setters[7]).toHaveBeenLastCalledWith("created");

    const pending = findTaskCreateButton(renderTaskPanel("creating"));
    expect(pending.props.disabled).toBe(true);
    (pending.props.onClick as () => void)();
    expect(createProjectTask).toHaveBeenCalledTimes(1);

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = [
      PROJECT_ID,
      { status: "loaded", catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false } },
      undefined,
      { status: "idle" },
      "中".repeat(100),
      "Persist this requirement.",
      "",
      "idle",
      "idle",
    ];
    const oversized = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    expect(findTaskCreateButton(oversized).props.disabled).toBe(true);
  });

  it("lazy-loads catalog states and contains read failures", async () => {
    const readProjectTaskCatalog = vi
      .fn()
      .mockResolvedValueOnce({
        status: "loaded",
        catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false },
      })
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockRejectedValueOnce(new Error("contained"));
    Object.assign(globalThis, {
      codexHarness: { createProjectTask: vi.fn(), readProjectTaskCatalog },
    });

    renderTaskPanel();
    const cleanup = hooks.effects[1]!();
    await Promise.resolve();
    expect(hooks.setters[1]).toHaveBeenNthCalledWith(1, { status: "loading" });
    expect(hooks.setters[1]).toHaveBeenNthCalledWith(2, {
      status: "loaded",
      catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false },
    });
    expect(typeof cleanup).toBe("function");
    cleanup?.();

    renderTaskPanel();
    hooks.effects[1]!();
    await Promise.resolve();
    expect(hooks.setters[1]).toHaveBeenLastCalledWith({ status: "unavailable" });

    renderTaskPanel();
    hooks.effects[1]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.setters[1]).toHaveBeenLastCalledWith({ status: "unavailable" });

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = [
      undefined,
      { status: "idle" },
      undefined,
      { status: "idle" },
      "",
      "",
      "",
      "idle",
      "idle",
    ];
    ProjectTaskPanel({
      projects: { projects: [], hasMore: false },
      projectRoutingBindings: { bindings: [] },
    });
    hooks.effects[0]!();
    hooks.effects[1]!();
    hooks.effects[2]!();
    expect(hooks.setters[0]).toHaveBeenCalledWith(undefined);
    expect(hooks.setters[1]).toHaveBeenLastCalledWith({ status: "idle" });
    expect(hooks.setters[3]).toHaveBeenLastCalledWith({ status: "idle" });
  });

  it("contains creation outcomes and exercises the bounded form controls", async () => {
    const createProjectTask = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict" })
      .mockRejectedValueOnce(new Error("contained"));
    Object.assign(globalThis, {
      codexHarness: { createProjectTask, readProjectTaskCatalog: vi.fn() },
    });

    const conflict = renderTaskPanel("conflict");
    (
      findTaskControl(conflict, "data-task-project-select").props.onChange as (
        event: unknown,
      ) => void
    )({ currentTarget: { value: PROJECT_ID } });
    (findTaskControl(conflict, "data-task-title").props.onChange as (event: unknown) => void)({
      currentTarget: { value: "Updated title" },
    });
    (findTaskControl(conflict, "data-task-source").props.onChange as (event: unknown) => void)({
      currentTarget: { value: "Updated source" },
    });
    expect(hooks.setters[0]).toHaveBeenCalledWith(PROJECT_ID);
    expect(hooks.setters[2]).toHaveBeenCalledWith(undefined);
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "idle" });
    expect(hooks.setters[9]).toHaveBeenCalledWith("idle");
    expect(hooks.setters[4]).toHaveBeenCalledWith("Updated title");
    expect(hooks.setters[5]).toHaveBeenCalledWith("Updated source");
    const button = findTaskCreateButton(conflict);
    (button.props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.setters[7]).toHaveBeenLastCalledWith("conflict");

    const failure = renderTaskPanel("unavailable");
    (findTaskCreateButton(failure).props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.setters[7]).toHaveBeenLastCalledWith("unavailable");

    for (const status of ["existing", "routing_unbound"] as const) {
      renderTaskPanel(status);
    }

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = [
      PROJECT_ID,
      {
        status: "loaded",
        catalog: {
          projectId: PROJECT_ID,
          tasks: [
            {
              taskId: "00000000-0000-4000-8000-000000000892",
              projectId: PROJECT_ID,
              taskVersion: 1,
              title: "Listed Task",
              objective: "Listed objective",
              stage: "active_graph_with_candidate",
            },
          ],
          hasMore: true,
        },
      },
      "00000000-0000-4000-8000-000000000892",
      { status: "idle" },
      "",
      "",
      "",
      "idle",
      "idle",
    ];
    ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }],
      },
    });
  });

  it("loads Task detail and preserves explicit Requirement revision outcomes", async () => {
    const taskId = "00000000-0000-4000-8000-000000000896";
    const detail = {
      projectId: PROJECT_ID,
      taskId,
      taskVersion: 1,
      title: "Revisable Task",
      stage: "requirements_only" as const,
      activeRequirement: {
        revisionNumber: 1,
        sourceText: "Initial requirement.",
        objective: "Initial requirement.",
        constraints: ["Do not execute."],
        acceptanceCriteria: ["Persist the revision."],
      },
      candidatePlan: null,
      confirmedPlan: null,
      activeGraph: null,
    };
    const revisedDetail = {
      ...detail,
      taskVersion: 2,
      activeRequirement: {
        ...detail.activeRequirement,
        revisionNumber: 2,
        sourceText: "Revised requirement.",
        objective: "Revised requirement.",
        constraints: [],
        acceptanceCriteria: [],
      },
    };
    const catalog = {
      projectId: PROJECT_ID,
      tasks: [
        {
          taskId,
          projectId: PROJECT_ID,
          taskVersion: 2,
          title: detail.title,
          objective: revisedDetail.activeRequirement.objective,
          stage: "requirements_only" as const,
        },
      ],
      hasMore: false,
    };
    const concurrentDetail = {
      ...revisedDetail,
      taskVersion: 3,
      activeRequirement: {
        ...revisedDetail.activeRequirement,
        revisionNumber: 3,
        sourceText: "Concurrent requirement.",
        objective: "Concurrent requirement.",
      },
    };
    const concurrentCatalog = {
      ...catalog,
      tasks: [
        {
          ...catalog.tasks[0]!,
          taskVersion: 3,
          objective: concurrentDetail.activeRequirement.objective,
        },
      ],
    };
    const readProjectTaskDetail = vi
      .fn()
      .mockResolvedValue({ status: "loaded", detail: concurrentDetail })
      .mockResolvedValueOnce({ status: "loaded", detail })
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockRejectedValueOnce(new Error("contained"));
    const readProjectTaskCatalog = vi
      .fn()
      .mockResolvedValue({ status: "loaded", catalog: concurrentCatalog });
    const reviseProjectTaskRequirement = vi
      .fn()
      .mockResolvedValueOnce({
        status: "revised",
        taskId,
        detail: revisedDetail,
        catalog,
      })
      .mockResolvedValueOnce({ status: "conflict" })
      .mockResolvedValueOnce({ status: "conflict" })
      .mockRejectedValueOnce(new Error("contained"));
    Object.assign(globalThis, {
      codexHarness: {
        createProjectTask: vi.fn(),
        readProjectTaskCatalog,
        readProjectTaskDetail,
        reviseProjectTaskRequirement,
      },
    });

    const values = (detailState: unknown, requirementSource: string, revisionStatus = "idle") => [
      PROJECT_ID,
      {
        status: "loaded",
        catalog: {
          projectId: PROJECT_ID,
          tasks: [
            {
              taskId,
              projectId: PROJECT_ID,
              taskVersion: 1,
              title: detail.title,
              objective: detail.activeRequirement.objective,
              stage: "requirements_only",
            },
          ],
          hasMore: false,
        },
      },
      taskId,
      detailState,
      "",
      "",
      requirementSource,
      "idle",
      revisionStatus,
    ];

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values({ status: "loading" }, "");
    ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    const detailCleanup = hooks.effects[2]!();
    await Promise.resolve();
    expect(readProjectTaskDetail).toHaveBeenCalledWith({ projectId: PROJECT_ID, taskId });
    expect(hooks.setters[3]).toHaveBeenNthCalledWith(1, { status: "loading" });
    expect(hooks.setters[3]).toHaveBeenLastCalledWith({ status: "loaded", detail });
    expect(hooks.setters[6]).toHaveBeenCalledWith("Initial requirement.");
    detailCleanup?.();

    for (const expectedCalls of [2, 3]) {
      hooks.cursor = 0;
      hooks.effects = [];
      hooks.values = values({ status: "loading" }, "");
      ProjectTaskPanel({
        projects: PROJECTS,
        projectRoutingBindings: {
          bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
        },
      });
      hooks.effects[2]!();
      await Promise.resolve();
      await Promise.resolve();
      expect(readProjectTaskDetail).toHaveBeenCalledTimes(expectedCalls);
      expect(hooks.setters[3]).toHaveBeenLastCalledWith({ status: "unavailable" });
    }

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values({ status: "loaded", detail }, "Revised requirement.");
    const panel = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    (findTaskControl(panel, "data-task-open").props.onClick as () => void)();
    expect(hooks.setters[2]).toHaveBeenCalledWith(taskId);
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "loading" });
    expect(hooks.setters[9]).toHaveBeenCalledWith("idle");
    (
      findTaskControl(panel, "data-task-revision-source").props.onChange as (event: unknown) => void
    )({ currentTarget: { value: "Draft update." } });
    expect(hooks.setters[6]).toHaveBeenCalledWith("Draft update.");
    const revise = findTaskControl(panel, "data-task-revise");
    expect(revise.props.disabled).toBe(false);
    (revise.props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(reviseProjectTaskRequirement).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      taskId,
      expectedTaskVersion: 1,
      sourceText: "Revised requirement.",
    });
    expect(hooks.setters[8]).toHaveBeenCalledWith("revising");
    expect(hooks.setters[1]).toHaveBeenCalledWith({ status: "loaded", catalog });
    expect(hooks.setters[3]).toHaveBeenCalledWith({ status: "loaded", detail: revisedDetail });
    expect(hooks.setters[6]).toHaveBeenCalledWith("Revised requirement.");
    expect(hooks.setters[8]).toHaveBeenLastCalledWith("revised");

    hooks.setters[6]!.mockClear();
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values({ status: "loaded", detail }, "Revised requirement.");
    const conflicted = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    (findTaskControl(conflicted, "data-task-revise").props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(readProjectTaskDetail).toHaveBeenLastCalledWith({ projectId: PROJECT_ID, taskId });
    expect(readProjectTaskCatalog).toHaveBeenCalledWith(PROJECT_ID);
    expect(hooks.setters[3]).toHaveBeenLastCalledWith({
      status: "loaded",
      detail: concurrentDetail,
    });
    expect(hooks.setters[1]).toHaveBeenLastCalledWith({
      status: "loaded",
      catalog: concurrentCatalog,
    });
    expect(hooks.setters[6]).not.toHaveBeenCalled();
    expect(hooks.setters[8]).toHaveBeenLastCalledWith("conflict");

    readProjectTaskDetail.mockRejectedValueOnce(new Error("contained refresh"));
    readProjectTaskCatalog.mockResolvedValueOnce({ status: "unavailable" });
    hooks.setters[3]!.mockClear();
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values({ status: "loaded", detail: concurrentDetail }, "Revised requirement.");
    const conflictWithoutRefresh = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    (findTaskControl(conflictWithoutRefresh, "data-task-revise").props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.setters[3]).not.toHaveBeenCalled();
    expect(hooks.setters[8]).toHaveBeenLastCalledWith("conflict");

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values({ status: "loaded", detail: concurrentDetail }, "Revised requirement.");
    const unavailable = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    (findTaskControl(unavailable, "data-task-revise").props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.setters[8]).toHaveBeenLastCalledWith("unavailable");

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values({ status: "loaded", detail }, "Initial requirement.", "revising");
    const disabled = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    expect(findTaskControl(disabled, "data-task-revise").props.disabled).toBe(true);
    expect(findTaskControl(disabled, "data-task-project-select").props.disabled).toBe(true);
    expect(findTaskControl(disabled, "data-task-open").props.disabled).toBe(true);
    expect(findTaskControl(disabled, "data-task-title").props.disabled).toBe(true);
    expect(findTaskControl(disabled, "data-task-source").props.disabled).toBe(true);
    expect(findTaskControl(disabled, "data-task-revision-source").props.disabled).toBe(true);
    expect(findTaskCreateButton(disabled).props.disabled).toBe(true);
    (findTaskControl(disabled, "data-task-revise").props.onClick as () => void)();
    expect(reviseProjectTaskRequirement).toHaveBeenCalledTimes(4);

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values({ status: "loaded", detail }, "Revised requirement.");
    hooks.values[7] = "creating";
    const creating = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    expect(findTaskControl(creating, "data-task-revise").props.disabled).toBe(true);
    expect(findTaskControl(creating, "data-task-project-select").props.disabled).toBe(true);
    expect(findTaskControl(creating, "data-task-open").props.disabled).toBe(true);
    expect(findTaskControl(creating, "data-task-revision-source").props.disabled).toBe(true);

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = values({ status: "loaded", detail }, "Revised requirement.");
    hooks.values[9] = "generating";
    const generatingPlan = ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
      },
    });
    expect(findTaskControl(generatingPlan, "data-task-revise").props.disabled).toBe(true);

    const items = RequirementItems({ title: "Constraints", items: ["One", "Two"] });
    expect(items.props.children).toBeDefined();
  });
});
