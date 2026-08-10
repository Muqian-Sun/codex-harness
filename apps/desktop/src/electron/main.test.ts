import { describe, expect, it, vi } from "vitest";

import { readyBootstrapState, type BootstrapStateStore } from "../shared/bootstrap-state.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000891";

const harness = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
  const bindProjectToDefaultRouting = vi.fn(async (projectId: string): Promise<unknown> => ({
    status: projectId === PROJECT_ID ? "bound" : "unavailable",
  }));
  const readProjectTaskCatalog = vi.fn(async (projectId: string): Promise<unknown> => {
    void projectId;
    return {
      status: "loaded" as const,
      catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false },
    };
  });
  const createProjectTask = vi.fn(async (input: unknown): Promise<unknown> => {
    void input;
    return { status: "unavailable" as const };
  });
  const readProjectTaskDetail = vi.fn(async (input: unknown): Promise<unknown> => {
    const selection = input as { projectId: string; taskId: string };
    return {
      status: "loaded" as const,
      detail: {
        projectId: selection.projectId,
        taskId: selection.taskId,
        taskVersion: 1,
        title: "Task",
        stage: "requirements_only" as const,
        activeRequirement: {
          revisionNumber: 1,
          sourceText: "Requirement",
          objective: "Requirement",
          constraints: [],
          acceptanceCriteria: [],
        },
        candidatePlan: null,
      },
    };
  });
  const reviseProjectTaskRequirement = vi.fn(async (input: unknown): Promise<unknown> => {
    void input;
    return { status: "unavailable" as const };
  });
  const generateProjectTaskCandidatePlan = vi.fn(async (input: unknown): Promise<unknown> => {
    void input;
    return { status: "unavailable" as const };
  });
  const appEvents = new Map<string, (...arguments_: unknown[]) => unknown>();
  const webContents = {
    executeJavaScript: vi.fn(async () => true),
    focus: vi.fn(),
    insertText: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const window = {
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    once: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    webContents,
  };
  return {
    appEvents,
    bindProjectToDefaultRouting,
    readProjectTaskCatalog,
    createProjectTask,
    readProjectTaskDetail,
    reviseProjectTaskRequirement,
    generateProjectTaskCandidatePlan,
    ipcHandlers,
    webContents,
    window,
  };
});

vi.mock("electron", () => ({
  app: {
    enableSandbox: vi.fn(),
    exit: vi.fn(),
    getPath: vi.fn(() => "/tmp/codex-harness-main-test"),
    isPackaged: true,
    on: vi.fn((event: string, listener: (...arguments_: unknown[]) => unknown) => {
      harness.appEvents.set(event, listener);
    }),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  },
  BrowserWindow: class {
    static fromWebContents(sender: unknown): typeof harness.window | undefined {
      return sender === harness.webContents ? harness.window : undefined;
    }

    constructor() {
      return harness.window;
    }
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) => {
      harness.ipcHandlers.set(channel, handler);
    }),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  session: {
    defaultSession: {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    },
  },
}));

vi.mock("../main/daemon-process-supervisor.js", () => ({
  DaemonProcessSupervisor: { start: vi.fn() },
  DaemonProcessSupervisorError: class extends Error {},
}));

vi.mock("./local-resource-protocol.js", () => ({
  LOCAL_RESOURCE_SCHEME: "harness",
  createLocalResourceHandler: vi.fn(() => vi.fn()),
}));

vi.mock("./runtime-resources.js", () => ({
  ensurePrivateDesktopRuntimeRoot: vi.fn(),
  ensurePrivateDesktopStateDatabasePath: vi.fn(),
  resolveDesktopRuntimeResources: vi.fn(),
}));

vi.mock("./security-boundary.js", () => ({
  RENDERER_DOCUMENT_URL: "harness://app/index.html",
  createSecureWindowOptions: vi.fn(() => ({})),
  isTrustedRendererSender: vi.fn(() => true),
}));

