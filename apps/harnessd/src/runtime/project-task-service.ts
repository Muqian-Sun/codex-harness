import { createHash, randomUUID } from "node:crypto";

import {
  decodeRequestParams,
  decodeResponseResult,
  type HarnessTaskCandidatePlanConfirmParams,
  type HarnessTaskCandidatePlanConfirmResult,
  type HarnessTaskCatalogPageParams,
  type HarnessTaskCatalogPageResult,
  type HarnessTaskCreateParams,
  type HarnessTaskCreateResult,
  type HarnessTaskDetailParams,
  type HarnessTaskDetailResult,
  type HarnessTaskGraphMaterializeParams,
  type HarnessTaskGraphMaterializeResult,
  type HarnessTaskRequirementReviseParams,
  type HarnessTaskRequirementReviseResult,
  type HarnessTaskStage,
  type HarnessTaskSummary,
  type JsonValue,
} from "@codex-harness/protocol";

import {
  ProjectRegistryError,
  ProjectRegistryRepository,
} from "../domain/project-registry-repository.js";
import {
  ProjectRoutingProfileBindingError,
  ProjectRoutingProfileBindingRepository,
} from "../domain/project-routing-profile-binding-repository.js";
import {
  TaskPlanError,
  TaskPlanRepository,
  type TaskPlanRecord,
} from "../domain/task-plan-store.js";
import {
  TaskProjectOwnershipError,
  TaskProjectOwnershipRepository,
} from "../domain/task-project-ownership-repository.js";
import type { DaemonStateStore } from "./daemon-state-store.js";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "./desktop-default-routing-profile.js";
import type { StoredEvent } from "../persistence/event-store.js";

const PLAN_CONFIRMATION_ACTOR = "desktop.project_task.plan_confirmation";
const GRAPH_MATERIALIZATION_ACTOR = "desktop.project_task.graph_materialization";
const TASK_PLAN_STREAM = "task.plan";
const PLAN_REVISED_EVENT = "task.plan_revised";
const GRAPH_COMMITTED_EVENT = "task.graph_committed";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ProjectTaskServiceErrorCode = "conflict" | "unavailable";

const ERROR_MESSAGES: Readonly<Record<ProjectTaskServiceErrorCode, string>> = Object.freeze({
  conflict: "The Project Task command conflicts with current state.",
  unavailable: "The Project Task service is unavailable.",
});

export class ProjectTaskServiceError extends Error {
  readonly code: ProjectTaskServiceErrorCode;

  constructor(code: ProjectTaskServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProjectTaskServiceError";
    this.code = code;
  }
}

type ServiceDependencies = Readonly<{ now(): number; newId?(): string }>;
type NormalizedServiceDependencies = Readonly<{ now(): number; newId(): string }>;

const PRODUCTION_DEPENDENCIES: NormalizedServiceDependencies = Object.freeze({
  now: () => Date.now(),
  newId: randomUUID,
});

export class ProjectTaskService {
  readonly #stateStore: DaemonStateStore;
  readonly #projects: ProjectRegistryRepository;
  readonly #bindings: ProjectRoutingProfileBindingRepository;
  readonly #tasks: TaskPlanRepository;
  readonly #ownerships: TaskProjectOwnershipRepository;
  readonly #dependencies: NormalizedServiceDependencies;

