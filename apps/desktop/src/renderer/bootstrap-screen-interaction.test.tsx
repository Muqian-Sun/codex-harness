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
  CandidatePlan,
  ProjectRegistryPanel,
  ProjectTaskPanel,
  RequirementItems,
  taskCandidatePlanFeedback,
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
    | "data-task-plan-generate"
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