vi.mock("./application-controller.js", () => {
  return {
    DesktopApplicationController: class {
      readonly #stateStore: BootstrapStateStore;

      constructor(options: { stateStore: BootstrapStateStore }) {
        this.#stateStore = options.stateStore;
      }

      async start(): Promise<void> {
        this.#stateStore.transition(
          readyBootstrapState(
            { status: "not_required", credentialKind: null, planType: null },
            { provider: "openai", totalVisibleModels: 0, models: [], hasMore: false },
            {
              configured: true,
              profileVersion: 1,
              configurationRevisionId: "00000000-0000-4000-8000-000000000881",
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
            {
              projects: [
                {
                  projectId: PROJECT_ID,
                  projectVersion: 1,
                  displayName: "workspace",
                  workspace: {
                    platform: "macos",
                    absolutePath: "/Users/example/workspace",
                    identityStatus: "unverified",
                  },
                },
              ],
              hasMore: false,
            },
            {
              bindings: [{ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }],
            },
          ),
        );
      }

      async bindProjectToDefaultRouting(projectId: string): Promise<unknown> {
        return await harness.bindProjectToDefaultRouting(projectId);
      }

      async readProjectTaskCatalog(projectId: string): Promise<unknown> {
        return await harness.readProjectTaskCatalog(projectId);
      }

      async createProjectTask(input: unknown): Promise<unknown> {
        return await harness.createProjectTask(input);
      }

      async readProjectTaskDetail(input: unknown): Promise<unknown> {
        return await harness.readProjectTaskDetail(input);
      }

      async reviseProjectTaskRequirement(input: unknown): Promise<unknown> {
        return await harness.reviseProjectTaskRequirement(input);
      }

      async generateProjectTaskCandidatePlan(input: unknown): Promise<unknown> {
        return await harness.generateProjectTaskCandidatePlan(input);
      }

      async setRoutingConfiguration(): Promise<Readonly<{ status: "unavailable" }>> {
        return { status: "unavailable" };
      }

      async stop(): Promise<number> {
        return 0;
      }
    },
  };
});

describe("desktop Electron main Project Task IPC", () => {
  it("validates sender and input, keeps identifiers in main, and serializes writes", async () => {
    await import("./main.js");
    await vi.waitFor(() => {
      expect(harness.ipcHandlers.has("desktop.task.catalog_page")).toBe(true);
      expect(harness.ipcHandlers.has("desktop.task.create")).toBe(true);
      expect(harness.ipcHandlers.has("desktop.task.detail")).toBe(true);
      expect(harness.ipcHandlers.has("desktop.task.requirement.revise")).toBe(true);
    });
    const read = harness.ipcHandlers.get("desktop.task.catalog_page")!;
    const create = harness.ipcHandlers.get("desktop.task.create")!;
    const event = { sender: harness.webContents, senderFrame: {} };

    await expect(read({ sender: {}, senderFrame: {} }, PROJECT_ID)).rejects.toThrow(
      "not authorized",
    );
    await expect(read(event, "invalid")).rejects.toThrow("request is invalid");
    await expect(read(event, PROJECT_ID)).resolves.toEqual({
      status: "loaded",
      catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false },
    });
    harness.readProjectTaskCatalog.mockResolvedValueOnce({
      status: "loaded",
      catalog: {
        projectId: "00000000-0000-4000-8000-000000000892",
        tasks: [],
        hasMore: false,
      },
    });
    await expect(read(event, PROJECT_ID)).resolves.toEqual({ status: "unavailable" });

    const creation = { projectId: PROJECT_ID, title: "Task", sourceText: "Requirement" };
    await expect(create(event, { ...creation, title: " " })).rejects.toThrow(
      "creation request is invalid",
    );
    let resolveCreation!: (value: Readonly<{ status: "unavailable" }>) => void;
    harness.createProjectTask.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const first = create(event, creation);
    await vi.waitFor(() => expect(harness.createProjectTask).toHaveBeenCalledWith(creation));
    await expect(create(event, creation)).resolves.toEqual({ status: "unavailable" });
    resolveCreation({ status: "unavailable" });
    await expect(first).resolves.toEqual({ status: "unavailable" });

    harness.createProjectTask.mockResolvedValueOnce({ status: "unexpected" });
    await expect(create(event, creation)).resolves.toEqual({ status: "unavailable" });
    harness.createProjectTask.mockResolvedValueOnce({
      status: "created",
      taskId: "00000000-0000-4000-8000-000000000893",
      catalog: {
        projectId: "00000000-0000-4000-8000-000000000892",
        tasks: [],
        hasMore: false,
      },
    });
    await expect(create(event, creation)).resolves.toEqual({ status: "unavailable" });
  });

  it("validates Task detail and serializes Requirement revisions per Task", async () => {
    await import("./main.js");
    const read = harness.ipcHandlers.get("desktop.task.detail")!;
    const revise = harness.ipcHandlers.get("desktop.task.requirement.revise")!;
    const generate = harness.ipcHandlers.get("desktop.task.plan.generate_candidate")!;
    const event = { sender: harness.webContents, senderFrame: {} };
    const taskId = "00000000-0000-4000-8000-000000000894";
    const selection = { projectId: PROJECT_ID, taskId };

    await expect(read({ sender: {}, senderFrame: {} }, selection)).rejects.toThrow(
      "not authorized",
    );
    await expect(read(event, { ...selection, extra: true })).rejects.toThrow(
      "detail request is invalid",
    );
    await expect(read(event, selection)).resolves.toMatchObject({
      status: "loaded",
      detail: { projectId: PROJECT_ID, taskId, taskVersion: 1 },
    });
    harness.readProjectTaskDetail.mockResolvedValueOnce({
      status: "loaded",
      detail: {
        projectId: "00000000-0000-4000-8000-000000000895",
        taskId,
        taskVersion: 1,
        title: "Task",
        stage: "requirements_only",
        activeRequirement: {
          revisionNumber: 1,
          sourceText: "Requirement",
          objective: "Requirement",
          constraints: [],
          acceptanceCriteria: [],
        },
        candidatePlan: null,
      },
    });
    await expect(read(event, selection)).resolves.toEqual({ status: "unavailable" });

    const revision = {
      ...selection,
      expectedTaskVersion: 1,
      sourceText: "Revised Requirement",
    };
    await expect(revise(event, { ...revision, expectedTaskVersion: 0 })).rejects.toThrow(
      "revision is invalid",
    );
    let resolveRevision!: (value: Readonly<{ status: "unavailable" }>) => void;
    harness.reviseProjectTaskRequirement.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveRevision = resolve;
        }),
    );
    const first = revise(event, revision);
    await vi.waitFor(() =>
      expect(harness.reviseProjectTaskRequirement).toHaveBeenCalledWith(revision),
    );
    await expect(revise(event, revision)).resolves.toEqual({ status: "unavailable" });
    resolveRevision({ status: "unavailable" });
    await expect(first).resolves.toEqual({ status: "unavailable" });

    harness.reviseProjectTaskRequirement.mockResolvedValueOnce({ status: "unexpected" });
    await expect(revise(event, revision)).resolves.toEqual({ status: "unavailable" });
    harness.reviseProjectTaskRequirement.mockRejectedValueOnce(new Error("private"));
    await expect(revise(event, revision)).resolves.toEqual({ status: "unavailable" });

    const generation = { ...selection, expectedTaskVersion: 1 };
    await expect(generate(event, { ...generation, extra: true })).rejects.toThrow(
      "candidate Plan generation is invalid",
    );
    let resolveGeneration!: (value: Readonly<{ status: "unavailable" }>) => void;
    harness.generateProjectTaskCandidatePlan.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const pendingGeneration = generate(event, generation);
    await vi.waitFor(() =>
      expect(harness.generateProjectTaskCandidatePlan).toHaveBeenCalledWith(generation),
    );
    await expect(generate(event, generation)).resolves.toEqual({ status: "unavailable" });
    await expect(revise(event, revision)).resolves.toEqual({ status: "unavailable" });
    resolveGeneration({ status: "unavailable" });
    await expect(pendingGeneration).resolves.toEqual({ status: "unavailable" });

    const detail = await harness.readProjectTaskDetail(selection);
    harness.generateProjectTaskCandidatePlan.mockResolvedValueOnce({
      status: "generated",
      taskId,
      detail: (detail as { detail: unknown }).detail,
      catalog: { projectId: PROJECT_ID, tasks: [], hasMore: false },
    });
    await expect(generate(event, generation)).resolves.toMatchObject({
      status: "generated",
      taskId,
    });
  });
});

