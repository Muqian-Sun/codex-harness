import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "00000000-0000-4000-8000-000000000891";
const hooks = vi.hoisted(() => ({
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  setters: [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()],
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

import { ProjectRegistryPanel, ProjectTaskPanel } from "./bootstrap-screen.js";

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
  attribute: "data-task-project-select" | "data-task-source" | "data-task-title",
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
    "Task title",
    "Persist this requirement.",
    mutationStatus,
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
    expect(hooks.setters[4]).toHaveBeenNthCalledWith(1, "creating");
    expect(hooks.setters[1]).toHaveBeenCalledWith({ status: "loaded", catalog });
    expect(hooks.setters[2]).toHaveBeenCalledWith("");
    expect(hooks.setters[3]).toHaveBeenCalledWith("");
    expect(hooks.setters[4]).toHaveBeenLastCalledWith("created");

    const pending = findTaskCreateButton(renderTaskPanel("creating"));
    expect(pending.props.disabled).toBe(true);
    (pending.props.onClick as () => void)();
    expect(createProjectTask).toHaveBeenCalledTimes(1);

    hooks.cursor = 0;
    hooks.effects = [];
    hooks.values = [
      PROJECT_ID,
      { status: "loaded", catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false } },
      "中".repeat(100),
      "Persist this requirement.",
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
    hooks.values = [undefined, { status: "idle" }, "", "", "idle"];
    ProjectTaskPanel({
      projects: { projects: [], hasMore: false },
      projectRoutingBindings: { bindings: [] },
    });
    hooks.effects[0]!();
    hooks.effects[1]!();
    expect(hooks.setters[0]).toHaveBeenCalledWith(undefined);
    expect(hooks.setters[1]).toHaveBeenLastCalledWith({ status: "idle" });
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
    expect(hooks.setters[2]).toHaveBeenCalledWith("Updated title");
    expect(hooks.setters[3]).toHaveBeenCalledWith("Updated source");
    const button = findTaskCreateButton(conflict);
    (button.props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.setters[4]).toHaveBeenLastCalledWith("conflict");

    const failure = renderTaskPanel("unavailable");
    (findTaskCreateButton(failure).props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.setters[4]).toHaveBeenLastCalledWith("unavailable");

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
      "",
      "",
      "idle",
    ];
    ProjectTaskPanel({
      projects: PROJECTS,
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }],
      },
    });
  });
});