  constructor(
    stateStore: DaemonStateStore,
    dependencies: ServiceDependencies = PRODUCTION_DEPENDENCIES,
  ) {
    try {
      if (
        stateStore.state !== "ready" ||
        typeof dependencies?.now !== "function" ||
        (dependencies.newId !== undefined && typeof dependencies.newId !== "function")
      ) {
        throw new ProjectTaskServiceError("unavailable");
      }
      this.#stateStore = stateStore;
      this.#projects = new ProjectRegistryRepository(stateStore.events);
      this.#bindings = new ProjectRoutingProfileBindingRepository(stateStore.events);
      this.#tasks = new TaskPlanRepository(stateStore.events);
      this.#ownerships = new TaskProjectOwnershipRepository(stateStore.events);
      this.#dependencies = Object.freeze({
        now: dependencies.now,
        newId: dependencies.newId ?? PRODUCTION_DEPENDENCIES.newId,
      });
    } catch (error: unknown) {
      if (error instanceof ProjectTaskServiceError) {
        throw error;
      }
      throw new ProjectTaskServiceError("unavailable");
    }
  }

  list(input: unknown): HarnessTaskCatalogPageResult {
    const decoded = decodeRequestParams("task.catalog_page", input);
    if (!decoded.ok) {
      throw new ProjectTaskServiceError("conflict");
    }
    const params = decoded.value as HarnessTaskCatalogPageParams;

    try {
      this.#assertAvailable();
      this.#projects.readProject(params.projectId);
      const ownerships = this.#ownerships.listTasksForProject(
        params.projectId,
        params.cursor ?? "",
        params.limit + 1,
      );
      const hasMore = ownerships.length > params.limit;
      const visible = ownerships.slice(0, params.limit);
      const tasks = visible.map((ownership) =>
        taskSummary(this.#tasks.readTask(ownership.taskId), ownership.projectId),
      );
      return validateCatalogResult(
        {
          schemaVersion: 1,
          tasks,
          nextCursor: hasMore ? (tasks.at(-1)?.taskId ?? null) : null,
        },
        params.projectId,
      );
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  create(input: unknown): HarnessTaskCreateResult {
    const decoded = decodeRequestParams("task.create", input);
    if (!decoded.ok) {
      throw new ProjectTaskServiceError("conflict");
    }
    const params = decoded.value as HarnessTaskCreateParams;

    try {
      this.#assertAvailable();
      const existingTaskEvent = this.#stateStore.events.readByEventId(params.commandId);
      const existingOwnershipEvent = this.#stateStore.events.readByEventId(
        params.ownershipCommandId,
      );
      const retrying = existingTaskEvent !== undefined || existingOwnershipEvent !== undefined;
      if (!retrying) {
        const project = this.#projects.readProject(params.projectId);
        const binding = this.#bindings.readBinding(params.projectId);
        if (
          project.projectVersion !== params.expectedProjectVersion ||
          binding.bindingVersion !== params.expectedRoutingBindingVersion ||
          binding.profileId !== DESKTOP_DEFAULT_ROUTING_PROFILE_ID
        ) {
          throw new ProjectTaskServiceError("conflict");
        }
      }

      const occurredAtMs = retrying
        ? (existingTaskEvent?.occurredAtMs ?? existingOwnershipEvent!.occurredAtMs)
        : requireTimestamp(this.#dependencies.now());
      const created = this.#ownerships.createTaskInProject({
        task: {
          eventId: params.commandId,
          taskId: params.taskId,
          title: params.title,
          occurredAtMs,
          requirement: {
            revisionId: params.commandId,
            sourceText: params.sourceText,
            objective: params.sourceText,
            constraints: [],
            acceptanceCriteria: [],
          },
          metadata: { actor: "desktop.project_task" },
        },
        ownershipEventId: params.ownershipCommandId,
        projectId: params.projectId,
        expectedProjectVersion: params.expectedProjectVersion,
      });
      return validateCreateResult({
        schemaVersion: 1,
        status: created.duplicate ? "existing" : "created",
        taskId: params.taskId,
      });
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  detail(input: unknown): HarnessTaskDetailResult {
    const decoded = decodeRequestParams("task.detail", input);
    if (!decoded.ok) {
      throw new ProjectTaskServiceError("conflict");
    }
    const params = decoded.value as HarnessTaskDetailParams;

    try {
      this.#assertAvailable();
      this.#projects.readProject(params.projectId);
      const ownership = this.#ownerships.readOwnership(params.taskId);
      if (ownership.projectId !== params.projectId) {
        throw new ProjectTaskServiceError("conflict");
      }
      return validateDetailResult(
        taskDetail(
          this.#tasks.readTask(params.taskId),
          ownership.projectId,
          ownership.ownershipVersion,
        ),
        params,
      );
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  reviseRequirement(input: unknown): HarnessTaskRequirementReviseResult {
    const decoded = decodeRequestParams("task.requirement.revise", input);
    if (!decoded.ok) {
      throw new ProjectTaskServiceError("conflict");
    }
    const params = decoded.value as HarnessTaskRequirementReviseParams;

    try {
      this.#assertAvailable();
      const existing = this.#stateStore.events.readByEventId(params.commandId);
      const occurredAtMs =
        existing === undefined ? requireTimestamp(this.#dependencies.now()) : existing.occurredAtMs;
      if (existing === undefined) {
        const project = this.#projects.readProject(params.projectId);
        const ownership = this.#ownerships.readOwnership(params.taskId);
        const task = this.#tasks.readTask(params.taskId);
        if (
          ownership.projectId !== params.projectId ||
          ownership.ownershipVersion !== params.expectedOwnershipVersion ||
          task.taskVersion !== params.expectedTaskVersion ||
          task.activeRequirement.revisionId !== params.previousRequirementRevisionId
        ) {
          throw new ProjectTaskServiceError("conflict");
        }
        if (
          occurredAtMs < project.updatedAtMs ||
          occurredAtMs < ownership.updatedAtMs ||
          occurredAtMs < task.updatedAtMs
        ) {
          throw new ProjectTaskServiceError("conflict");
        }
      }

      const revised = this.#tasks.reviseRequirements({
        eventId: params.commandId,
        taskId: params.taskId,
        occurredAtMs,
        expectedTaskVersion: params.expectedTaskVersion,
        previousRequirementRevisionId: params.previousRequirementRevisionId,
        requirement: {
          revisionId: params.commandId,
          sourceText: params.sourceText,
          objective: params.sourceText,
          constraints: [],
          acceptanceCriteria: [],
        },
        metadata: {
          actor: "desktop.project_task.requirement",
          correlationId: params.projectId,
        },
      });
      return validateRequirementRevisionResult({
        schemaVersion: 1,
        status: revised.duplicate ? "existing" : "revised",
        taskId: params.taskId,
      });
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  confirmCandidatePlan(input: unknown): HarnessTaskCandidatePlanConfirmResult {
    const decoded = decodeRequestParams("task.plan.confirm_candidate", input);
    if (!decoded.ok) {
      throw new ProjectTaskServiceError("conflict");
    }
    const params = decoded.value as HarnessTaskCandidatePlanConfirmParams;

    try {
      this.#assertAvailable();
      const existing = this.#stateStore.events.readByEventId(params.commandId);
      if (existing !== undefined) {
        assertExistingPlanConfirmation(existing, params);
        return validatePlanConfirmationResult({
          schemaVersion: 1,
          status: "existing",
          taskId: params.taskId,
        });
      }

      const project = this.#projects.readProject(params.projectId);
      const ownership = this.#ownerships.readOwnership(params.taskId);
      const task = this.#tasks.readTask(params.taskId);
      const candidate = task.latestPlan?.status === "candidate" ? task.latestPlan : null;
      if (
        ownership.projectId !== params.projectId ||
        ownership.ownershipVersion !== params.expectedOwnershipVersion ||
        task.taskVersion !== params.expectedTaskVersion ||
        task.activeRequirement.revisionId !== params.previousRequirementRevisionId ||
        candidate?.revisionId !== params.candidatePlanRevisionId ||
        candidate.basedOnRequirementRevisionId !== params.previousRequirementRevisionId ||
        task.activeGraph?.nodes.some((node) => node.status === "running") === true
      ) {
        throw new ProjectTaskServiceError("conflict");
      }
      const occurredAtMs = requireTimestamp(this.#dependencies.now());
      if (
        occurredAtMs < project.updatedAtMs ||
        occurredAtMs < ownership.updatedAtMs ||
        occurredAtMs < task.updatedAtMs
      ) {
        throw new ProjectTaskServiceError("conflict");
      }
      const revised = this.#tasks.revisePlan({
        eventId: params.commandId,
        taskId: params.taskId,
        occurredAtMs,
        expectedTaskVersion: params.expectedTaskVersion,
        previousPlanRevisionId: params.candidatePlanRevisionId,
        plan: {
          revisionId: params.commandId,
          status: "confirmed",
          basedOnRequirementRevisionId: params.previousRequirementRevisionId,
          steps: candidate.steps,
        },
        metadata: {
          actor: PLAN_CONFIRMATION_ACTOR,
          correlationId: planConfirmationFingerprint(params),
        },
      });
      return validatePlanConfirmationResult({
        schemaVersion: 1,
        status: revised.duplicate ? "existing" : "confirmed",
        taskId: params.taskId,
      });
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  materializeGraph(input: unknown): HarnessTaskGraphMaterializeResult {
    const decoded = decodeRequestParams("task.graph.materialize", input);
    if (!decoded.ok) {
      throw new ProjectTaskServiceError("conflict");
    }
    const params = decoded.value as HarnessTaskGraphMaterializeParams;

    try {
      this.#assertAvailable();
      const existing = this.#stateStore.events.readByEventId(params.commandId);
      if (existing !== undefined) {
        assertExistingGraphMaterialization(existing, params);
        return validateGraphMaterializationResult({
          schemaVersion: 1,
          status: "existing",
          taskId: params.taskId,
        });
      }

      const project = this.#projects.readProject(params.projectId);
      const ownership = this.#ownerships.readOwnership(params.taskId);
      const task = this.#tasks.readTask(params.taskId);
      const confirmed = task.confirmedPlan;
      if (
        ownership.projectId !== params.projectId ||
        ownership.ownershipVersion !== params.expectedOwnershipVersion ||
        task.taskVersion !== params.expectedTaskVersion ||
        task.activeRequirement.revisionId !== params.previousRequirementRevisionId ||
        confirmed?.status !== "confirmed" ||
        confirmed.revisionId !== params.confirmedPlanRevisionId ||
        confirmed.basedOnRequirementRevisionId !== params.previousRequirementRevisionId ||
        task.latestPlan?.revisionId !== confirmed.revisionId ||
        task.latestPlan.status !== "confirmed" ||
        task.activeGraph !== null ||
        params.previousGraphRevisionId !== null
      ) {
        throw new ProjectTaskServiceError("conflict");
      }
      const occurredAtMs = requireTimestamp(this.#dependencies.now());
      if (
        occurredAtMs < project.updatedAtMs ||
        occurredAtMs < ownership.updatedAtMs ||
        occurredAtMs < task.updatedAtMs
      ) {
        throw new ProjectTaskServiceError("conflict");
      }
      const reservedIds = new Set([
        params.commandId,
        params.projectId,
        params.taskId,
        params.previousRequirementRevisionId,
        params.confirmedPlanRevisionId,
        ...confirmed.steps.map((step) => step.stepId),
      ]);
      const nodeIds = confirmed.steps.map(() => requireGeneratedUuid(this.#dependencies.newId()));
      if (
        nodeIds.some((nodeId) => reservedIds.has(nodeId)) ||
        new Set(nodeIds).size !== nodeIds.length
      ) {
        throw new ProjectTaskServiceError("unavailable");
      }
      const committed = this.#tasks.commitTaskGraph({
        eventId: params.commandId,
        taskId: params.taskId,
        occurredAtMs,
        expectedTaskVersion: params.expectedTaskVersion,
        previousGraphRevisionId: params.previousGraphRevisionId,
        graph: {
          revisionId: params.commandId,
          basedOnPlanRevisionId: confirmed.revisionId,
          nodes: confirmed.steps.map((step, index) =>
            Object.freeze({
              nodeId: nodeIds[index]!,
              sourcePlanStepId: step.stepId,
              title: step.title,
              description: step.description,
              acceptanceCriteria: Object.freeze([...step.acceptanceCriteria]),
              dependsOnNodeIds: Object.freeze(index === 0 ? [] : [nodeIds[index - 1]!]),
            }),
          ),
        },
        metadata: {
          actor: GRAPH_MATERIALIZATION_ACTOR,
          correlationId: graphMaterializationFingerprint(params),
        },
      });
      return validateGraphMaterializationResult({
        schemaVersion: 1,
        status: committed.duplicate ? "existing" : "materialized",
        taskId: params.taskId,
      });
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  #assertAvailable(): void {
    if (this.#stateStore.state !== "ready") {
      throw new ProjectTaskServiceError("unavailable");
    }
  }
}

function taskSummary(task: TaskPlanRecord, projectId: string): HarnessTaskSummary {
  return Object.freeze({
    taskId: task.taskId,
    projectId,
    taskVersion: task.taskVersion,
    title: task.title,
    objective: task.activeRequirement.objective,
    stage: taskStage(task),
  });
}

function taskDetail(
  task: TaskPlanRecord,
  projectId: string,
  ownershipVersion: number,
): HarnessTaskDetailResult {
  const candidatePlan =
    task.latestPlan?.status === "candidate" &&
    task.latestPlan.basedOnRequirementRevisionId === task.activeRequirement.revisionId
      ? task.latestPlan
      : null;
  const confirmedPlan =
    task.confirmedPlan?.status === "confirmed" &&
    task.confirmedPlan.basedOnRequirementRevisionId === task.activeRequirement.revisionId
      ? task.confirmedPlan
      : null;
  return Object.freeze({
    schemaVersion: 1,
    projectId,
    ownershipVersion,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    title: task.title,
    stage: taskStage(task),
    activeRequirement: Object.freeze({
      ...task.activeRequirement,
      constraints: Object.freeze([...task.activeRequirement.constraints]),
      acceptanceCriteria: Object.freeze([...task.activeRequirement.acceptanceCriteria]),
    }),
    latestPlanRevisionId: task.latestPlan?.revisionId ?? null,
    candidatePlan: projectTaskPlan(candidatePlan),
    confirmedPlan: projectTaskPlan(confirmedPlan),
    activeGraph:
      task.activeGraph === null
        ? null
        : Object.freeze({
            ...task.activeGraph,
            nodes: Object.freeze(
              task.activeGraph.nodes.map((node) =>
                Object.freeze({
                  ...node,
                  acceptanceCriteria: Object.freeze([...node.acceptanceCriteria]),
                  dependsOnNodeIds: Object.freeze([...node.dependsOnNodeIds]),
                }),
              ),
            ),
            topologicalOrder: Object.freeze([...task.activeGraph.topologicalOrder]),
          }),
  });
}

function projectTaskPlan(
  plan: TaskPlanRecord["latestPlan"],
): HarnessTaskDetailResult["candidatePlan"] {
  return plan === null
    ? null
    : Object.freeze({
        revisionId: plan.revisionId,
        revisionNumber: plan.revisionNumber,
        basedOnRequirementRevisionId: plan.basedOnRequirementRevisionId,
        steps: Object.freeze(
          plan.steps.map((step) =>
            Object.freeze({
              ...step,
              acceptanceCriteria: Object.freeze([...step.acceptanceCriteria]),
            }),
          ),
        ),
      });
}

function taskStage(task: TaskPlanRecord): HarnessTaskStage {
  const requirementId = task.activeRequirement.revisionId;
  const latestCurrent =
    task.latestPlan?.basedOnRequirementRevisionId === requirementId ? task.latestPlan : null;
  const confirmedCurrent =
    task.confirmedPlan?.basedOnRequirementRevisionId === requirementId ? task.confirmedPlan : null;
  const candidate = latestCurrent?.status === "candidate" ? latestCurrent : null;

  if (task.activeGraph !== null) {
    if (
      confirmedCurrent?.status !== "confirmed" ||
      task.activeGraph.basedOnPlanRevisionId !== confirmedCurrent.revisionId
    ) {
      throw new ProjectTaskServiceError("unavailable");
    }
    return candidate === null ? "active_graph" : "active_graph_with_candidate";
  }
  if (candidate !== null) {
    return "candidate_plan";
  }
  if (confirmedCurrent !== null) {
    if (
      confirmedCurrent.status !== "confirmed" ||
      (latestCurrent?.status === "confirmed" &&
        latestCurrent.revisionId !== confirmedCurrent.revisionId)
    ) {
      throw new ProjectTaskServiceError("unavailable");
    }
    return "confirmed_plan";
  }
  if (latestCurrent?.status === "confirmed") {
    throw new ProjectTaskServiceError("unavailable");
  }
  return "requirements_only";
}

function validateCatalogResult(input: unknown, projectId: string): HarnessTaskCatalogPageResult {
  const decoded = decodeResponseResult("task.catalog_page", input);
  if (!decoded.ok) {
    throw new ProjectTaskServiceError("unavailable");
  }
  const result = decoded.value as unknown as HarnessTaskCatalogPageResult;
  if (result.tasks.some((task) => task.projectId !== projectId)) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return Object.freeze({
    ...result,
    tasks: Object.freeze(result.tasks.map((task) => Object.freeze({ ...task }))),
  });
}

function validateCreateResult(input: unknown): HarnessTaskCreateResult {
  const decoded = decodeResponseResult("task.create", input);
  if (!decoded.ok) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return Object.freeze(decoded.value as unknown as HarnessTaskCreateResult);
}

function validateDetailResult(
  input: unknown,
  expected: HarnessTaskDetailParams,
): HarnessTaskDetailResult {
  const decoded = decodeResponseResult("task.detail", input);
  if (!decoded.ok) {
    throw new ProjectTaskServiceError("unavailable");
  }
  const result = decoded.value as unknown as HarnessTaskDetailResult;
  if (result.projectId !== expected.projectId || result.taskId !== expected.taskId) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return Object.freeze({
    ...result,
    activeRequirement: Object.freeze({
      ...result.activeRequirement,
      constraints: Object.freeze([...result.activeRequirement.constraints]),
      acceptanceCriteria: Object.freeze([...result.activeRequirement.acceptanceCriteria]),
    }),
    candidatePlan:
      result.candidatePlan === null
        ? null
        : Object.freeze({
            ...result.candidatePlan,
            steps: Object.freeze(
              result.candidatePlan.steps.map((step) =>
                Object.freeze({
                  ...step,
                  acceptanceCriteria: Object.freeze([...step.acceptanceCriteria]),
                }),
              ),
            ),
          }),
    confirmedPlan:
      result.confirmedPlan === null
        ? null
        : Object.freeze({
            ...result.confirmedPlan,
            steps: Object.freeze(
              result.confirmedPlan.steps.map((step) =>
                Object.freeze({
                  ...step,
                  acceptanceCriteria: Object.freeze([...step.acceptanceCriteria]),
                }),
              ),
            ),
          }),
    activeGraph:
      result.activeGraph === null
        ? null
        : Object.freeze({
            ...result.activeGraph,
            nodes: Object.freeze(
              result.activeGraph.nodes.map((node) =>
                Object.freeze({
                  ...node,
                  acceptanceCriteria: Object.freeze([...node.acceptanceCriteria]),
                  dependsOnNodeIds: Object.freeze([...node.dependsOnNodeIds]),
                }),
              ),
            ),
            topologicalOrder: Object.freeze([...result.activeGraph.topologicalOrder]),
          }),
  });
}

function validatePlanConfirmationResult(input: unknown): HarnessTaskCandidatePlanConfirmResult {
  const decoded = decodeResponseResult("task.plan.confirm_candidate", input);
  if (!decoded.ok) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return Object.freeze(decoded.value as unknown as HarnessTaskCandidatePlanConfirmResult);
}

function validateGraphMaterializationResult(input: unknown): HarnessTaskGraphMaterializeResult {
  const decoded = decodeResponseResult("task.graph.materialize", input);
  if (!decoded.ok) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return Object.freeze(decoded.value as unknown as HarnessTaskGraphMaterializeResult);
}

function validateRequirementRevisionResult(input: unknown): HarnessTaskRequirementReviseResult {
  const decoded = decodeResponseResult("task.requirement.revise", input);
  if (!decoded.ok) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return Object.freeze(decoded.value as unknown as HarnessTaskRequirementReviseResult);
}

function requireTimestamp(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return input;
}

function requireGeneratedUuid(input: string): string {
  if (!UUID_PATTERN.test(input)) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return input;
}

function planConfirmationFingerprint(params: HarnessTaskCandidatePlanConfirmParams): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.commandId,
        params.projectId,
        params.taskId,
        params.expectedTaskVersion,
        params.expectedOwnershipVersion,
        params.previousRequirementRevisionId,
        params.candidatePlanRevisionId,
      ]),
    )
    .digest("hex");
}

function graphMaterializationFingerprint(params: HarnessTaskGraphMaterializeParams): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.commandId,
        params.projectId,
        params.taskId,
        params.expectedTaskVersion,
        params.expectedOwnershipVersion,
        params.previousRequirementRevisionId,
        params.confirmedPlanRevisionId,
        params.previousGraphRevisionId,
      ]),
    )
    .digest("hex");
}