describe("desktop Electron main Project routing binding IPC", () => {
  it("validates ownership and Project identity, serializes writes, and contains failures", async () => {
    await import("./main.js");
    await vi.waitFor(() => {
      expect(harness.ipcHandlers.has("desktop.project.routing.bind_default")).toBe(true);
    });
    const handler = harness.ipcHandlers.get("desktop.project.routing.bind_default")!;
    const event = { sender: harness.webContents, senderFrame: {} };

    await expect(handler({ sender: {}, senderFrame: {} }, PROJECT_ID)).rejects.toThrow(
      "not authorized",
    );
    await expect(handler(event, "not-a-project-id")).rejects.toThrow("request is invalid");

    let resolveBinding!: (result: Readonly<{ status: "bound" }>) => void;
    harness.bindProjectToDefaultRouting.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveBinding = resolve;
        }),
    );
    const first = handler(event, PROJECT_ID);
    await vi.waitFor(() => {
      expect(harness.bindProjectToDefaultRouting).toHaveBeenCalledWith(PROJECT_ID);
    });
    await expect(handler(event, PROJECT_ID)).resolves.toEqual({ status: "unavailable" });
    resolveBinding({ status: "bound" });
    await expect(first).resolves.toEqual({ status: "bound" });

    harness.bindProjectToDefaultRouting.mockRejectedValueOnce(new Error("contained"));
    await expect(handler(event, PROJECT_ID)).resolves.toEqual({ status: "unavailable" });
    harness.bindProjectToDefaultRouting.mockResolvedValueOnce({ status: "unexpected" });
    await expect(handler(event, PROJECT_ID)).resolves.toEqual({ status: "unavailable" });
  });
});
