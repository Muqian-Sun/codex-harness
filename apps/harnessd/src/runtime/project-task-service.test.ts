import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import type { ModelRoutingConfiguration } from "../domain/model-routing-config.js";
import { ProjectRegistryRepository } from "../domain/project-registry-repository.js";
import { ProjectRoutingProfileBindingRepository } from "../domain/project-routing-profile-binding-repository.js";
import { TaskPlanRepository } from "../domain/task-plan-store.js";
import { DaemonStateStore } from "./daemon-state-store.js";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "./desktop-default-routing-profile.js";
import { ProjectTaskService, ProjectTaskServiceError } from "./project-task-service.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000931";
const PROJECT_EVENT_ID = "00000000-0000-4000-8000-000000000932";
const OTHER_PROJECT_ID = "00000000-0000-4000-8000-000000000942";
const OTHER_PROJECT_EVENT_ID = "00000000-0000-4000-8000-000000000943";
const PROFILE_REVISION_ID = "00000000-0000-4000-8000-000000000933";
const BINDING_EVENT_ID = "00000000-0000-4000-8000-000000000934";
const TASK_ID = "00000000-0000-4000-8000-000000000935";
const TASK_COMMAND_ID = "00000000-0000-4000-8000-000000000936";
const OWNERSHIP_COMMAND_ID = "00000000-0000-4000-8000-000000000937";
const CANDIDATE_PLAN_ID = "00000000-0000-4000-8000-000000000938";
const CONFIRMED_PLAN_ID = "00000000-0000-4000-8000-000000000939";
const CANDIDATE_AFTER_GRAPH_ID = "00000000-0000-4000-8000-00000000093a";
const STEP_ID = "00000000-0000-4000-8000-00000000093b";
const GRAPH_ID = "00000000-0000-4000-8000-00000000093c";
const NODE_ID = "00000000-0000-4000-8000-00000000093d";
const REQUIREMENT_REVISION_ID = "00000000-0000-4000-8000-00000000093e";
const LATER_REQUIREMENT_REVISION_ID = "00000000-0000-4000-8000-00000000093f";
const STALE_CONFIRMATION_ID = "00000000-0000-4000-8000-000000000950";
const CONFIRM_AFTER_GRAPH_ID = "00000000-0000-4000-8000-000000000951";
const STEP_TWO_ID = "00000000-0000-4000-8000-000000000952";
const NODE_TWO_ID = "00000000-0000-4000-8000-000000000953";
const STALE_GRAPH_ID = "00000000-0000-4000-8000-000000000954";
const temporaryDirectories: string[] = [];
const stores: DaemonStateStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-project-task-service-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openStore(path?: string): Promise<DaemonStateStore> {
  const store = await DaemonStateStore.open({ databasePath: path ?? (await databasePath()) });
  stores.push(store);
  return store;
}

function configuration(): ModelRoutingConfiguration {
  return {
    schemaVersion: 1,
    revisionId: PROFILE_REVISION_ID,
    revisionNumber: 1,
    tiers: {
      fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
      standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
      deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
    },
  };
}

function registerProject(
  store: DaemonStateStore,
  projectId = PROJECT_ID,
  eventId = PROJECT_EVENT_ID,
): void {
  new ProjectRegistryRepository(store.events).registerProject({
    eventId,
    projectId,
    displayName: "workspace",
    workspace: { platform: "macos", absolutePath: `/Users/example/${projectId}` },
    occurredAtMs: 100,
  });
}

function bindDefaultProfile(store: DaemonStateStore): void {
  new ModelRoutingProfileRepository(store.events).setConfiguration({
    profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs: 101,
    configuration: configuration(),
  });
  new ProjectRoutingProfileBindingRepository(store.events).bindProfile({
    eventId: BINDING_EVENT_ID,
    projectId: PROJECT_ID,
    expectedBindingVersion: 0,
    previousProfileId: null,
    profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: PROFILE_REVISION_ID,
    occurredAtMs: 102,
  });
}

function createParams(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandId: TASK_COMMAND_ID,
    ownershipCommandId: OWNERSHIP_COMMAND_ID,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    expectedProjectVersion: 1,
    expectedRoutingBindingVersion: 1,
    title: "持久 Task",
    sourceText: "保存初始需求，但不调用模型。",
    ...overrides,
  };
}

