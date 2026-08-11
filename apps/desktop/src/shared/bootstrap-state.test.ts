import { describe, expect, it, vi } from "vitest";

import {
  BootstrapStateStore,
  BootstrapStateTransitionError,
  advanceDesktopBootstrapState,
  decodeDesktopBootstrapState,
  decodeDesktopProjectSelectionResult,
  decodeDesktopProjectRoutingBindingMutationResult,
  decodeDesktopProjectRoutingBindingProjectId,
  decodeDesktopProjectTaskCatalogResult,
  decodeDesktopProjectTaskCandidatePlanConfirmation,
  decodeDesktopProjectTaskCandidatePlanConfirmationResult,
  decodeDesktopProjectTaskCandidatePlanGeneration,
  decodeDesktopProjectTaskCandidatePlanMutationResult,
  decodeDesktopProjectTaskCreation,
  decodeDesktopProjectTaskDetailResult,
  decodeDesktopProjectTaskMutationResult,
  decodeDesktopProjectTaskRequirementMutationResult,
  decodeDesktopProjectTaskRequirementRevision,
  decodeDesktopProjectTaskSelection,
  decodeDesktopProjectWorkspaceRegistration,
  decodeDesktopRoutingConfigurationMutationResult,
  decodeDesktopRoutingConfigurationUpdate,
  failedBootstrapState,
  projectDesktopModelCatalogSummary,
  projectDesktopProjectCatalog,
  projectDesktopProjectRegistration,
  projectDesktopProjectRoutingBindings,
  projectDesktopProjectTaskCatalog,
  projectDesktopProjectTaskDetail,
  projectDesktopRoutingConfiguration,
  readyBootstrapState,
} from "./bootstrap-state.js";

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

const ROUTING = Object.freeze({
  configured: true,
  profileVersion: 1,
  configurationRevisionId: "00000000-0000-4000-8000-000000000861",
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
  projectId: "00000000-0000-4000-8000-000000000871",
  projectVersion: 1 as const,
  displayName: "workspace",
  workspace: Object.freeze({
    platform: "macos" as const,
    absolutePath: "/Users/example/workspace",
    identityStatus: "unverified" as const,
  }),
});

const PROJECTS = Object.freeze({
  projects: Object.freeze([PROJECT]),
  hasMore: false,
});

const RAW_PROJECT_ROUTING_BINDINGS = Object.freeze({
  schemaVersion: 1,
  statuses: Object.freeze([
    Object.freeze({ projectId: PROJECT.projectId, status: "unbound" as const, binding: null }),
  ]),
});

const PROJECT_ROUTING_BINDINGS = Object.freeze({
  bindings: Object.freeze([
    Object.freeze({
      projectId: PROJECT.projectId,
      status: "unbound" as const,
      bindingVersion: null,
    }),
  ]),
});

const READY = Object.freeze({
  phase: "ready" as const,
  account: Object.freeze({
    status: "authenticated" as const,
    credentialKind: "chatgpt" as const,
    planType: "plus" as const,
  }),
  catalog: CATALOG,
  routing: ROUTING,
  projects: PROJECTS,
  projectRoutingBindings: PROJECT_ROUTING_BINDINGS,
});

