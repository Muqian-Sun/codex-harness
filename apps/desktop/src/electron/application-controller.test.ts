import { describe, expect, it, vi } from "vitest";

import { DaemonProcessSupervisorError } from "../main/daemon-process-supervisor.js";
import type { DaemonProcessSupervisorCloseResult } from "../main/daemon-process-supervisor.js";
import { HarnessRpcClientError } from "../main/harness-rpc-client.js";
import { BootstrapStateStore } from "../shared/bootstrap-state.js";
import {
  DesktopApplicationController,
  mapBootstrapFailure,
  type DesktopApplicationControllerConfig,
  type DesktopSupervisorHandle,
} from "./application-controller.js";
import { DesktopRuntimeResourceError } from "./runtime-resources.js";

const ACCOUNT_STATUS = Object.freeze({
  schemaVersion: 1 as const,
  snapshotId: "00000000-0000-4000-8000-000000000841",
  workerSessionId: "00000000-0000-4000-8000-000000000842",
  observedAtMs: 1_750_000_000_001,
  status: "authenticated" as const,
  credentialKind: "chatgpt" as const,
  planType: "plus" as const,
});

const UPDATED_ACCOUNT_STATUS = Object.freeze({
  ...ACCOUNT_STATUS,
  snapshotId: "00000000-0000-4000-8000-000000000843",
  observedAtMs: 1_750_000_000_002,
  planType: "pro" as const,
});

const MODEL_CATALOG_PAGE = Object.freeze({
  schemaVersion: 1 as const,
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
  nextCursor: null,
});

const CATALOG_SUMMARY = Object.freeze({
  provider: "openai",
  totalVisibleModels: 2,
  models: MODEL_CATALOG_PAGE.models,
  hasMore: false,
});

const ROUTING_CONFIGURATION = Object.freeze({
  schemaVersion: 1 as const,
  configured: false,
  profileVersion: 0,
  configurationRevisionId: null,
  tiers: null,
  availability: null,
});

const ROUTING_SUMMARY = Object.freeze({
  configured: false,
  profileVersion: 0,
  configurationRevisionId: null,
  tiers: null,
  availability: null,
});

const CONFIGURED_ROUTING = Object.freeze({
  schemaVersion: 1 as const,
  configured: true,
  profileVersion: 1,
  configurationRevisionId: "00000000-0000-4000-8000-000000000871",
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

const PROJECT = Object.freeze({
  projectId: "00000000-0000-4000-8000-000000000881",
  projectVersion: 1 as const,
  displayName: "workspace",
  workspace: Object.freeze({
    platform: "macos" as const,
    absolutePath: "/Users/example/workspace",
    identityStatus: "unverified" as const,
  }),
});

const EMPTY_PROJECT_CATALOG_PAGE = Object.freeze({
  schemaVersion: 1 as const,
  projects: Object.freeze([]),
  nextCursor: null,
});

const EMPTY_PROJECTS = Object.freeze({ projects: Object.freeze([]), hasMore: false });
const EMPTY_PROJECT_ROUTING_BINDINGS = Object.freeze({ bindings: Object.freeze([]) });

function routingBindingStatusPage(projectIds: readonly string[]) {
  return Object.freeze({
    schemaVersion: 1 as const,
    statuses: Object.freeze(
      projectIds.map((projectId) =>
        Object.freeze({ projectId, status: "unbound" as const, binding: null }),
      ),
    ),
  });
}

function routingMethods(): Pick<
  DesktopSupervisorHandle,
  "readRoutingConfiguration" | "setRoutingConfiguration"
> {
  return {
    readRoutingConfiguration: vi.fn(async () => ROUTING_CONFIGURATION),
    setRoutingConfiguration: vi.fn(async () => ROUTING_CONFIGURATION),
  };
}

function projectMethods(): Pick<
  DesktopSupervisorHandle,
  | "readProjectCatalogPage"
  | "registerProject"
  | "readProjectRoutingBindingStatuses"
  | "bindProjectDefaultRouting"
  | "readProjectTaskCatalogPage"
  | "createProjectTask"
  | "readProjectTaskDetail"
  | "reviseProjectTaskRequirement"
> {
  return {
    readProjectCatalogPage: vi.fn(async () => EMPTY_PROJECT_CATALOG_PAGE),
    registerProject: vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "registered" as const,
      project: PROJECT,
    })),
    readProjectRoutingBindingStatuses: vi.fn(async ({ projectIds }) =>
      routingBindingStatusPage(projectIds),
    ),
    bindProjectDefaultRouting: vi.fn(async (params) => ({
      schemaVersion: 1 as const,
      status: "bound" as const,
      binding: {
        projectId: params.projectId,
        bindingVersion: params.expectedBindingVersion + 1,
        profileId: "00000000-0000-4000-8000-000000000901",
        profileVersionAtBinding: params.expectedProfileVersion,
        configurationRevisionIdAtBinding: params.expectedConfigurationRevisionId,
      },
    })),
    readProjectTaskCatalogPage: vi.fn(async () => ({
      schemaVersion: 1 as const,
      tasks: Object.freeze([]),
      nextCursor: null,
    })),
    createProjectTask: vi.fn(async (params) => ({
      schemaVersion: 1 as const,
      status: "created" as const,
      taskId: params.taskId,
    })),
    readProjectTaskDetail: vi.fn(async (params) => ({
      schemaVersion: 1 as const,
      projectId: params.projectId,
      ownershipVersion: 1,
      taskId: params.taskId,
      taskVersion: 1,
      title: "Task",
      stage: "requirements_only" as const,
      activeRequirement: {
        revisionId: "00000000-0000-4000-8000-000000000891",
        revisionNumber: 1,
        sourceText: "Requirement",
        objective: "Requirement",
        constraints: Object.freeze([]),
        acceptanceCriteria: Object.freeze([]),
      },
      latestPlanRevisionId: null,
      candidatePlan: null,
      confirmedPlan: null,
      activeGraph: null,
    })),
    reviseProjectTaskRequirement: vi.fn(async (params) => ({
      schemaVersion: 1 as const,
      status: "revised" as const,
      taskId: params.taskId,
    })),
  };
}

function accountObservation(
  account = ACCOUNT_STATUS,
  observedThroughSequence = 0,
): Awaited<ReturnType<DesktopSupervisorHandle["readAccountStatusObservation"]>> {
  return Object.freeze({ account, observedThroughSequence });
}

function taskMethods(): Pick<
  DesktopSupervisorHandle,
  | "readProjectTaskCatalogPage"
  | "createProjectTask"
  | "readProjectTaskDetail"
  | "reviseProjectTaskRequirement"