function assertExistingPlanConfirmation(
  event: StoredEvent,
  params: HarnessTaskCandidatePlanConfirmParams,
): void {
  const payload = exactRecord(event.payload, [
    "expectedTaskVersion",
    "plan",
    "previousPlanRevisionId",
    "taskId",
  ]);
  const plan = exactRecord(payload?.plan, [
    "basedOnRequirementRevisionId",
    "revisionId",
    "status",
    "steps",
  ]);
  if (
    event.streamType !== TASK_PLAN_STREAM ||
    event.streamId !== params.taskId ||
    event.eventType !== PLAN_REVISED_EVENT ||
    event.metadata.actor !== PLAN_CONFIRMATION_ACTOR ||
    event.metadata.correlationId !== planConfirmationFingerprint(params) ||
    payload?.taskId !== params.taskId ||
    payload.expectedTaskVersion !== params.expectedTaskVersion ||
    payload.previousPlanRevisionId !== params.candidatePlanRevisionId ||
    plan?.revisionId !== params.commandId ||
    plan.status !== "confirmed" ||
    plan.basedOnRequirementRevisionId !== params.previousRequirementRevisionId ||
    !Array.isArray(plan.steps)
  ) {
    throw new ProjectTaskServiceError("conflict");
  }
}

function assertExistingGraphMaterialization(
  event: StoredEvent,
  params: HarnessTaskGraphMaterializeParams,
): void {
  const payload = exactRecord(event.payload, [
    "expectedTaskVersion",
    "graph",
    "previousGraphRevisionId",
    "taskId",
  ]);
  const graph = exactRecord(payload?.graph, ["basedOnPlanRevisionId", "nodes", "revisionId"]);
  if (
    event.streamType !== TASK_PLAN_STREAM ||
    event.streamId !== params.taskId ||
    event.eventType !== GRAPH_COMMITTED_EVENT ||
    event.metadata.actor !== GRAPH_MATERIALIZATION_ACTOR ||
    event.metadata.correlationId !== graphMaterializationFingerprint(params) ||
    payload?.taskId !== params.taskId ||
    payload.expectedTaskVersion !== params.expectedTaskVersion ||
    payload.previousGraphRevisionId !== params.previousGraphRevisionId ||
    graph?.revisionId !== params.commandId ||
    graph.basedOnPlanRevisionId !== params.confirmedPlanRevisionId ||
    !Array.isArray(graph.nodes)
  ) {
    throw new ProjectTaskServiceError("conflict");
  }
}

function exactRecord(
  input: JsonValue | undefined,
  expectedKeys: readonly string[],
): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, JsonValue>;
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    ? record
    : undefined;
}

function mapServiceError(error: unknown): ProjectTaskServiceError {
  if (error instanceof ProjectTaskServiceError) {
    return error;
  }
  if (
    (error instanceof ProjectRegistryError ||
      error instanceof ProjectRoutingProfileBindingError ||
      error instanceof TaskPlanError ||
      error instanceof TaskProjectOwnershipError) &&
    (error.code === "conflict" || error.code === "invalid_input" || error.code === "not_found")
  ) {
    return new ProjectTaskServiceError("conflict");
  }
  return new ProjectTaskServiceError("unavailable");
}