describe("desktop bootstrap state", () => {
  it("strictly decodes and freezes the renderer boundary value", () => {
    const ready = decodeDesktopBootstrapState(READY);
    const failed = decodeDesktopBootstrapState({ phase: "failed", code: "resource_invalid" });

    expect(ready).toEqual(READY);
    expect(failed).toEqual({ phase: "failed", code: "resource_invalid" });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.account : undefined)).toBe(true);
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.catalog : undefined)).toBe(true);
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.catalog.models : undefined)).toBe(true);
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.catalog.models[0] : undefined)).toBe(
      true,
    );
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.routing.tiers?.fast : undefined)).toBe(
      true,
    );
    expect(Object.isFrozen(failed)).toBe(true);
    expect(
      decodeDesktopBootstrapState({
        ...READY,
        endpoint: "/private/secret",
      }),
    ).toBe(undefined);
    expect(
      decodeDesktopBootstrapState({
        phase: "ready",
        account: { ...READY.account, email: "private@example.com" },
        catalog: READY.catalog,
        routing: READY.routing,
        projects: READY.projects,
        projectRoutingBindings: READY.projectRoutingBindings,
      }),
    ).toBe(undefined);
    expect(
      decodeDesktopBootstrapState({
        phase: "ready",
        account: READY.account,
        catalog: { ...READY.catalog, nextCursor: "private-cursor" },
        routing: READY.routing,
        projects: READY.projects,
        projectRoutingBindings: READY.projectRoutingBindings,
      }),
    ).toBe(undefined);
    expect(decodeDesktopBootstrapState({ phase: "failed", code: "raw_error" })).toBe(undefined);
  });

  it("projects full RPC observations to the minimal renderer boundary", () => {
    const account = {
      schemaVersion: 1,
      snapshotId: "00000000-0000-4000-8000-000000000851",
      workerSessionId: "00000000-0000-4000-8000-000000000852",
      observedAtMs: 1,
      ...READY.account,
      futureSafeField: true,
    };
    const catalog = projectDesktopModelCatalogSummary({
      schemaVersion: 1,
      provider: CATALOG.provider,
      totalVisibleModels: CATALOG.totalVisibleModels,
      models: CATALOG.models,
      nextCursor: null,
    });
    const routing = projectDesktopRoutingConfiguration({ schemaVersion: 1, ...ROUTING });
    const projects = projectDesktopProjectCatalog({
      schemaVersion: 1,
      projects: PROJECTS.projects,
      nextCursor: null,
    });
    const projectRoutingBindings = projectDesktopProjectRoutingBindings(
      RAW_PROJECT_ROUTING_BINDINGS,
      [PROJECT.projectId],
    );
    const state = readyBootstrapState(account, catalog, routing, projects, projectRoutingBindings);

    expect(state).toEqual(READY);
    expect(JSON.stringify(state)).not.toContain("snapshotId");
    expect(JSON.stringify(state)).not.toContain("workerSessionId");
    expect(JSON.stringify(state)).not.toContain("nextCursor");
    expect(JSON.stringify(state)).not.toContain("profileId");
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.phase === "ready" ? state.account : undefined)).toBe(true);
    expect(JSON.stringify(state)).not.toContain("schemaVersion");
  });

  it("projects binding status without exposing profile fences and enforces Project alignment", () => {
    const rawDefault = {
      schemaVersion: 1,
      statuses: [
        {
          projectId: PROJECT.projectId,
          status: "default_bound",
          binding: {
            projectId: PROJECT.projectId,
            bindingVersion: 2,
            profileId: "00000000-0000-4000-8000-000000000901",
            profileVersionAtBinding: 3,
            configurationRevisionIdAtBinding: "00000000-0000-4000-8000-000000000861",
          },
        },
      ],
    };

    expect(projectDesktopProjectRoutingBindings(rawDefault, [PROJECT.projectId])).toEqual({
      bindings: [{ projectId: PROJECT.projectId, status: "default_bound", bindingVersion: 2 }],
    });
    expect(
      JSON.stringify(projectDesktopProjectRoutingBindings(rawDefault, [PROJECT.projectId])),
    ).not.toContain("profileId");
    expect(() => projectDesktopProjectRoutingBindings(rawDefault, [])).toThrow(
      BootstrapStateTransitionError,
    );
    expect(() =>
      projectDesktopProjectRoutingBindings(
        {
          ...rawDefault,
          statuses: [{ ...rawDefault.statuses[0], privateField: "secret" }],
        },
        [PROJECT.projectId],
      ),
    ).toThrow(BootstrapStateTransitionError);
    expect(() =>
      projectDesktopProjectRoutingBindings(
        {
          ...rawDefault,
          statuses: [
            {
              ...rawDefault.statuses[0],
              binding: { ...rawDefault.statuses[0]!.binding, bindingVersion: 0 },
            },
          ],
        },
        [PROJECT.projectId],
      ),
    ).toThrow(BootstrapStateTransitionError);
    expect(decodeDesktopProjectRoutingBindingMutationResult({ status: "bound" })).toEqual({
      status: "bound",
    });
    expect(decodeDesktopProjectRoutingBindingMutationResult({ status: "future" })).toBeUndefined();
    expect(decodeDesktopProjectRoutingBindingProjectId(PROJECT.projectId)).toBe(PROJECT.projectId);
    expect(decodeDesktopProjectRoutingBindingProjectId("invalid")).toBeUndefined();

    for (const projectRoutingBindings of [
      { bindings: [] },
      {
        bindings: [{ projectId: PROJECT.projectId, status: "invalid", bindingVersion: null }],
      },
      {
        bindings: [
          {
            projectId: PROJECT.projectId,
            status: "default_bound",
            bindingVersion: 0,
          },
        ],
      },
    ]) {
      expect(
        decodeDesktopBootstrapState({
          ...READY,
          projectRoutingBindings,
        }),
      ).toBeUndefined();
    }
  });

  it("projects and validates Project catalog, chooser input, and selection results", () => {
    const projects = projectDesktopProjectCatalog({
      schemaVersion: 1,
      projects: PROJECTS.projects,
      nextCursor: null,
    });
    const registration = projectDesktopProjectRegistration({
      schemaVersion: 1,
      status: "registered",
      project: PROJECT,
    });
    const chooserInput = {
      displayName: PROJECT.displayName,
      workspace: {
        platform: PROJECT.workspace.platform,
        absolutePath: PROJECT.workspace.absolutePath,
      },
    };

    expect(projects).toEqual(PROJECTS);
    expect(registration).toEqual({ registrationStatus: "registered", project: PROJECT });
    expect(decodeDesktopProjectWorkspaceRegistration(chooserInput)).toEqual(chooserInput);
    expect(
      decodeDesktopProjectSelectionResult({
        status: "selected",
        registrationStatus: "registered",
        project: PROJECT,
        projects,
      }),
    ).toEqual({
      status: "selected",
      registrationStatus: "registered",
      project: PROJECT,
      projects,
    });
    expect(decodeDesktopProjectSelectionResult({ status: "cancelled" })).toEqual({
      status: "cancelled",
    });
    expect(
      decodeDesktopProjectWorkspaceRegistration({
        ...chooserInput,
        workspace: { ...chooserInput.workspace, absolutePath: "/Users/example/../secret" },
      }),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectSelectionResult({
        status: "selected",
        registrationStatus: "registered",
        project: { ...PROJECT, createdAtMs: 1 },
        projects,
      }),
    ).toBeUndefined();
    expect(() =>
      projectDesktopProjectCatalog({
        schemaVersion: 1,
        projects: [PROJECT, PROJECT],
        nextCursor: null,
      }),
    ).toThrow(BootstrapStateTransitionError);
  });

  it("strictly projects routing state and validates renderer mutation boundaries", () => {
    const projected = projectDesktopRoutingConfiguration({ schemaVersion: 1, ...ROUTING });
    const update = {
      expectedProfileVersion: projected.profileVersion,
      previousConfigurationRevisionId: projected.configurationRevisionId,
      tiers: projected.tiers,
    };

    expect(projected).toEqual(ROUTING);
    expect(decodeDesktopRoutingConfigurationUpdate(update)).toEqual(update);
    expect(
      decodeDesktopRoutingConfigurationMutationResult({ status: "saved", routing: projected }),
    ).toEqual({ status: "saved", routing: projected });
    expect(decodeDesktopRoutingConfigurationMutationResult({ status: "unavailable" })).toEqual({
      status: "unavailable",
    });
    expect(
      decodeDesktopRoutingConfigurationUpdate({ ...update, expectedProfileVersion: 0 }),
    ).toBeUndefined();
    expect(
      decodeDesktopRoutingConfigurationMutationResult({
        status: "saved",
        routing: { ...projected, privateRevision: "secret" },
      }),
    ).toBeUndefined();
    expect(() =>
      projectDesktopRoutingConfiguration({
        schemaVersion: 1,
        ...ROUTING,
        availability: { ...ROUTING.availability, deep: "future" },
      }),
    ).toThrow(BootstrapStateTransitionError);
  });

  it("projects only the bounded visible catalog summary and rejects inconsistent pages", () => {
    const projected = projectDesktopModelCatalogSummary({
      schemaVersion: 1,
      provider: "openai",
      totalVisibleModels: 3,
      models: CATALOG.models,
      nextCursor: "00000000-0000-4000-8000-000000000853.Z3B0LWZhc3Q",
    });

    expect(projected).toEqual({ ...CATALOG, totalVisibleModels: 3, hasMore: true });
    expect(JSON.stringify(projected)).not.toContain("nextCursor");
    expect(Object.isFrozen(projected)).toBe(true);
    expect(() =>
      projectDesktopModelCatalogSummary({
        schemaVersion: 1,
        provider: "openai",
        totalVisibleModels: 2,
        models: CATALOG.models,
        nextCursor: "cursor-without-more-models",
      }),
    ).toThrow(BootstrapStateTransitionError);
    expect(() =>
      projectDesktopModelCatalogSummary({
        schemaVersion: 1,
        provider: "openai",
        totalVisibleModels: 2,
        models: [{ ...CATALOG.models[0], id: "private-id" }, CATALOG.models[1]],
        nextCursor: null,
      }),
    ).toThrow(BootstrapStateTransitionError);
  });

  it("strictly projects Project Task catalogs and desktop creation results", () => {
    const taskId = "00000000-0000-4000-8000-000000000881";
    const raw = {
      schemaVersion: 1,
      tasks: [
        {
          taskId,
          projectId: PROJECT.projectId,
          taskVersion: 1,
          title: "持久 Task",
          objective: "只保存需求，不执行。",
          stage: "requirements_only",
        },
      ],
      nextCursor: taskId,
    };
    const catalog = projectDesktopProjectTaskCatalog(raw, PROJECT.projectId);
    expect(catalog).toEqual({
      projectId: PROJECT.projectId,
      tasks: raw.tasks,
      hasMore: true,
    });
    expect(Object.isFrozen(catalog.tasks)).toBe(true);
    expect(
      decodeDesktopProjectTaskCatalogResult({ status: "loaded", catalog }, PROJECT.projectId),
    ).toEqual({ status: "loaded", catalog });
    expect(
      decodeDesktopProjectTaskCatalogResult({ status: "unavailable" }, PROJECT.projectId),
    ).toEqual({ status: "unavailable" });

    const creation = {
      projectId: PROJECT.projectId,
      title: "持久 Task",
      sourceText: "只保存需求，不执行。",
    };
    expect(decodeDesktopProjectTaskCreation(creation)).toEqual(creation);
    expect(
      decodeDesktopProjectTaskMutationResult(
        {
          status: "created",
          taskId,
          catalog,
        },
        PROJECT.projectId,
      ),
    ).toEqual({ status: "created", taskId, catalog });
    expect(
      decodeDesktopProjectTaskMutationResult({ status: "conflict" }, PROJECT.projectId),
    ).toEqual({ status: "conflict" });
    expect(decodeDesktopProjectTaskCatalogResult({ status: "loaded" }, "invalid")).toBeUndefined();
    expect(
      decodeDesktopProjectTaskCatalogResult({ status: "unexpected" }, PROJECT.projectId),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskMutationResult({ status: "conflict" }, "invalid"),
    ).toBeUndefined();

    expect(decodeDesktopProjectTaskCreation({ ...creation, title: "a\n" })).toBeUndefined();
    expect(
      decodeDesktopProjectTaskCreation({ ...creation, sourceText: "中".repeat(5_462) }),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskCatalogResult(
        {
          status: "loaded",
          catalog: { ...catalog, privateCursor: "secret" },
        },
        PROJECT.projectId,
      ),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskCatalogResult(
        {
          status: "loaded",
          catalog: { ...catalog, tasks: [{ ...catalog.tasks[0], title: " invalid" }] },
        },
        PROJECT.projectId,
      ),
    ).toBeUndefined();
    const otherProjectId = "00000000-0000-4000-8000-000000000882";
    expect(
      decodeDesktopProjectTaskCatalogResult(
        { status: "loaded", catalog: { ...catalog, projectId: otherProjectId, tasks: [] } },
        PROJECT.projectId,
      ),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskMutationResult(
        {
          status: "created",
          taskId,
          catalog: { ...catalog, projectId: otherProjectId, tasks: [] },
        },
        PROJECT.projectId,
      ),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskMutationResult(
        {
          status: "created",
          taskId,
          catalog: { ...catalog, tasks: [catalog.tasks[0], catalog.tasks[0]] },
        },
        PROJECT.projectId,
      ),
    ).toBeUndefined();
    expect(() =>
      projectDesktopProjectTaskCatalog(
        { schemaVersion: 2, tasks: [], nextCursor: null },
        PROJECT.projectId,
      ),
    ).toThrow(BootstrapStateTransitionError);
    expect(() =>
      projectDesktopProjectTaskCatalog(
        {
          ...raw,
          tasks: [{ ...raw.tasks[0], projectId: otherProjectId }],
        },
        PROJECT.projectId,
      ),
    ).toThrow(BootstrapStateTransitionError);
  });

  it("strictly projects Task detail and Requirement revision without internal fences", () => {
    const taskId = "00000000-0000-4000-8000-000000000883";
    const raw = {
      schemaVersion: 1,
      projectId: PROJECT.projectId,
      ownershipVersion: 4,
      taskId,
      taskVersion: 4,
      title: "可修订 Task",
      stage: "candidate_plan",
      activeRequirement: {
        revisionId: "00000000-0000-4000-8000-000000000884",
        revisionNumber: 3,
        sourceText: "用户澄清后的需求。",
        objective: "用户澄清后的需求。",
        constraints: ["不得自动执行。"],
        acceptanceCriteria: ["重启后恢复当前修订。"],
      },
      latestPlanRevisionId: "00000000-0000-4000-8000-000000000885",
      candidatePlan: {
        revisionId: "00000000-0000-4000-8000-000000000885",
        revisionNumber: 1,
        basedOnRequirementRevisionId: "00000000-0000-4000-8000-000000000884",
        steps: [
          {
            stepId: "00000000-0000-4000-8000-000000000886",
            title: "生成候选计划",
            description: "只生成并持久化待确认步骤。",
            acceptanceCriteria: ["内部 ID 不进入 renderer。"],
          },
        ],
      },
      confirmedPlan: null,
    };
    const detail = projectDesktopProjectTaskDetail(raw, PROJECT.projectId, taskId);
    expect(detail).toEqual({
      projectId: PROJECT.projectId,
      taskId,
      taskVersion: 4,
      title: raw.title,
      stage: raw.stage,
      activeRequirement: {
        revisionNumber: 3,
        sourceText: raw.activeRequirement.sourceText,
        objective: raw.activeRequirement.objective,
        constraints: raw.activeRequirement.constraints,
        acceptanceCriteria: raw.activeRequirement.acceptanceCriteria,
      },
      candidatePlan: {
        revisionNumber: 1,
        steps: [
          {
            title: "生成候选计划",
            description: "只生成并持久化待确认步骤。",
            acceptanceCriteria: ["内部 ID 不进入 renderer。"],
          },
        ],
      },
      confirmedPlan: null,
    });
    expect(JSON.stringify(detail)).not.toContain(raw.activeRequirement.revisionId);
    expect(JSON.stringify(detail)).not.toContain(raw.latestPlanRevisionId);
    expect(JSON.stringify(detail)).not.toContain(raw.candidatePlan.steps[0]!.stepId);
    expect(JSON.stringify(detail)).not.toContain("ownershipVersion");
    expect(Object.isFrozen(detail.activeRequirement.constraints)).toBe(true);
    expect(Object.isFrozen(detail.candidatePlan?.steps)).toBe(true);
    expect(
      decodeDesktopProjectTaskDetailResult({ status: "loaded", detail }, PROJECT.projectId, taskId),
    ).toEqual({ status: "loaded", detail });
    expect(
      decodeDesktopProjectTaskDetailResult({ status: "unavailable" }, PROJECT.projectId, taskId),
    ).toEqual({ status: "unavailable" });
    expect(
      decodeDesktopProjectTaskDetailResult({ status: "unexpected" }, PROJECT.projectId, taskId),
    ).toBeUndefined();

    const selection = { projectId: PROJECT.projectId, taskId };
    const revision = {
      ...selection,
      expectedTaskVersion: 3,
      sourceText: "再次补充需求。",
    };
    expect(decodeDesktopProjectTaskSelection(selection)).toEqual(selection);
    expect(decodeDesktopProjectTaskRequirementRevision(revision)).toEqual(revision);
    const catalog = {
      projectId: PROJECT.projectId,
      tasks: [
        {
          taskId,
          projectId: PROJECT.projectId,
          taskVersion: 3,
          title: raw.title,
          objective: raw.activeRequirement.objective,
          stage: raw.stage,
        },
      ],
      hasMore: false,
    };
    expect(
      decodeDesktopProjectTaskRequirementMutationResult(
        { status: "revised", taskId, detail, catalog },
        PROJECT.projectId,
        taskId,
      ),
    ).toEqual({ status: "revised", taskId, detail, catalog });
    expect(
      decodeDesktopProjectTaskRequirementMutationResult(
        { status: "conflict" },
        PROJECT.projectId,
        taskId,
      ),
    ).toEqual({ status: "conflict" });

    const generation = { ...selection, expectedTaskVersion: detail.taskVersion };
    expect(decodeDesktopProjectTaskCandidatePlanGeneration(generation)).toEqual(generation);
    expect(
      decodeDesktopProjectTaskCandidatePlanMutationResult(
        { status: "generated", taskId, detail, catalog },
        PROJECT.projectId,
        taskId,
      ),
    ).toEqual({ status: "generated", taskId, detail, catalog });
    const confirmation = {
      ...generation,
      candidatePlanRevisionNumber: detail.candidatePlan!.revisionNumber,
    };
    expect(decodeDesktopProjectTaskCandidatePlanConfirmation(confirmation)).toEqual(confirmation);
    const confirmedRaw = {
      ...raw,
      taskVersion: 5,
      stage: "confirmed_plan",
      latestPlanRevisionId: "00000000-0000-4000-8000-000000000887",
      candidatePlan: null,
      confirmedPlan: {
        ...raw.candidatePlan,
        revisionId: "00000000-0000-4000-8000-000000000887",
        revisionNumber: 2,
      },
    };
    const confirmedDetail = projectDesktopProjectTaskDetail(
      confirmedRaw,
      PROJECT.projectId,
      taskId,
    );
    expect(confirmedDetail).toMatchObject({
      stage: "confirmed_plan",
      candidatePlan: null,
      confirmedPlan: { revisionNumber: 2, steps: [{ title: "生成候选计划" }] },
    });
    expect(JSON.stringify(confirmedDetail)).not.toContain(confirmedRaw.confirmedPlan.revisionId);
    const confirmedCatalog = {
      ...catalog,
      tasks: [{ ...catalog.tasks[0], taskVersion: 5, stage: "confirmed_plan" }],
    };
    expect(
      decodeDesktopProjectTaskCandidatePlanConfirmationResult(
        {
          status: "confirmed",
          taskId,
          detail: confirmedDetail,
          catalog: confirmedCatalog,
        },
        PROJECT.projectId,
        taskId,
      ),
    ).toEqual({
      status: "confirmed",
      taskId,
      detail: confirmedDetail,
      catalog: confirmedCatalog,
    });
    expect(
      decodeDesktopProjectTaskCandidatePlanConfirmation({
        ...confirmation,
        candidatePlanRevisionNumber: 0,
      }),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskCandidatePlanConfirmationResult(
        { status: "confirmed", taskId, detail, catalog },
        PROJECT.projectId,
        taskId,
      ),
    ).toBeUndefined();

    const otherTaskId = "00000000-0000-4000-8000-000000000885";
    expect(decodeDesktopProjectTaskSelection({ ...selection, extra: true })).toBeUndefined();
    expect(
      decodeDesktopProjectTaskRequirementRevision({ ...revision, expectedTaskVersion: 0 }),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskDetailResult(
        { status: "loaded", detail: { ...detail, taskId: otherTaskId } },
        PROJECT.projectId,
        taskId,
      ),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskRequirementMutationResult(
        { status: "revised", taskId, detail: { ...detail, taskId: otherTaskId }, catalog },
        PROJECT.projectId,
        taskId,
      ),
    ).toBeUndefined();
    expect(() =>
      projectDesktopProjectTaskDetail(
        { ...raw, activeRequirement: { ...raw.activeRequirement, constraints: [" "] } },
        PROJECT.projectId,
        taskId,
      ),
    ).toThrow(BootstrapStateTransitionError);
    expect(() =>
      projectDesktopProjectTaskDetail(
        { ...raw, stage: "requirements_only" },
        PROJECT.projectId,
        taskId,
      ),
    ).toThrow(BootstrapStateTransitionError);
    expect(
      decodeDesktopProjectTaskDetailResult(
        { status: "loaded", detail: { ...detail, stage: "requirements_only" } },
        PROJECT.projectId,
        taskId,
      ),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectTaskDetailResult(
        {
          status: "loaded",
          detail: {
            ...detail,
            activeRequirement: {
              ...detail.activeRequirement,
              constraints: ["x".repeat(4_000)],
              acceptanceCriteria: Array.from({ length: 65 }, () => "x".repeat(4_000)),
            },
          },
        },
        PROJECT.projectId,
        taskId,
      ),
    ).toBeUndefined();
    expect(() =>
      projectDesktopProjectTaskDetail(
        {
          ...raw,
          activeRequirement: {
            ...raw.activeRequirement,
            constraints: ["x".repeat(4_000)],
            acceptanceCriteria: Array.from({ length: 65 }, () => "x".repeat(4_000)),
          },
        },
        PROJECT.projectId,
        taskId,
      ),
    ).toThrow(BootstrapStateTransitionError);
    expect(() =>
      projectDesktopProjectTaskDetail(
        { ...raw, privateFence: "secret" },
        PROJECT.projectId,
        taskId,
      ),
    ).toThrow(BootstrapStateTransitionError);
  });

  it("publishes only valid forward transitions and supports unsubscription", () => {
    const store = new BootstrapStateStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.transition(READY);
    store.transition(READY);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.current).toEqual(READY);

    unsubscribe();
    store.transition(failedBootstrapState("daemon_unavailable"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.current).toEqual({ phase: "failed", code: "daemon_unavailable" });
    expect(() => store.transition(READY)).toThrow(BootstrapStateTransitionError);
  });

  it("isolates a failing observer from state commits and later observers", () => {
    const store = new BootstrapStateStore();
    const observer = vi.fn();
    store.subscribe(() => {
      throw new Error("renderer unavailable");
    });
    store.subscribe(observer);

    expect(() => store.transition(READY)).not.toThrow();
    expect(store.current).toEqual(READY);
    expect(observer).toHaveBeenCalledExactlyOnceWith(READY);
  });

  it("rejects a stale snapshot after a newer event", () => {
    const staleStarting = Object.freeze({ phase: "starting" } as const);

    expect(advanceDesktopBootstrapState(READY, staleStarting)).toBe(READY);
    expect(advanceDesktopBootstrapState(staleStarting, READY)).toBe(READY);
  });
});