function reviseParams(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandId: REQUIREMENT_REVISION_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    expectedTaskVersion: 1,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: TASK_COMMAND_ID,
    sourceText: "用户澄清后的需求。",
    ...overrides,
  };
}

function confirmParams(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandId: CONFIRMED_PLAN_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    expectedTaskVersion: 2,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: TASK_COMMAND_ID,
    candidatePlanRevisionId: CANDIDATE_PLAN_ID,
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("ProjectTaskService", () => {
  it("atomically creates, lists, and recovers a requirements-only Project Task", async () => {
    const path = await databasePath();
    const store = await openStore(path);
    registerProject(store);
    bindDefaultProfile(store);
    const now = vi.fn(() => 103);
    const service = new ProjectTaskService(store, { now });

    expect(service.create(createParams())).toEqual({
      schemaVersion: 1,
      status: "created",
      taskId: TASK_ID,
    });
    const page = service.list({ projectId: PROJECT_ID, cursor: null, limit: 12 });
    expect(page).toEqual({
      schemaVersion: 1,
      tasks: [
        {
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          taskVersion: 1,
          title: "持久 Task",
          objective: "保存初始需求，但不调用模型。",
          stage: "requirements_only",
        },
      ],
      nextCursor: null,
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.tasks)).toBe(true);
    expect(JSON.stringify(page)).not.toContain("sourceText");
    expect(store.inspect()).toMatchObject({ eventCount: 5, lastSequence: 5 });
    store.close();

    const reopened = await openStore(path);
    expect(
      new ProjectTaskService(reopened).list({ projectId: PROJECT_ID, cursor: null, limit: 12 }),
    ).toEqual(page);
  });

  it("derives candidate, confirmed, active graph, and graph-with-candidate stages", async () => {
    const store = await openStore();
    registerProject(store);
    bindDefaultProfile(store);
    const service = new ProjectTaskService(store, { now: () => 103 });
    service.create(createParams());
    const tasks = new TaskPlanRepository(store.events);
    const step = {
      stepId: STEP_ID,
      title: "形成计划",
      description: "后续计划能力提供的稳定步骤。",
      acceptanceCriteria: ["计划可恢复"],
    };

    tasks.revisePlan({
      eventId: CANDIDATE_PLAN_ID,
      taskId: TASK_ID,
      occurredAtMs: 104,
      expectedTaskVersion: 1,
      previousPlanRevisionId: null,
      plan: {
        revisionId: CANDIDATE_PLAN_ID,
        status: "candidate",
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps: [step],
      },
    });
    expect(service.list({ projectId: PROJECT_ID, cursor: null, limit: 12 }).tasks[0]?.stage).toBe(
      "candidate_plan",
    );

    tasks.revisePlan({
      eventId: CONFIRMED_PLAN_ID,
      taskId: TASK_ID,
      occurredAtMs: 105,
      expectedTaskVersion: 2,
      previousPlanRevisionId: CANDIDATE_PLAN_ID,
      plan: {
        revisionId: CONFIRMED_PLAN_ID,
        status: "confirmed",
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps: [step],
      },
    });
    expect(service.list({ projectId: PROJECT_ID, cursor: null, limit: 12 }).tasks[0]?.stage).toBe(
      "confirmed_plan",
    );

    tasks.commitTaskGraph({
      eventId: GRAPH_ID,
      taskId: TASK_ID,
      occurredAtMs: 106,
      expectedTaskVersion: 3,
      previousGraphRevisionId: null,
      graph: {
        revisionId: GRAPH_ID,
        basedOnPlanRevisionId: CONFIRMED_PLAN_ID,
        nodes: [
          {
            nodeId: NODE_ID,
            sourcePlanStepId: STEP_ID,
            title: step.title,
            description: step.description,
            acceptanceCriteria: step.acceptanceCriteria,
            dependsOnNodeIds: [],
          },
        ],
      },
    });
    expect(service.list({ projectId: PROJECT_ID, cursor: null, limit: 12 }).tasks[0]?.stage).toBe(
      "active_graph",
    );

    tasks.revisePlan({
      eventId: CANDIDATE_AFTER_GRAPH_ID,
      taskId: TASK_ID,
      occurredAtMs: 107,
      expectedTaskVersion: 4,
      previousPlanRevisionId: CONFIRMED_PLAN_ID,
      plan: {
        revisionId: CANDIDATE_AFTER_GRAPH_ID,
        status: "candidate",
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps: [step],
      },
    });
    expect(service.list({ projectId: PROJECT_ID, cursor: null, limit: 12 }).tasks[0]?.stage).toBe(
      "active_graph_with_candidate",
    );
    expect(
      new ProjectTaskService(store, { now: () => 108 }).confirmCandidatePlan(
        confirmParams({
          commandId: CONFIRM_AFTER_GRAPH_ID,
          expectedTaskVersion: 5,
          candidatePlanRevisionId: CANDIDATE_AFTER_GRAPH_ID,
        }),
      ).status,
    ).toBe("confirmed");
    expect(service.detail({ projectId: PROJECT_ID, taskId: TASK_ID })).toMatchObject({
      stage: "confirmed_plan",
      candidatePlan: null,
      confirmedPlan: { revisionId: CONFIRM_AFTER_GRAPH_ID },
    });
    expect(tasks.readTask(TASK_ID).activeGraph).toBeNull();
  });

  it("reads, revises, and recovers a Project-bound Task Requirement", async () => {
    const path = await databasePath();
    const store = await openStore(path);
    registerProject(store);
    bindDefaultProfile(store);
    const service = new ProjectTaskService(store, { now: () => 104 });
    service.create(createParams());

    const initial = service.detail({ projectId: PROJECT_ID, taskId: TASK_ID });
    expect(initial).toEqual({
      schemaVersion: 1,
      projectId: PROJECT_ID,
      ownershipVersion: 1,
      taskId: TASK_ID,
      taskVersion: 1,
      title: "持久 Task",
      stage: "requirements_only",
      activeRequirement: {
        revisionId: TASK_COMMAND_ID,
        revisionNumber: 1,
        sourceText: "保存初始需求，但不调用模型。",
        objective: "保存初始需求，但不调用模型。",
        constraints: [],
        acceptanceCriteria: [],
      },
      latestPlanRevisionId: null,
      candidatePlan: null,
      confirmedPlan: null,
      activeGraph: null,
    });
    expect(Object.isFrozen(initial.activeRequirement.constraints)).toBe(true);
    expect(service.reviseRequirement(reviseParams())).toEqual({
      schemaVersion: 1,
      status: "revised",
      taskId: TASK_ID,
    });

    const revised = service.detail({ projectId: PROJECT_ID, taskId: TASK_ID });
    expect(revised).toMatchObject({
      taskVersion: 2,
      stage: "requirements_only",
      activeRequirement: {
        revisionId: REQUIREMENT_REVISION_ID,
        revisionNumber: 2,
        sourceText: "用户澄清后的需求。",
        objective: "用户澄清后的需求。",
        constraints: [],
        acceptanceCriteria: [],
      },
    });
    expect(service.list({ projectId: PROJECT_ID, cursor: null, limit: 12 }).tasks[0]).toMatchObject(
      {
        taskVersion: 2,
        objective: "用户澄清后的需求。",
      },
    );
    expect(store.events.readByEventId(REQUIREMENT_REVISION_ID)).toMatchObject({
      eventType: "task.requirements_revised",
      metadata: {
        actor: "desktop.project_task.requirement",
        correlationId: PROJECT_ID,
      },
    });
    store.close();

    const reopened = await openStore(path);
    expect(
      new ProjectTaskService(reopened).detail({ projectId: PROJECT_ID, taskId: TASK_ID }),
    ).toEqual(revised);
  });

  it("confirms only the current candidate Plan with stable steps and durable idempotence", async () => {
    const store = await openStore();
    registerProject(store);
    bindDefaultProfile(store);
    new ProjectTaskService(store, { now: () => 103 }).create(createParams());
    const tasks = new TaskPlanRepository(store.events);
    const step = {
      stepId: STEP_ID,
      title: "形成计划",
      description: "确认时保留稳定步骤标识。",
      acceptanceCriteria: ["确认后仍不可执行"],
    };
    tasks.revisePlan({
      eventId: CANDIDATE_PLAN_ID,
      taskId: TASK_ID,
      occurredAtMs: 104,
      expectedTaskVersion: 1,
      previousPlanRevisionId: null,
      plan: {
        revisionId: CANDIDATE_PLAN_ID,
        status: "candidate",
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps: [step],
      },
    });
    const now = vi.fn(() => 105);
    const service = new ProjectTaskService(store, { now });

    expect(service.confirmCandidatePlan(confirmParams())).toEqual({
      schemaVersion: 1,
      status: "confirmed",
      taskId: TASK_ID,
    });
    const confirmed = service.detail({ projectId: PROJECT_ID, taskId: TASK_ID });
    expect(confirmed).toMatchObject({
      taskVersion: 3,
      stage: "confirmed_plan",
      latestPlanRevisionId: CONFIRMED_PLAN_ID,
      candidatePlan: null,
      confirmedPlan: {
        revisionId: CONFIRMED_PLAN_ID,
        revisionNumber: 2,
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps: [step],
      },
    });
    expect(Object.isFrozen(confirmed.confirmedPlan?.steps[0]?.acceptanceCriteria)).toBe(true);
    expect(store.events.readByEventId(CONFIRMED_PLAN_ID)).toMatchObject({
      eventType: "task.plan_revised",
      metadata: { actor: "desktop.project_task.plan_confirmation" },
      payload: {
        expectedTaskVersion: 2,
        previousPlanRevisionId: CANDIDATE_PLAN_ID,
        plan: { status: "confirmed", steps: [step] },
      },
    });

    tasks.revisePlan({
      eventId: CANDIDATE_AFTER_GRAPH_ID,
      taskId: TASK_ID,
      occurredAtMs: 106,
      expectedTaskVersion: 3,
      previousPlanRevisionId: CONFIRMED_PLAN_ID,
      plan: {
        revisionId: CANDIDATE_AFTER_GRAPH_ID,
        status: "candidate",
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps: [step],
      },
    });
    expect(service.confirmCandidatePlan(confirmParams())).toEqual({
      schemaVersion: 1,
      status: "existing",
      taskId: TASK_ID,
    });
    expect(now).toHaveBeenCalledTimes(1);
    expect(() =>
      service.confirmCandidatePlan(confirmParams({ expectedTaskVersion: 3 })),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() =>
      service.confirmCandidatePlan(confirmParams({ commandId: STALE_CONFIRMATION_ID })),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(store.events.readByEventId(STALE_CONFIRMATION_ID)).toBeUndefined();
  });

  it("materializes a confirmed Plan as a durable conservative pending DAG", async () => {
    const path = await databasePath();
    const store = await openStore(path);
    registerProject(store);
    bindDefaultProfile(store);
    new ProjectTaskService(store, { now: () => 103 }).create(createParams());
    const tasks = new TaskPlanRepository(store.events);
    const steps = [
      {
        stepId: STEP_ID,
        title: "先完成设计",
        description: "固定职责边界。",
        acceptanceCriteria: ["设计可审阅"],
      },
      {
        stepId: STEP_TWO_ID,
        title: "再完成实现",
        description: "按设计实现并验证。",
        acceptanceCriteria: ["实现可验证"],
      },
    ];
    tasks.revisePlan({
      eventId: CANDIDATE_PLAN_ID,
      taskId: TASK_ID,
      occurredAtMs: 104,
      expectedTaskVersion: 1,
      previousPlanRevisionId: null,
      plan: {
        revisionId: CANDIDATE_PLAN_ID,
        status: "candidate",
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps,
      },
    });
    new ProjectTaskService(store, { now: () => 105 }).confirmCandidatePlan(confirmParams());
    const newId = vi.fn().mockReturnValueOnce(NODE_ID).mockReturnValueOnce(NODE_TWO_ID);
    const service = new ProjectTaskService(store, { now: () => 106, newId });
    const params = {
      commandId: GRAPH_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      expectedTaskVersion: 3,
      expectedOwnershipVersion: 1,
      previousRequirementRevisionId: TASK_COMMAND_ID,
      confirmedPlanRevisionId: CONFIRMED_PLAN_ID,
      previousGraphRevisionId: null,
    } as const;

    expect(service.materializeGraph(params)).toEqual({
      schemaVersion: 1,
      status: "materialized",
      taskId: TASK_ID,
    });
    const detail = service.detail({ projectId: PROJECT_ID, taskId: TASK_ID });
    expect(detail).toMatchObject({
      taskVersion: 4,
      stage: "active_graph",
      candidatePlan: null,
      activeGraph: {
        revisionId: GRAPH_ID,
        revisionNumber: 1,
        basedOnPlanRevisionId: CONFIRMED_PLAN_ID,
        topologicalOrder: [NODE_ID, NODE_TWO_ID],
        nodes: [
          {
            nodeId: NODE_ID,
            sourcePlanStepId: STEP_ID,
            dependsOnNodeIds: [],
            status: "pending",
          },
          {
            nodeId: NODE_TWO_ID,
            sourcePlanStepId: STEP_TWO_ID,
            dependsOnNodeIds: [NODE_ID],
            status: "pending",
          },
        ],
      },
    });
    expect(Object.isFrozen(detail.activeGraph?.nodes)).toBe(true);
    expect(Object.isFrozen(detail.activeGraph?.nodes[1]?.dependsOnNodeIds)).toBe(true);
    expect(store.events.readByEventId(GRAPH_ID)).toMatchObject({
      eventType: "task.graph_committed",
      metadata: { actor: "desktop.project_task.graph_materialization" },
      payload: {
        expectedTaskVersion: 3,
        previousGraphRevisionId: null,
        graph: { revisionId: GRAPH_ID, basedOnPlanRevisionId: CONFIRMED_PLAN_ID },
      },
    });

    tasks.revisePlan({
      eventId: CANDIDATE_AFTER_GRAPH_ID,
      taskId: TASK_ID,
      occurredAtMs: 107,
      expectedTaskVersion: 4,
      previousPlanRevisionId: CONFIRMED_PLAN_ID,
      plan: {
        revisionId: CANDIDATE_AFTER_GRAPH_ID,
        status: "candidate",
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps,
      },
    });
    expect(service.materializeGraph(params)).toEqual({
      schemaVersion: 1,
      status: "existing",
      taskId: TASK_ID,
    });
    expect(() =>
      service.materializeGraph({ ...params, expectedTaskVersion: params.expectedTaskVersion + 1 }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(newId).toHaveBeenCalledTimes(2);
    expect(() =>
      service.materializeGraph({ ...params, commandId: STALE_GRAPH_ID, expectedTaskVersion: 5 }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    const recoveredExpected = service.detail({ projectId: PROJECT_ID, taskId: TASK_ID });
    store.close();

    const reopened = await openStore(path);
    expect(
      new ProjectTaskService(reopened).detail({ projectId: PROJECT_ID, taskId: TASK_ID }),
    ).toEqual(recoveredExpected);
  });

  it("retries exact Requirement history and rejects stale or cross-Project commands", async () => {
    const store = await openStore();
    registerProject(store);
    bindDefaultProfile(store);
    const now = vi.fn(() => 104);
    const service = new ProjectTaskService(store, { now });
    service.create(createParams());
    registerProject(store, OTHER_PROJECT_ID, OTHER_PROJECT_EVENT_ID);
    now.mockClear();
    expect(service.reviseRequirement(reviseParams()).status).toBe("revised");

    new TaskPlanRepository(store.events).reviseRequirements({
      eventId: LATER_REQUIREMENT_REVISION_ID,
      taskId: TASK_ID,
      occurredAtMs: 105,
      expectedTaskVersion: 2,
      previousRequirementRevisionId: REQUIREMENT_REVISION_ID,
      requirement: {
        revisionId: LATER_REQUIREMENT_REVISION_ID,
        sourceText: "更晚的需求。",
        objective: "更晚的需求。",
        constraints: [],
        acceptanceCriteria: [],
      },
    });
    expect(service.reviseRequirement(reviseParams())).toEqual({
      schemaVersion: 1,
      status: "existing",
      taskId: TASK_ID,
    });
    expect(now).toHaveBeenCalledTimes(1);

    expect(() =>
      service.reviseRequirement(
        reviseParams({ projectId: "00000000-0000-4000-8000-000000000940" }),
      ),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() =>
      service.reviseRequirement(
        reviseParams({
          commandId: "00000000-0000-4000-8000-000000000941",
          sourceText: "过期写入。",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() =>
      service.detail({
        projectId: OTHER_PROJECT_ID,
        taskId: TASK_ID,
      }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(store.events.readByEventId("00000000-0000-4000-8000-000000000941")).toBeUndefined();
  });

  it("accepts exact history before current fences and rejects partial or stale commands", async () => {
    const store = await openStore();
    registerProject(store);
    bindDefaultProfile(store);
    const now = vi.fn(() => 103);
    const service = new ProjectTaskService(store, { now });
    expect(service.create(createParams()).status).toBe("created");

    new TaskPlanRepository(store.events).reviseRequirements({
      eventId: "00000000-0000-4000-8000-00000000093e",
      taskId: TASK_ID,
      occurredAtMs: 104,
      expectedTaskVersion: 1,
      previousRequirementRevisionId: TASK_COMMAND_ID,
      requirement: {
        revisionId: "00000000-0000-4000-8000-00000000093e",
        sourceText: "修订后的需求。",
        objective: "修订后的需求。",
        constraints: [],
        acceptanceCriteria: [],
      },
    });
    expect(service.create(createParams({ expectedRoutingBindingVersion: 99 }))).toEqual({
      schemaVersion: 1,
      status: "existing",
      taskId: TASK_ID,
    });
    expect(now).toHaveBeenCalledTimes(1);

    expect(() =>
      service.create(
        createParams({
          commandId: "00000000-0000-4000-8000-00000000093f",
          ownershipCommandId: "00000000-0000-4000-8000-000000000940",
          taskId: "00000000-0000-4000-8000-000000000941",
          expectedRoutingBindingVersion: 2,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(store.events.readByEventId("00000000-0000-4000-8000-00000000093f")).toBeUndefined();
  });

  it("requires a registered default-bound Project and contains invalid or closed state", async () => {
    const unbound = await openStore();
    registerProject(unbound);
    const service = new ProjectTaskService(unbound, { now: () => 103 });
    expect(() => service.create(createParams())).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => service.list({ projectId: PROJECT_ID, cursor: null, limit: 13 })).toThrowError(
      ProjectTaskServiceError,
    );
    expect(() => service.create(createParams({ title: " " }))).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => service.detail({ projectId: PROJECT_ID, taskId: "bad" })).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => service.reviseRequirement(reviseParams({ sourceText: " " }))).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() =>
      service.confirmCandidatePlan(confirmParams({ expectedTaskVersion: 0 })),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() =>
      service.list({ projectId: "00000000-0000-4000-8000-000000000942", cursor: null, limit: 12 }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));

    unbound.close();
    expect(() => service.confirmCandidatePlan(confirmParams())).toThrowError(
      expect.objectContaining({ code: "unavailable" }),
    );
    expect(() => service.list({ projectId: PROJECT_ID, cursor: null, limit: 12 })).toThrowError(
      expect.objectContaining({ code: "unavailable" }),
    );
    expect(() => service.detail({ projectId: PROJECT_ID, taskId: TASK_ID })).toThrowError(
      expect.objectContaining({ code: "unavailable" }),
    );
    expect(
      () =>
        new ProjectTaskService({
          state: "closed",
        } as unknown as DaemonStateStore),
    ).toThrowError(expect.objectContaining({ code: "unavailable" }));
    expect(
      () =>
        new ProjectTaskService({
          state: "ready",
          events: undefined,
        } as unknown as DaemonStateStore),
    ).toThrowError(expect.objectContaining({ code: "unavailable" }));

    const invalidClock = await openStore();
    registerProject(invalidClock);
    bindDefaultProfile(invalidClock);
    expect(() =>
      new ProjectTaskService(invalidClock, { now: () => -1 }).create(createParams()),
    ).toThrowError(expect.objectContaining({ code: "unavailable" }));

    const regressingClock = await openStore();
    registerProject(regressingClock);
    bindDefaultProfile(regressingClock);
    new ProjectTaskService(regressingClock, { now: () => 103 }).create(createParams());
    expect(() =>
      new ProjectTaskService(regressingClock, { now: () => 102 }).reviseRequirement(reviseParams()),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
  });
});