> {
  const methods = projectMethods();
  return {
    readProjectTaskCatalogPage: methods.readProjectTaskCatalogPage,
    createProjectTask: methods.createProjectTask,
    readProjectTaskDetail: methods.readProjectTaskDetail,
    reviseProjectTaskRequirement: methods.reviseProjectTaskRequirement,
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function closeResult(
  containment: DaemonProcessSupervisorCloseResult["containment"],
): DaemonProcessSupervisorCloseResult {
  return Object.freeze({
    expected: true,
    exitCode: 0,
    signal: null,
    containment,
    endpointCleanup: "removed",
    runtimeDirectoryCleanup: "removed",
  });
}

describe("desktop application controller", () => {
  it("starts exactly one supervisor and publishes readiness", async () => {
    const stateStore = new BootstrapStateStore();
    const closed = deferred<ReturnType<typeof closeResult>>();
    const supervisor: DesktopSupervisorHandle = {
      closed: closed.promise,
      readAccountStatusObservation: vi.fn(async () => accountObservation()),
      readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
      ...projectMethods(),
      ...routingMethods(),
      stop: vi.fn(async () => closeResult("graceful")),
    };
    const createSupervisor = vi.fn(async () => supervisor);
    const controller = new DesktopApplicationController({ stateStore, createSupervisor });

    await Promise.all([controller.start(), controller.start()]);
    expect(createSupervisor).toHaveBeenCalledTimes(1);
    expect(supervisor.readModelCatalogPage).toHaveBeenCalledExactlyOnceWith({
      cursor: null,
      limit: 12,
    });
    expect(supervisor.readRoutingConfiguration).toHaveBeenCalledTimes(1);
    expect(supervisor.readProjectCatalogPage).toHaveBeenCalledExactlyOnceWith({
      cursor: null,
      limit: 12,
    });
    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "plus" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
      projects: EMPTY_PROJECTS,
      projectRoutingBindings: EMPTY_PROJECT_ROUTING_BINDINGS,
    });

    closed.resolve(closeResult("graceful"));
    await closed.promise;
    await Promise.resolve();
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_unavailable" });
  });

  it("saves a routing update through a main-owned command identifier", async () => {
    const stateStore = new BootstrapStateStore();
    const setRoutingConfiguration = vi.fn(async () => CONFIGURED_ROUTING);
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        readRoutingConfiguration: vi.fn(async () => ROUTING_CONFIGURATION),
        setRoutingConfiguration,
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    const result = await controller.setRoutingConfiguration({
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: CONFIGURED_ROUTING.tiers,
    });
    expect(result).toMatchObject({ status: "saved", routing: { profileVersion: 1 } });
    expect(setRoutingConfiguration).toHaveBeenCalledWith({
      commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: CONFIGURED_ROUTING.tiers,
    });
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      routing: { profileVersion: 1, configured: true },
    });
    expect(JSON.stringify(result)).not.toContain("schemaVersion");
  });

  it("refreshes current routing after an optimistic write conflict", async () => {
    const stateStore = new BootstrapStateStore();
    const readRoutingConfiguration = vi
      .fn()
      .mockResolvedValueOnce(ROUTING_CONFIGURATION)
      .mockResolvedValueOnce(CONFIGURED_ROUTING);
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        readRoutingConfiguration,
        setRoutingConfiguration: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "rpc.conflict");
        }),
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    const result = await controller.setRoutingConfiguration({
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: CONFIGURED_ROUTING.tiers,
    });
    expect(result).toMatchObject({ status: "conflict", routing: { profileVersion: 1 } });
    expect(readRoutingConfiguration).toHaveBeenCalledTimes(2);
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      routing: { profileVersion: 1 },
    });
  });

  it("registers a chooser-owned workspace with main-owned identifiers and refreshes Projects", async () => {
    const stateStore = new BootstrapStateStore();
    const projectPage = {
      schemaVersion: 1 as const,
      projects: Object.freeze([PROJECT]),
      nextCursor: null,
    };
    const readProjectCatalogPage = vi
      .fn()
      .mockResolvedValueOnce(EMPTY_PROJECT_CATALOG_PAGE)
      .mockResolvedValueOnce(projectPage);
    const registerProject = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "registered" as const,
      project: PROJECT,
    }));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        readProjectCatalogPage,
        registerProject,
        ...routingMethods(),
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    const result = await controller.registerProjectWorkspace({
      displayName: "workspace",
      workspace: { platform: "macos", absolutePath: "/Users/example/workspace" },
    });
    expect(result).toEqual({
      status: "selected",
      registrationStatus: "registered",
      project: PROJECT,
      projects: { projects: [PROJECT], hasMore: false },
    });
    expect(registerProject).toHaveBeenCalledWith({
      commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      projectId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      displayName: "workspace",
      workspace: { platform: "macos", absolutePath: "/Users/example/workspace" },
    });
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      account: { planType: "plus" },
      routing: ROUTING_SUMMARY,
      projects: { projects: [PROJECT] },
    });
    await expect(
      controller.registerProjectWorkspace({
        displayName: "workspace",
        workspace: { platform: "macos", absolutePath: "/Users/example/../secret" },
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(registerProject).toHaveBeenCalledTimes(1);
  });

  it("binds a visible Project with main-owned fences and publishes only the minimal status", async () => {
    const stateStore = new BootstrapStateStore();
    const projectPage = {
      schemaVersion: 1 as const,
      projects: Object.freeze([PROJECT]),
      nextCursor: null,
    };
    const defaultBinding = Object.freeze({
      projectId: PROJECT.projectId,
      bindingVersion: 1,
      profileId: "00000000-0000-4000-8000-000000000901",
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: CONFIGURED_ROUTING.configurationRevisionId,
    });
    const readProjectRoutingBindingStatuses = vi
      .fn()
      .mockResolvedValueOnce(routingBindingStatusPage([PROJECT.projectId]))
      .mockResolvedValueOnce(routingBindingStatusPage([PROJECT.projectId]))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        statuses: [
          { projectId: PROJECT.projectId, status: "default_bound", binding: defaultBinding },
        ],
      });
    const bindProjectDefaultRouting = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "bound" as const,
      binding: defaultBinding,
    }));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readProjectCatalogPage: vi.fn(async () => projectPage),
        registerProject: projectMethods().registerProject,
        ...taskMethods(),
        readProjectRoutingBindingStatuses,
        bindProjectDefaultRouting,
        readRoutingConfiguration: vi.fn(async () => CONFIGURED_ROUTING),
        setRoutingConfiguration: routingMethods().setRoutingConfiguration,
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(controller.bindProjectToDefaultRouting(PROJECT.projectId)).resolves.toEqual({
      status: "bound",
    });
    expect(bindProjectDefaultRouting).toHaveBeenCalledWith({
      commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      projectId: PROJECT.projectId,
      expectedBindingVersion: 0,
      previousProfileId: null,
      expectedProfileVersion: 1,
      expectedConfigurationRevisionId: CONFIGURED_ROUTING.configurationRevisionId,
    });
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT.projectId, status: "default_bound", bindingVersion: 1 }],
      },
    });
    const projectedBindings =
      stateStore.current.phase === "ready" ? stateStore.current.projectRoutingBindings : undefined;
    expect(JSON.stringify(projectedBindings)).not.toContain(defaultBinding.profileId);
    expect(JSON.stringify(projectedBindings)).not.toContain(
      defaultBinding.configurationRevisionIdAtBinding,
    );
  });

  it("fails closed when a binding result does not match the requested routing fence", async () => {
    const stateStore = new BootstrapStateStore();
    const projectPage = {
      schemaVersion: 1 as const,
      projects: Object.freeze([PROJECT]),
      nextCursor: null,
    };
    const readProjectRoutingBindingStatuses = vi.fn(async () =>
      routingBindingStatusPage([PROJECT.projectId]),
    );
    const bindProjectDefaultRouting = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        status: "bound" as const,
        binding: {
          projectId: PROJECT.projectId,
          bindingVersion: 1,
          profileId: "00000000-0000-4000-8000-000000000901",
          profileVersionAtBinding: 2,
          configurationRevisionIdAtBinding: CONFIGURED_ROUTING.configurationRevisionId,
        },
      })
      .mockRejectedValueOnce(new Error("contained binding failure"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readProjectCatalogPage: vi.fn(async () => projectPage),
        registerProject: projectMethods().registerProject,
        ...taskMethods(),
        readProjectRoutingBindingStatuses,
        bindProjectDefaultRouting,
        readRoutingConfiguration: vi.fn(async () => CONFIGURED_ROUTING),
        setRoutingConfiguration: routingMethods().setRoutingConfiguration,
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(controller.bindProjectToDefaultRouting(PROJECT.projectId)).resolves.toEqual({
      status: "unavailable",
    });
    await expect(controller.bindProjectToDefaultRouting(PROJECT.projectId)).resolves.toEqual({
      status: "unavailable",
    });
    expect(readProjectRoutingBindingStatuses).toHaveBeenCalledTimes(3);
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      projectRoutingBindings: { bindings: [{ status: "unbound" }] },
    });
  });

  it("fails closed when the refreshed binding is not the acknowledged default binding", async () => {
    const stateStore = new BootstrapStateStore();
    const projectPage = {
      schemaVersion: 1 as const,
      projects: Object.freeze([PROJECT]),
      nextCursor: null,
    };
    const defaultBinding = {
      projectId: PROJECT.projectId,
      bindingVersion: 1,
      profileId: "00000000-0000-4000-8000-000000000901",
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: CONFIGURED_ROUTING.configurationRevisionId,
    };
    const otherBinding = {
      ...defaultBinding,
      profileId: "00000000-0000-4000-8000-000000000902",
    };
    const readProjectRoutingBindingStatuses = vi
      .fn()
      .mockResolvedValueOnce(routingBindingStatusPage([PROJECT.projectId]))
      .mockResolvedValueOnce(routingBindingStatusPage([PROJECT.projectId]))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        statuses: [
          { projectId: PROJECT.projectId, status: "other_profile_bound", binding: otherBinding },
        ],
      });
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readProjectCatalogPage: vi.fn(async () => projectPage),
        registerProject: projectMethods().registerProject,
        ...taskMethods(),
        readProjectRoutingBindingStatuses,
        bindProjectDefaultRouting: vi.fn(async () => ({
          schemaVersion: 1 as const,
          status: "bound" as const,
          binding: defaultBinding,
        })),
        readRoutingConfiguration: vi.fn(async () => CONFIGURED_ROUTING),
        setRoutingConfiguration: routingMethods().setRoutingConfiguration,
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(controller.bindProjectToDefaultRouting(PROJECT.projectId)).resolves.toEqual({
      status: "unavailable",
    });
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      projectRoutingBindings: { bindings: [{ status: "unbound" }] },
    });
  });

  it("rejects invisible Projects and reports an unconfigured default without writing", async () => {
    const stateStore = new BootstrapStateStore();
    const bindProjectDefaultRouting = vi.fn();
    const projectPage = {
      schemaVersion: 1 as const,
      projects: Object.freeze([PROJECT]),
      nextCursor: null,
    };
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readProjectCatalogPage: vi.fn(async () => projectPage),
        registerProject: projectMethods().registerProject,
        ...taskMethods(),
        readProjectRoutingBindingStatuses: vi.fn(async () =>
          routingBindingStatusPage([PROJECT.projectId]),
        ),
        bindProjectDefaultRouting,
        ...routingMethods(),
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(
      controller.bindProjectToDefaultRouting("00000000-0000-4000-8000-000000000882"),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(controller.bindProjectToDefaultRouting(PROJECT.projectId)).resolves.toEqual({
      status: "routing_unconfigured",
    });
    expect(bindProjectDefaultRouting).not.toHaveBeenCalled();
  });

  it("refreshes routing and binding state after an optimistic binding conflict", async () => {
    const stateStore = new BootstrapStateStore();
    const projectPage = {
      schemaVersion: 1 as const,
      projects: Object.freeze([PROJECT]),
      nextCursor: null,
    };
    const otherBinding = {
      projectId: PROJECT.projectId,
      bindingVersion: 1,
      profileId: "00000000-0000-4000-8000-000000000902",
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: "00000000-0000-4000-8000-000000000872",
    };
    const readProjectRoutingBindingStatuses = vi
      .fn()
      .mockResolvedValueOnce(routingBindingStatusPage([PROJECT.projectId]))
      .mockResolvedValueOnce(routingBindingStatusPage([PROJECT.projectId]))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        statuses: [
          { projectId: PROJECT.projectId, status: "other_profile_bound", binding: otherBinding },
        ],
      });
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readProjectCatalogPage: vi.fn(async () => projectPage),
        registerProject: projectMethods().registerProject,
        ...taskMethods(),
        readProjectRoutingBindingStatuses,
        bindProjectDefaultRouting: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "rpc.conflict");
        }),
        readRoutingConfiguration: vi.fn(async () => CONFIGURED_ROUTING),
        setRoutingConfiguration: routingMethods().setRoutingConfiguration,
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(controller.bindProjectToDefaultRouting(PROJECT.projectId)).resolves.toEqual({
      status: "conflict",
    });
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      projectRoutingBindings: {
        bindings: [{ status: "other_profile_bound", bindingVersion: 1 }],
      },
    });
  });

  it("reads and atomically creates Project Tasks with main-owned identifiers and fences", async () => {
    const stateStore = new BootstrapStateStore();
    const projectPage = {
      schemaVersion: 1 as const,
      projects: Object.freeze([PROJECT]),
      nextCursor: null,
    };
    const binding = {
      projectId: PROJECT.projectId,
      bindingVersion: 3,
      profileId: "00000000-0000-4000-8000-000000000901",
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: CONFIGURED_ROUTING.configurationRevisionId,
    };
    let createdTaskId: string | undefined;
    const readProjectTaskCatalogPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      tasks:
        createdTaskId === undefined
          ? []
          : [
              {
                taskId: createdTaskId,
                projectId: PROJECT.projectId,
                taskVersion: 1,
                title: "持久 Task",
                objective: "保存需求，不执行。",
                stage: "requirements_only" as const,
              },
            ],
      nextCursor: null,
    }));
    const createProjectTask = vi.fn(async (params) => {
      createdTaskId = params.taskId;
      return { schemaVersion: 1 as const, status: "created" as const, taskId: params.taskId };
    });
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readProjectCatalogPage: vi.fn(async () => projectPage),
        registerProject: projectMethods().registerProject,
        readProjectRoutingBindingStatuses: vi.fn(async () => ({
          schemaVersion: 1 as const,
          statuses: [{ projectId: PROJECT.projectId, status: "default_bound" as const, binding }],
        })),
        bindProjectDefaultRouting: projectMethods().bindProjectDefaultRouting,
        readProjectTaskCatalogPage,
        createProjectTask,
        readProjectTaskDetail: projectMethods().readProjectTaskDetail,
        reviseProjectTaskRequirement: projectMethods().reviseProjectTaskRequirement,
        readRoutingConfiguration: vi.fn(async () => CONFIGURED_ROUTING),
        setRoutingConfiguration: routingMethods().setRoutingConfiguration,
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(controller.readProjectTaskCatalog(PROJECT.projectId)).resolves.toEqual({
      status: "loaded",
      catalog: { projectId: PROJECT.projectId, tasks: [], hasMore: false },
    });
    const created = await controller.createProjectTask({
      projectId: PROJECT.projectId,
      title: "持久 Task",
      sourceText: "保存需求，不执行。",
    });
    expect(created).toMatchObject({
      status: "created",
      taskId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      catalog: {
        projectId: PROJECT.projectId,
        tasks: [{ title: "持久 Task", stage: "requirements_only" }],
      },
    });
    const command = createProjectTask.mock.calls[0]![0];
    expect(command).toMatchObject({
      projectId: PROJECT.projectId,
      expectedProjectVersion: 1,
      expectedRoutingBindingVersion: 3,
      title: "持久 Task",
      sourceText: "保存需求，不执行。",
    });
    expect(new Set([command.commandId, command.ownershipCommandId, command.taskId]).size).toBe(3);
    expect(readProjectTaskCatalogPage).toHaveBeenCalledWith({
      projectId: PROJECT.projectId,
      cursor: null,
      limit: 12,
    });
  });

  it("reads and revises a Project Task Requirement with fresh main-owned fences", async () => {
    const stateStore = new BootstrapStateStore();
    const taskId = "00000000-0000-4000-8000-000000000892";
    let taskVersion = 1;
    let revisionId = "00000000-0000-4000-8000-000000000893";
    let revisionNumber = 1;
    let sourceText = "初始需求。";
    const readProjectTaskDetail = vi.fn(async () => ({
      schemaVersion: 1 as const,
      projectId: PROJECT.projectId,
      ownershipVersion: 2,
      taskId,
      taskVersion,
      title: "可修订 Task",
      stage: "requirements_only" as const,
      activeRequirement: {
        revisionId,
        revisionNumber,
        sourceText,
        objective: sourceText,
        constraints: Object.freeze([]),
        acceptanceCriteria: Object.freeze([]),
      },
      latestPlanRevisionId: null,
      candidatePlan: null,
      confirmedPlan: null,
      activeGraph: null,
    }));
    const readProjectTaskCatalogPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      tasks: [
        {
          taskId,
          projectId: PROJECT.projectId,
          taskVersion,
          title: "可修订 Task",
          objective: sourceText,
          stage: "requirements_only" as const,
        },
      ],
      nextCursor: null,
    }));
    const reviseProjectTaskRequirement = vi.fn(async (params) => {
      taskVersion += 1;
      revisionNumber += 1;
      revisionId = params.commandId;
      sourceText = params.sourceText;
      return { schemaVersion: 1 as const, status: "revised" as const, taskId };
    });
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        readProjectCatalogPage: vi.fn(async () => ({
          schemaVersion: 1 as const,
          projects: [PROJECT],
          nextCursor: null,
        })),
        readProjectTaskCatalogPage,
        readProjectTaskDetail,
        reviseProjectTaskRequirement,
        ...routingMethods(),
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(
      controller.readProjectTaskDetail({ projectId: PROJECT.projectId, taskId }),
    ).resolves.toEqual({
      status: "loaded",
      detail: {
        projectId: PROJECT.projectId,
        taskId,
        taskVersion: 1,
        title: "可修订 Task",
        stage: "requirements_only",
        activeRequirement: {
          revisionNumber: 1,
          sourceText: "初始需求。",
          objective: "初始需求。",
          constraints: [],
          acceptanceCriteria: [],
        },
        candidatePlan: null,
        confirmedPlan: null,
        activeGraph: null,
      },
    });
    const revised = await controller.reviseProjectTaskRequirement({
      projectId: PROJECT.projectId,
      taskId,
      expectedTaskVersion: 1,
      sourceText: "澄清后的需求。",
    });
    expect(revised).toMatchObject({
      status: "revised",
      taskId,
      detail: {
        taskVersion: 2,
        activeRequirement: { revisionNumber: 2, sourceText: "澄清后的需求。" },
      },
      catalog: { tasks: [{ taskVersion: 2, objective: "澄清后的需求。" }] },
    });
    const command = reviseProjectTaskRequirement.mock.calls[0]![0];
    expect(command).toMatchObject({
      projectId: PROJECT.projectId,
      taskId,
      expectedTaskVersion: 1,
      expectedOwnershipVersion: 2,
      previousRequirementRevisionId: "00000000-0000-4000-8000-000000000893",
      sourceText: "澄清后的需求。",
    });
    expect(command.commandId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      controller.reviseProjectTaskRequirement({
        projectId: PROJECT.projectId,
        taskId,
        expectedTaskVersion: 1,
        sourceText: "过期草稿。",
      }),
    ).resolves.toEqual({ status: "conflict" });
    expect(reviseProjectTaskRequirement).toHaveBeenCalledTimes(1);
  });

  it("generates and confirms a Plan with main-owned hidden fences", async () => {
    const stateStore = new BootstrapStateStore();
    const taskId = "00000000-0000-4000-8000-000000000894";
    const requirementId = "00000000-0000-4000-8000-000000000895";
    const stepId = "00000000-0000-4000-8000-000000000896";
    const nodeId = "00000000-0000-4000-8000-000000000897";
    let taskVersion = 1;
    let planRevisionId: string | null = null;
    let confirmedPlanRevisionId: string | null = null;
    let graphRevisionId: string | null = null;
    const rawDetail = () => ({
      schemaVersion: 1 as const,
      projectId: PROJECT.projectId,
      ownershipVersion: 2,
      taskId,
      taskVersion,
      title: "候选计划 Task",
      stage:
        planRevisionId !== null
          ? ("candidate_plan" as const)
          : confirmedPlanRevisionId !== null
            ? graphRevisionId === null
              ? ("confirmed_plan" as const)
              : ("active_graph" as const)
            : ("requirements_only" as const),
      activeRequirement: {
        revisionId: requirementId,
        revisionNumber: 1,
        sourceText: "生成只读候选计划。",
        objective: "生成只读候选计划。",
        constraints: Object.freeze([]),
        acceptanceCriteria: Object.freeze([]),
      },
      latestPlanRevisionId: planRevisionId ?? confirmedPlanRevisionId,
      candidatePlan:
        planRevisionId === null
          ? null
          : {
              revisionId: planRevisionId,
              revisionNumber: 1,
              basedOnRequirementRevisionId: requirementId,
              steps: [
                {
                  stepId,
                  title: "生成计划",
                  description: "写入待确认步骤。",
                  acceptanceCriteria: ["renderer 不接收 ID。"],
                },
              ],
            },
      confirmedPlan:
        confirmedPlanRevisionId === null
          ? null
          : {
              revisionId: confirmedPlanRevisionId,
              revisionNumber: 2,
              basedOnRequirementRevisionId: requirementId,
              steps: [
                {
                  stepId,
                  title: "生成计划",
                  description: "写入待确认步骤。",
                  acceptanceCriteria: ["renderer 不接收 ID。"],
                },
              ],
            },
      activeGraph:
        graphRevisionId === null || confirmedPlanRevisionId === null
          ? null
          : {
              revisionId: graphRevisionId,
              revisionNumber: 1,
              basedOnPlanRevisionId: confirmedPlanRevisionId,
              nodes: [
                {
                  nodeId,
                  sourcePlanStepId: stepId,
                  title: "生成计划",
                  description: "写入待确认步骤。",
                  acceptanceCriteria: ["renderer 不接收 ID。"],
                  dependsOnNodeIds: [],
                  status: "pending" as const,
                },
              ],
              schedulePreview: { state: "dependency_eligible" as const, nodeId },
              topologicalOrder: [nodeId],
            },
    });
    const readProjectTaskDetail = vi.fn(async () => rawDetail());
    const readProjectTaskCatalogPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      tasks: [
        {
          taskId,
          projectId: PROJECT.projectId,
          taskVersion,
          title: "候选计划 Task",
          objective: "生成只读候选计划。",
          stage:
            planRevisionId !== null
              ? ("candidate_plan" as const)
              : confirmedPlanRevisionId !== null
                ? graphRevisionId === null
                  ? ("confirmed_plan" as const)
                  : ("active_graph" as const)
                : ("requirements_only" as const),
        },
      ],
      nextCursor: null,
    }));
    const generateProjectTaskCandidatePlan = vi.fn(async (command) => {
      taskVersion += 1;
      planRevisionId = command.commandId;
      return { schemaVersion: 1 as const, status: "generated" as const, taskId };
    });
    const confirmProjectTaskCandidatePlan = vi.fn(async (command) => {
      taskVersion += 1;
      confirmedPlanRevisionId = command.commandId;
      planRevisionId = null;
      return { schemaVersion: 1 as const, status: "confirmed" as const, taskId };
    });
    const materializeProjectTaskGraph = vi.fn(async (command) => {
      taskVersion += 1;
      graphRevisionId = command.commandId;
      return { schemaVersion: 1 as const, status: "materialized" as const, taskId };
    });
    const defaultBinding = {
      projectId: PROJECT.projectId,
      bindingVersion: 3,
      profileId: "00000000-0000-4000-8000-000000000901",
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: CONFIGURED_ROUTING.configurationRevisionId,
    };
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        readProjectCatalogPage: vi.fn(async () => ({
          schemaVersion: 1 as const,
          projects: [PROJECT],
          nextCursor: null,
        })),
        readProjectRoutingBindingStatuses: vi.fn(async () => ({
          schemaVersion: 1 as const,
          statuses: [
            {
              projectId: PROJECT.projectId,
              status: "default_bound" as const,
              binding: defaultBinding,
            },
          ],
        })),
        readProjectTaskCatalogPage,
        readProjectTaskDetail,
        generateProjectTaskCandidatePlan,
        confirmProjectTaskCandidatePlan,
        materializeProjectTaskGraph,
        readRoutingConfiguration: vi.fn(async () => CONFIGURED_ROUTING),
        setRoutingConfiguration: routingMethods().setRoutingConfiguration,
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    const result = await controller.generateProjectTaskCandidatePlan({
      projectId: PROJECT.projectId,
      taskId,
      expectedTaskVersion: 1,
    });
    expect(result).toMatchObject({
      status: "generated",
      taskId,
      detail: {
        taskVersion: 2,
        candidatePlan: { revisionNumber: 1, steps: [{ title: "生成计划" }] },
      },
      catalog: { tasks: [{ taskVersion: 2, stage: "candidate_plan" }] },
    });
    const command = generateProjectTaskCandidatePlan.mock.calls[0]![0];
    expect(command).toMatchObject({
      projectId: PROJECT.projectId,
      taskId,
      expectedProjectVersion: 1,
      expectedTaskVersion: 1,
      expectedOwnershipVersion: 2,
      previousRequirementRevisionId: requirementId,
      previousPlanRevisionId: null,
      expectedRoutingBindingVersion: 3,
      expectedProfileVersion: 1,
      expectedConfigurationRevisionId: CONFIGURED_ROUTING.configurationRevisionId,
    });
    expect(JSON.stringify(result)).not.toContain(stepId);
    expect(JSON.stringify(result)).not.toContain(command.commandId);
    const confirmation = await controller.confirmProjectTaskCandidatePlan({
      projectId: PROJECT.projectId,
      taskId,
      expectedTaskVersion: 2,
      candidatePlanRevisionNumber: 1,
    });
    expect(confirmation).toMatchObject({
      status: "confirmed",
      taskId,
      detail: {
        taskVersion: 3,
        stage: "confirmed_plan",
        candidatePlan: null,
        confirmedPlan: { revisionNumber: 2, steps: [{ title: "生成计划" }] },
      },
      catalog: { tasks: [{ taskVersion: 3, stage: "confirmed_plan" }] },
    });
    const confirmationCommand = confirmProjectTaskCandidatePlan.mock.calls[0]![0];
    expect(confirmationCommand).toMatchObject({
      projectId: PROJECT.projectId,
      taskId,
      expectedTaskVersion: 2,
      expectedOwnershipVersion: 2,
      previousRequirementRevisionId: requirementId,
      candidatePlanRevisionId: command.commandId,
    });
    expect(JSON.stringify(confirmation)).not.toContain(stepId);
    expect(JSON.stringify(confirmation)).not.toContain(confirmationCommand.commandId);
    await expect(
      controller.materializeProjectTaskGraph({
        projectId: PROJECT.projectId,
        taskId,
        expectedTaskVersion: 0,
        confirmedPlanRevisionNumber: 2,
      }),
    ).resolves.toEqual({ status: "unavailable" });
    readProjectTaskDetail.mockRejectedValueOnce(
      new HarnessRpcClientError("rpc_error", "rpc.conflict"),
    );
    await expect(
      controller.materializeProjectTaskGraph({
        projectId: PROJECT.projectId,
        taskId,
        expectedTaskVersion: 3,
        confirmedPlanRevisionNumber: 2,
      }),
    ).resolves.toEqual({ status: "conflict" });
    const materialization = await controller.materializeProjectTaskGraph({
      projectId: PROJECT.projectId,
      taskId,
      expectedTaskVersion: 3,
      confirmedPlanRevisionNumber: 2,
    });
    expect(materialization).toMatchObject({
      status: "materialized",
      taskId,
      detail: {
        taskVersion: 4,
        stage: "active_graph",
        activeGraph: {
          revisionNumber: 1,
          schedulePreview: { state: "dependency_eligible", nodeNumber: 1 },
          nodes: [
            {
              nodeNumber: 1,
              sourcePlanStepNumber: 1,
              dependsOnNodeNumbers: [],
              status: "pending",
            },
          ],
        },
      },
      catalog: { tasks: [{ taskVersion: 4, stage: "active_graph" }] },
    });
    const graphCommand = materializeProjectTaskGraph.mock.calls[0]![0];
    expect(graphCommand).toMatchObject({
      projectId: PROJECT.projectId,
      taskId,
      expectedTaskVersion: 3,
      expectedOwnershipVersion: 2,
      previousRequirementRevisionId: requirementId,
      confirmedPlanRevisionId: confirmationCommand.commandId,
      previousGraphRevisionId: null,
    });
    expect(JSON.stringify(materialization)).not.toContain(nodeId);
    expect(JSON.stringify(materialization)).not.toContain(graphCommand.commandId);
    await expect(
      controller.materializeProjectTaskGraph({
        projectId: PROJECT.projectId,
        taskId,
        expectedTaskVersion: 3,
        confirmedPlanRevisionNumber: 2,
      }),
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      controller.generateProjectTaskCandidatePlan({
        projectId: PROJECT.projectId,
        taskId,
        expectedTaskVersion: 1,
      }),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("contains invalid Task detail and Requirement revision outcomes", async () => {
    const taskId = "00000000-0000-4000-8000-000000000894";
    const notStarted = new DesktopApplicationController({
      stateStore: new BootstrapStateStore(),
      createSupervisor: async () => {
        throw new Error("unused");
      },
    });
    await expect(
      notStarted.readProjectTaskDetail({ projectId: PROJECT.projectId, taskId }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      notStarted.reviseProjectTaskRequirement({
        projectId: PROJECT.projectId,
        taskId,
        expectedTaskVersion: 1,
        sourceText: "新需求。",
      }),
    ).resolves.toEqual({ status: "unavailable" });

    const controllerFor = async (
      overrides: Partial<
        Pick<DesktopSupervisorHandle, "readProjectTaskDetail" | "reviseProjectTaskRequirement">
      >,
    ) => {
      const stateStore = new BootstrapStateStore();
      const controller = new DesktopApplicationController({
        stateStore,
        createSupervisor: async () => ({
          closed: new Promise(() => undefined),
          readAccountStatusObservation: vi.fn(async () => accountObservation()),
          readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
          ...projectMethods(),
          readProjectCatalogPage: vi.fn(async () => ({
            schemaVersion: 1 as const,
            projects: [PROJECT],
            nextCursor: null,
          })),
          ...overrides,
          ...routingMethods(),
          stop: vi.fn(async () => closeResult("graceful")),
        }),
      });
      await controller.start();
      return controller;
    };

    const unreadable = await controllerFor({
      readProjectTaskDetail: vi.fn(async () => {
        throw new Error("private detail");
      }),
    });
    await expect(
      unreadable.readProjectTaskDetail({ projectId: PROJECT.projectId, taskId }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      unreadable.readProjectTaskDetail({
        projectId: "00000000-0000-4000-8000-000000000895",
        taskId,
      }),
    ).resolves.toEqual({ status: "unavailable" });

    const conflicted = await controllerFor({
      reviseProjectTaskRequirement: vi.fn(async () => {
        throw new HarnessRpcClientError("rpc_error", "rpc.conflict");
      }),
    });
    await expect(
      conflicted.reviseProjectTaskRequirement({
        projectId: PROJECT.projectId,
        taskId,
        expectedTaskVersion: 1,
        sourceText: "新需求。",
      }),
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      conflicted.reviseProjectTaskRequirement({
        projectId: PROJECT.projectId,
        taskId,
        expectedTaskVersion: 0,
        sourceText: "新需求。",
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("keeps Task creation closed for unbound, invisible, or invalid Project input", async () => {
    const stateStore = new BootstrapStateStore();
    const createProjectTask = vi.fn();
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        readProjectCatalogPage: vi.fn(async () => ({
          schemaVersion: 1 as const,
          projects: [PROJECT],
          nextCursor: null,
        })),
        createProjectTask,
        ...routingMethods(),
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(
      controller.createProjectTask({
        projectId: PROJECT.projectId,
        title: "Task",
        sourceText: "Requirement",
      }),
    ).resolves.toEqual({ status: "routing_unbound" });
    await expect(
      controller.createProjectTask({
        projectId: "00000000-0000-4000-8000-000000000882",
        title: "Task",
        sourceText: "Requirement",
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      controller.createProjectTask({ projectId: PROJECT.projectId, title: " ", sourceText: "x" }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(createProjectTask).not.toHaveBeenCalled();
  });

  it("refreshes Project binding state after a Task creation conflict", async () => {
    const stateStore = new BootstrapStateStore();
    const binding = {
      projectId: PROJECT.projectId,
      bindingVersion: 1,
      profileId: "00000000-0000-4000-8000-000000000901",
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: CONFIGURED_ROUTING.configurationRevisionId,
    };
    const readProjectRoutingBindingStatuses = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        statuses: [{ projectId: PROJECT.projectId, status: "default_bound", binding }],
      })
      .mockResolvedValueOnce(routingBindingStatusPage([PROJECT.projectId]));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        readProjectCatalogPage: vi.fn(async () => ({
          schemaVersion: 1 as const,
          projects: [PROJECT],
          nextCursor: null,
        })),
        registerProject: projectMethods().registerProject,
        readProjectRoutingBindingStatuses,
        bindProjectDefaultRouting: projectMethods().bindProjectDefaultRouting,
        readProjectTaskCatalogPage: projectMethods().readProjectTaskCatalogPage,
        createProjectTask: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "rpc.conflict");
        }),
        readProjectTaskDetail: projectMethods().readProjectTaskDetail,
        reviseProjectTaskRequirement: projectMethods().reviseProjectTaskRequirement,
        ...routingMethods(),
        stop: vi.fn(async () => closeResult("graceful")),
      }),
    });
    await controller.start();

    await expect(
      controller.createProjectTask({
        projectId: PROJECT.projectId,
        title: "Task",
        sourceText: "Requirement",
      }),
    ).resolves.toEqual({ status: "conflict" });
    expect(stateStore.current).toMatchObject({
      phase: "ready",
      projectRoutingBindings: { bindings: [{ status: "unbound", bindingVersion: null }] },
    });
  });

  it("contains Task read, malformed-result, transport, and conflict-refresh failures", async () => {
    const binding = {
      projectId: PROJECT.projectId,
      bindingVersion: 1,
      profileId: "00000000-0000-4000-8000-000000000901",
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: CONFIGURED_ROUTING.configurationRevisionId,
    };
    const readyMethods = () => ({
      readAccountStatusObservation: vi.fn(async () => accountObservation()),
      readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
      readProjectCatalogPage: vi.fn(async () => ({
        schemaVersion: 1 as const,
        projects: [PROJECT],
        nextCursor: null,
      })),
      registerProject: projectMethods().registerProject,
      readProjectRoutingBindingStatuses: vi.fn(async () => ({
        schemaVersion: 1 as const,
        statuses: [{ projectId: PROJECT.projectId, status: "default_bound" as const, binding }],
      })),
      bindProjectDefaultRouting: projectMethods().bindProjectDefaultRouting,
      readRoutingConfiguration: vi.fn(async () => CONFIGURED_ROUTING),
      setRoutingConfiguration: routingMethods().setRoutingConfiguration,
      ...taskMethods(),
      stop: vi.fn(async () => closeResult("graceful")),
    });

    const readStore = new BootstrapStateStore();
    const readController = new DesktopApplicationController({
      stateStore: readStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        ...readyMethods(),
        readProjectTaskCatalogPage: vi.fn(async () => {
          throw new Error("contained");
        }),
        createProjectTask: projectMethods().createProjectTask,
      }),
    });
    await expect(readController.readProjectTaskCatalog(PROJECT.projectId)).resolves.toEqual({
      status: "unavailable",
    });
    await readController.start();
    await expect(readController.readProjectTaskCatalog(PROJECT.projectId)).resolves.toEqual({
      status: "unavailable",
    });

    for (const createProjectTask of [
      vi.fn(async () => ({
        schemaVersion: 1 as const,
        status: "created" as const,
        taskId: "00000000-0000-4000-8000-000000000889",
      })),
      vi.fn(async () => {
        throw new Error("contained");
      }),
    ]) {
      const stateStore = new BootstrapStateStore();
      const controller = new DesktopApplicationController({
        stateStore,
        createSupervisor: async () => ({
          closed: new Promise(() => undefined),
          ...readyMethods(),
          readProjectTaskCatalogPage: projectMethods().readProjectTaskCatalogPage,
          createProjectTask,
        }),
      });
      await controller.start();
      await expect(
        controller.createProjectTask({
          projectId: PROJECT.projectId,
          title: "Task",
          sourceText: "Requirement",
        }),
      ).resolves.toEqual({ status: "unavailable" });
    }

    for (const stopBeforeRefresh of [true, false]) {
      const stateStore = new BootstrapStateStore();
      const controller = new DesktopApplicationController({
        stateStore,
        createSupervisor: async () => ({
          closed: new Promise(() => undefined),
          ...readyMethods(),
          ...(stopBeforeRefresh
            ? {}
            : {
                readProjectCatalogPage: vi.fn(async () => {
                  throw new Error("contained refresh");
                }),
              }),
          readProjectTaskCatalogPage: projectMethods().readProjectTaskCatalogPage,
          createProjectTask: vi.fn(async () => {
            if (stopBeforeRefresh) {
              stateStore.transition({ phase: "stopping" });
            }
            throw new HarnessRpcClientError("rpc_error", "rpc.conflict");
          }),
        }),
      });
      await controller.start();
      await expect(
        controller.createProjectTask({
          projectId: PROJECT.projectId,
          title: "Task",
          sourceText: "Requirement",
        }),
      ).resolves.toEqual({ status: "unavailable" });
    }
  });

  it("waits for an in-flight start before stopping and never publishes transient readiness", async () => {
    const stateStore = new BootstrapStateStore();
    const supervisorReady = deferred<DesktopSupervisorHandle>();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => await supervisorReady.promise,
    });

    const starting = controller.start();
    const stopping = controller.stop();
    expect(stateStore.current).toEqual({ phase: "stopping" });
    supervisorReady.resolve({
      closed: new Promise(() => undefined),
      readAccountStatusObservation: vi.fn(async () => accountObservation()),
      readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
      ...projectMethods(),
      ...routingMethods(),
      stop,
    });

    await expect(stopping).resolves.toBe(0);
    await starting;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "stopping" });
  });

  it("waits for an in-flight account read without publishing transient readiness", async () => {
    const stateStore = new BootstrapStateStore();
    const accountStatus = deferred<ReturnType<typeof accountObservation>>();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: async () => await accountStatus.promise,
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        ...routingMethods(),
        stop,
      }),
    });

    const starting = controller.start();
    await Promise.resolve();
    const stopping = controller.stop();
    expect(stateStore.current).toEqual({ phase: "stopping" });
    accountStatus.resolve(accountObservation());

    await starting;
    await expect(stopping).resolves.toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "stopping" });
  });

  it("returns a non-zero exit status when containment cannot be proven", async () => {
    const stateStore = new BootstrapStateStore();
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        ...routingMethods(),
        stop: async () => closeResult("containment_unknown"),
      }),
    });

    await controller.start();
    await expect(controller.stop()).resolves.toBe(1);
  });

  it("stops the supervisor and never publishes ready when account status fails", async () => {
    const stateStore = new BootstrapStateStore();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "service.unavailable");
        }),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        ...routingMethods(),
        stop,
      }),
    });

    await controller.start();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_startup_failed" });
  });

  it("stops the supervisor and never publishes ready when the model catalog fails", async () => {
    const stateStore = new BootstrapStateStore();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "service.unavailable");
        }),
        ...projectMethods(),
        ...routingMethods(),
        stop,
      }),
    });

    await controller.start();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_startup_failed" });
  });

  it("never publishes partial readiness when Project binding status is unavailable", async () => {
    const stateStore = new BootstrapStateStore();
    const stop = vi.fn(async () => closeResult("graceful"));
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async () => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: vi.fn(async () => accountObservation()),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        readProjectRoutingBindingStatuses: vi.fn(async () => {
          throw new HarnessRpcClientError("rpc_error", "service.unavailable");
        }),
        ...routingMethods(),
        stop,
      }),
    });

    await controller.start();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stateStore.current).toEqual({ phase: "failed", code: "daemon_startup_failed" });
  });

  it("uses the RPC snapshot when a cached startup event is already covered by its sequence barrier", async () => {
    const stateStore = new BootstrapStateStore();
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async (onAccountStatusChanged) => {
        onAccountStatusChanged(Object.freeze({ sequence: 1, account: UPDATED_ACCOUNT_STATUS }));
        return {
          closed: new Promise(() => undefined),
          readAccountStatusObservation: async () => accountObservation(ACCOUNT_STATUS, 1),
          readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
          ...projectMethods(),
          ...routingMethods(),
          stop: async () => closeResult("graceful"),
        };
      },
    });

    await controller.start();

    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "plus" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
      projects: EMPTY_PROJECTS,
      projectRoutingBindings: EMPTY_PROJECT_ROUTING_BINDINGS,
    });
  });

  it("uses a startup event that follows the RPC response barrier", async () => {
    const stateStore = new BootstrapStateStore();
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async (onAccountStatusChanged) => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: async () => {
          onAccountStatusChanged(Object.freeze({ sequence: 2, account: UPDATED_ACCOUNT_STATUS }));
          return accountObservation(ACCOUNT_STATUS, 1);
        },
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        ...routingMethods(),
        stop: async () => closeResult("graceful"),
      }),
    });

    await controller.start();

    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "pro" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
      projects: EMPTY_PROJECTS,
      projectRoutingBindings: EMPTY_PROJECT_ROUTING_BINDINGS,
    });
  });

  it("keeps an account event received during the second bootstrap stage", async () => {
    const stateStore = new BootstrapStateStore();
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async (onAccountStatusChanged) => ({
        closed: new Promise(() => undefined),
        readAccountStatusObservation: async () => accountObservation(ACCOUNT_STATUS, 1),
        readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
        ...projectMethods(),
        readProjectRoutingBindingStatuses: vi.fn(async () => {
          onAccountStatusChanged(Object.freeze({ sequence: 2, account: UPDATED_ACCOUNT_STATUS }));
          return routingBindingStatusPage([]);
        }),
        ...routingMethods(),
        stop: async () => closeResult("graceful"),
      }),
    });

    await controller.start();

    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "pro" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
      projects: EMPTY_PROJECTS,
      projectRoutingBindings: EMPTY_PROJECT_ROUTING_BINDINGS,
    });
  });

  it("updates ready account state from later events and ignores updates while stopping", async () => {
    const stateStore = new BootstrapStateStore();
    let observeAccountStatusChanged:
      Parameters<DesktopApplicationControllerConfig["createSupervisor"]>[0] | undefined;
    const controller = new DesktopApplicationController({
      stateStore,
      createSupervisor: async (listener) => {
        observeAccountStatusChanged = listener;
        return {
          closed: new Promise(() => undefined),
          readAccountStatusObservation: async () => accountObservation(),
          readModelCatalogPage: vi.fn(async () => MODEL_CATALOG_PAGE),
          ...projectMethods(),
          ...routingMethods(),
          stop: async () => closeResult("graceful"),
        };
      },
    });
    await controller.start();

    observeAccountStatusChanged?.(Object.freeze({ sequence: 1, account: UPDATED_ACCOUNT_STATUS }));
    expect(stateStore.current).toEqual({
      phase: "ready",
      account: { status: "authenticated", credentialKind: "chatgpt", planType: "pro" },
      catalog: CATALOG_SUMMARY,
      routing: ROUTING_SUMMARY,
      projects: EMPTY_PROJECTS,
      projectRoutingBindings: EMPTY_PROJECT_ROUTING_BINDINGS,
    });

    await controller.stop();
    observeAccountStatusChanged?.(Object.freeze({ sequence: 2, account: ACCOUNT_STATUS }));
    expect(stateStore.current).toEqual({ phase: "stopping" });
  });

  it("maps only stable failure codes", async () => {
    expect(
      mapBootstrapFailure(new DesktopRuntimeResourceError("resource_configuration_missing")),
    ).toBe("resource_configuration_missing");
    expect(mapBootstrapFailure(new DaemonProcessSupervisorError("unsupported_platform"))).toBe(
      "unsupported_platform",
    );
    expect(mapBootstrapFailure(new DaemonProcessSupervisorError("spawn_failed"))).toBe(
      "daemon_startup_failed",
    );
    expect(mapBootstrapFailure(new HarnessRpcClientError("rpc_error"))).toBe(
      "daemon_startup_failed",
    );
    expect(mapBootstrapFailure(new Error("/private/sensitive/path"))).toBe("internal_error");
  });
});
