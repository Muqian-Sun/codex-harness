import {
  decodeRequestParams,
  decodeResponseResult,
  type HarnessTaskCatalogPageParams,
  type HarnessTaskCatalogPageResult,
  type HarnessTaskCreateParams,
  type HarnessTaskCreateResult,
  type HarnessTaskStage,
  type HarnessTaskSummary,
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

type ServiceDependencies = Readonly<{ now(): number }>;

const PRODUCTION_DEPENDENCIES: ServiceDependencies = Object.freeze({ now: () => Date.now() });

export class ProjectTaskService {
  readonly #stateStore: DaemonStateStore;
  readonly #projects: ProjectRegistryRepository;
  readonly #bindings: ProjectRoutingProfileBindingRepository;
  readonly #tasks: TaskPlanRepository;
  readonly #ownerships: TaskProjectOwnershipRepository;
  readonly #dependencies: ServiceDependencies;

  constructor(
    stateStore: DaemonStateStore,
    dependencies: ServiceDependencies = PRODUCTION_DEPENDENCIES,
  ) {
    try {
      if (stateStore.state !== "ready" || typeof dependencies?.now !== "function") {
        throw new ProjectTaskServiceError("unavailable");
      }
      this.#stateStore = stateStore;
      this.#projects = new ProjectRegistryRepository(stateStore.events);
      this.#bindings = new ProjectRoutingProfileBindingRepository(stateStore.events);
      this.#tasks = new TaskPlanRepository(stateStore.events);
      this.#ownerships = new TaskProjectOwnershipRepository(stateStore.events);
      this.#dependencies = Object.freeze({ now: dependencies.now });
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

function requireTimestamp(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new ProjectTaskServiceError("unavailable");
  }
  return input;
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
