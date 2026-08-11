import Module from "node:module";

import { describe, expect, it, vi } from "vitest";

const PROJECT_ID = "00000000-0000-4000-8000-000000000891";

const harness = vi.hoisted(() => ({
  api: undefined as unknown,
  invoke: vi.fn(),
}));

const electron = {
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, api: unknown) => {
      harness.api = api;
    }),
  },
  ipcRenderer: {
    invoke: harness.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
};

type ExposedApi = Readonly<{
  getBootstrapState(): Promise<unknown>;
  bindProjectToDefaultRouting(projectId: string): Promise<unknown>;
  readProjectTaskCatalog(projectId: string): Promise<unknown>;
  createProjectTask(input: unknown): Promise<unknown>;
  readProjectTaskDetail(input: unknown): Promise<unknown>;
  reviseProjectTaskRequirement(input: unknown): Promise<unknown>;
  generateProjectTaskCandidatePlan(input: unknown): Promise<unknown>;
  confirmProjectTaskCandidatePlan(input: unknown): Promise<unknown>;
}>;

function readyState(binding: unknown): unknown {
  return {
    phase: "ready",
    account: { status: "not_required", credentialKind: null, planType: null },
    catalog: {
      provider: "openai",
      totalVisibleModels: 0,
      models: [],
      hasMore: false,
    },
    routing: {
      configured: false,
      profileVersion: 0,
      configurationRevisionId: null,
      tiers: null,
      availability: null,
    },
    projects: {
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
    projectRoutingBindings: { bindings: [binding] },
  };
}

describe("desktop preload Project routing binding boundary", () => {
  it("strictly decodes bootstrap bindings and the minimal mutation API", async () => {
    const moduleLoader = Module as unknown as {
      _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = (request, parent, isMain) =>
      request === "electron" ? electron : originalLoad(request, parent, isMain);
    try {
      await import("./index.cjs");
    } finally {
      moduleLoader._load = originalLoad;
    }
    const api = harness.api as ExposedApi;
    expect(api).toBeDefined();

    harness.invoke.mockResolvedValueOnce(
      readyState({ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }),
    );
    await expect(api.getBootstrapState()).resolves.toMatchObject({
      phase: "ready",
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }],
      },
    });

    harness.invoke.mockResolvedValueOnce(
      readyState({ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }),
    );
    await expect(api.getBootstrapState()).resolves.toMatchObject({
      projectRoutingBindings: { bindings: [{ status: "default_bound", bindingVersion: 1 }] },
    });

    for (const invalidBinding of [
      { projectId: PROJECT_ID, status: "unbound", bindingVersion: 1 },
      { projectId: PROJECT_ID, status: "default_bound", bindingVersion: null },
      {
        projectId: "00000000-0000-4000-8000-000000000892",
        status: "unbound",
        bindingVersion: null,
      },
    ]) {
      harness.invoke.mockResolvedValueOnce(readyState(invalidBinding));
      await expect(api.getBootstrapState()).rejects.toThrow("bootstrap state is invalid");
    }
    harness.invoke.mockResolvedValueOnce({
      ...(readyState({ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }) as object),
      projectRoutingBindings: { bindings: [] },
    });
    await expect(api.getBootstrapState()).rejects.toThrow("bootstrap state is invalid");

    await expect(api.bindProjectToDefaultRouting("invalid")).rejects.toThrow(
      "valid desktop Project identifier",
    );
    for (const status of [
      "bound",
      "existing",
      "conflict",
      "routing_unconfigured",
      "unavailable",
    ] as const) {
      harness.invoke.mockResolvedValueOnce({ status });
      await expect(api.bindProjectToDefaultRouting(PROJECT_ID)).resolves.toEqual({ status });
    }
    harness.invoke.mockResolvedValueOnce({ status: "unexpected" });
    await expect(api.bindProjectToDefaultRouting(PROJECT_ID)).rejects.toThrow(
      "routing binding result is invalid",
    );

    const taskId = "00000000-0000-4000-8000-000000000893";
    const catalog = {
      projectId: PROJECT_ID,
      tasks: [
        {
          taskId,
          projectId: PROJECT_ID,
          taskVersion: 1,
          title: "Persist Task",
          objective: "Persist without execution.",
          stage: "requirements_only",
        },
      ],
      hasMore: false,
    };
    await expect(api.readProjectTaskCatalog("invalid")).rejects.toThrow(
      "valid desktop Project identifier",
    );
    harness.invoke.mockResolvedValueOnce({ status: "loaded", catalog });
    await expect(api.readProjectTaskCatalog(PROJECT_ID)).resolves.toEqual({
      status: "loaded",
      catalog,
    });
    expect(harness.invoke).toHaveBeenLastCalledWith("desktop.task.catalog_page", PROJECT_ID);
    harness.invoke.mockResolvedValueOnce({ status: "unavailable" });
    await expect(api.readProjectTaskCatalog(PROJECT_ID)).resolves.toEqual({
      status: "unavailable",
    });
    harness.invoke.mockResolvedValueOnce({ status: "unexpected" });
    await expect(api.readProjectTaskCatalog(PROJECT_ID)).rejects.toThrow(
      "Project Task catalog result is invalid",
    );
    harness.invoke.mockResolvedValueOnce({
      status: "loaded",
      catalog: {
        projectId: "00000000-0000-4000-8000-000000000894",
        tasks: [],
        hasMore: false,
      },
    });
    await expect(api.readProjectTaskCatalog(PROJECT_ID)).rejects.toThrow(
      "Project Task catalog result is invalid",
    );

    const creation = {
      projectId: PROJECT_ID,
      title: "Persist Task",
      sourceText: "Persist without execution.",
    };
    await expect(api.createProjectTask({ ...creation, title: " " })).rejects.toThrow(
      "valid desktop Project Task",
    );
    harness.invoke.mockResolvedValueOnce({ status: "created", taskId, catalog });
    await expect(api.createProjectTask(creation)).resolves.toEqual({
      status: "created",
      taskId,
      catalog,
    });
    expect(harness.invoke).toHaveBeenLastCalledWith("desktop.task.create", creation);
    harness.invoke.mockResolvedValueOnce({ status: "conflict" });
    await expect(api.createProjectTask(creation)).resolves.toEqual({ status: "conflict" });
    harness.invoke.mockResolvedValueOnce({
      status: "created",
      taskId,
      catalog: { ...catalog, privateCursor: "secret" },
    });
    await expect(api.createProjectTask(creation)).rejects.toThrow(
      "Project Task creation result is invalid",
    );
    harness.invoke.mockResolvedValueOnce({
      status: "created",
      taskId,
      catalog: { ...catalog, tasks: [catalog.tasks[0], catalog.tasks[0]] },
    });
    await expect(api.createProjectTask(creation)).rejects.toThrow(
      "Project Task creation result is invalid",
    );
    harness.invoke.mockResolvedValueOnce({
      status: "created",
      taskId,
      catalog: {
        ...catalog,
        tasks: [{ ...catalog.tasks[0], stage: "unknown_stage" }],
      },
    });
    await expect(api.createProjectTask(creation)).rejects.toThrow(
      "Project Task creation result is invalid",
    );
    harness.invoke.mockResolvedValueOnce({
      status: "created",
      taskId,
      catalog: {
        projectId: "00000000-0000-4000-8000-000000000894",
        tasks: [],
        hasMore: false,
      },
    });
    await expect(api.createProjectTask(creation)).rejects.toThrow(
      "Project Task creation result is invalid",
    );

    const selection = { projectId: PROJECT_ID, taskId };
    const detail = {
      projectId: PROJECT_ID,
      taskId,
      taskVersion: 1,
      title: "Persist Task",
      stage: "candidate_plan",
      activeRequirement: {
        revisionNumber: 1,
        sourceText: "Persist without execution.",
        objective: "Persist without execution.",
        constraints: [],
        acceptanceCriteria: [],
      },
      candidatePlan: {
        revisionNumber: 1,
        steps: [
          {
            title: "Generate plan",
            description: "Persist a review-only candidate.",
            acceptanceCriteria: ["It survives restart."],
          },
        ],
      },
      confirmedPlan: null,
    };
    await expect(api.readProjectTaskDetail({ ...selection, extra: true })).rejects.toThrow(
      "valid desktop Project Task selection",
    );
    harness.invoke.mockResolvedValueOnce({ status: "loaded", detail });
    await expect(api.readProjectTaskDetail(selection)).resolves.toEqual({
      status: "loaded",
      detail,
    });
    expect(harness.invoke).toHaveBeenLastCalledWith("desktop.task.detail", selection);
    harness.invoke.mockResolvedValueOnce({
      status: "loaded",
      detail: { ...detail, stage: "requirements_only" },
    });
    await expect(api.readProjectTaskDetail(selection)).rejects.toThrow(
      "Project Task detail result is invalid",
    );
    harness.invoke.mockResolvedValueOnce({ status: "unavailable" });
    await expect(api.readProjectTaskDetail(selection)).resolves.toEqual({ status: "unavailable" });
    harness.invoke.mockResolvedValueOnce({
      status: "loaded",
      detail: { ...detail, projectId: "00000000-0000-4000-8000-000000000894" },
    });
    await expect(api.readProjectTaskDetail(selection)).rejects.toThrow(
      "Project Task detail result is invalid",
    );

    const revision = {
      ...selection,
      expectedTaskVersion: 1,
      sourceText: "Persist the revised Requirement.",
    };
    await expect(
      api.reviseProjectTaskRequirement({ ...revision, expectedTaskVersion: 0 }),
    ).rejects.toThrow("valid desktop Project Task Requirement revision");
    harness.invoke.mockResolvedValueOnce({ status: "revised", taskId, detail, catalog });
    await expect(api.reviseProjectTaskRequirement(revision)).resolves.toEqual({
      status: "revised",
      taskId,
      detail,
      catalog,
    });
    expect(harness.invoke).toHaveBeenLastCalledWith("desktop.task.requirement.revise", revision);
    harness.invoke.mockResolvedValueOnce({ status: "conflict" });
    await expect(api.reviseProjectTaskRequirement(revision)).resolves.toEqual({
      status: "conflict",
    });
    harness.invoke.mockResolvedValueOnce({
      status: "revised",
      taskId,
      detail: { ...detail, taskId: "00000000-0000-4000-8000-000000000895" },
      catalog,
    });
    await expect(api.reviseProjectTaskRequirement(revision)).rejects.toThrow(
      "Project Task Requirement result is invalid",
    );

    const generation = { ...selection, expectedTaskVersion: 1 };
    await expect(
      api.generateProjectTaskCandidatePlan({ ...generation, expectedTaskVersion: 0 }),
    ).rejects.toThrow("valid desktop Project Task candidate Plan request");
    harness.invoke.mockResolvedValueOnce({ status: "generated", taskId, detail, catalog });
    await expect(api.generateProjectTaskCandidatePlan(generation)).resolves.toEqual({
      status: "generated",
      taskId,
      detail,
      catalog,
    });
    expect(harness.invoke).toHaveBeenLastCalledWith(
      "desktop.task.plan.generate_candidate",
      generation,
    );
    harness.invoke.mockResolvedValueOnce({ status: "conflict" });
    await expect(api.generateProjectTaskCandidatePlan(generation)).resolves.toEqual({
      status: "conflict",
    });
    harness.invoke.mockResolvedValueOnce({
      status: "generated",
      taskId,
      detail: { ...detail, candidatePlan: { revisionNumber: 1, steps: [] } },
      catalog,
    });
    await expect(api.generateProjectTaskCandidatePlan(generation)).rejects.toThrow(
      "Project Task candidate Plan result is invalid",
    );

    const confirmation = { ...generation, candidatePlanRevisionNumber: 1 };
    await expect(
      api.confirmProjectTaskCandidatePlan({ ...confirmation, candidatePlanRevisionNumber: 0 }),
    ).rejects.toThrow("valid desktop Project Task candidate Plan confirmation");
    const confirmedDetail = {
      ...detail,
      taskVersion: 2,
      stage: "confirmed_plan",
      candidatePlan: null,
      confirmedPlan: { ...detail.candidatePlan, revisionNumber: 2 },
    };
    harness.invoke.mockResolvedValueOnce({
      status: "confirmed",
      taskId,
      detail: confirmedDetail,
      catalog,
    });
    await expect(api.confirmProjectTaskCandidatePlan(confirmation)).resolves.toEqual({
      status: "confirmed",
      taskId,
      detail: confirmedDetail,
      catalog,
    });
    expect(harness.invoke).toHaveBeenLastCalledWith(
      "desktop.task.plan.confirm_candidate",
      confirmation,
    );
    harness.invoke.mockResolvedValueOnce({ status: "conflict" });
    await expect(api.confirmProjectTaskCandidatePlan(confirmation)).resolves.toEqual({
      status: "conflict",
    });
    harness.invoke.mockResolvedValueOnce({
      status: "confirmed",
      taskId,
      detail,
      catalog,
    });
    await expect(api.confirmProjectTaskCandidatePlan(confirmation)).rejects.toThrow(
      "candidate Plan confirmation result is invalid",
    );
  });
});
