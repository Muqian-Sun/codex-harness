import { createHash } from "node:crypto";

import {
  decodeRequestParams,
  decodeResponseResult,
  type HarnessTaskExecutionActivateParams,
  type HarnessTaskExecutionActivateResult,
  type JsonValue,
} from "@codex-harness/protocol";

import type { ModelCatalogSnapshot } from "../domain/model-catalog.js";
import {
  evaluateNodeExecutionAdmission,
  type NodeExecutionAdmissionEvaluation,
} from "../domain/node-execution-admission.js";
import {
  NodeOperationManifestRepository,
  type NodeOperationManifestRecord,
} from "../domain/node-operation-manifest-repository.js";
import {
  ProjectRegistryRepository,
  type ProjectRecord,
} from "../domain/project-registry-repository.js";
import {
  ProjectRoutingProfileBindingRepository,
  type ProjectRoutingProfileBindingRecord,
} from "../domain/project-routing-profile-binding-repository.js";
import {
  RouteActivationRepository,
  RouteActivationRepositoryError,
  type NodeExecutionAdmissionRecord,
  type RouteActivation,
} from "../domain/route-activation-repository.js";
import { previewSerialTaskSchedule } from "../domain/serial-task-scheduler.js";
import { ShadowRouteDecisionRepository } from "../domain/shadow-route-decision-repository.js";
import {
  ModelRoutingProfileRepository,
  type ModelRoutingProfileRecord,
} from "../domain/model-routing-profile-repository.js";
import { TaskPlanRepository, type TaskPlanRecord } from "../domain/task-plan-store.js";
import {
  TaskProjectOwnershipRepository,
  type TaskProjectOwnershipRecord,
} from "../domain/task-project-ownership-repository.js";
import type { AppServerWorkerManager } from "./app-server-worker-manager.js";
import type { DaemonStateStore } from "./daemon-state-store.js";
import {
  MacosWorkspaceAdmissionObserver,
  type MacosWorkspaceAdmissionObservation,
} from "./macos-workspace-admission-observer.js";

const ACTIVATION_ACTOR = "desktop.project_task.execution_activation";

export type NodeExecutionAdmissionServiceErrorCode = "conflict" | "unavailable";

export class NodeExecutionAdmissionServiceError extends Error {
  readonly code: NodeExecutionAdmissionServiceErrorCode;

  constructor(code: NodeExecutionAdmissionServiceErrorCode) {
    super(`The node execution admission service failed: ${code}.`);
    this.name = "NodeExecutionAdmissionServiceError";
    this.code = code;
  }
}

type WorkspaceObserver = Readonly<{
  observe(workspace: ProjectRecord["workspace"]): Promise<MacosWorkspaceAdmissionObservation>;
}>;

type ServiceDependencies = Readonly<{
  now(): number;
  workspaceObserver: WorkspaceObserver;
}>;

type CapturedState = Readonly<{
  project: ProjectRecord;
  ownership: TaskProjectOwnershipRecord;
  task: TaskPlanRecord;
  manifest: NodeOperationManifestRecord;
  binding: ProjectRoutingProfileBindingRecord;
  profile: ModelRoutingProfileRecord;
  catalog: ModelCatalogSnapshot;
}>;

export class NodeExecutionAdmissionService {
  readonly #stateStore: DaemonStateStore;
  readonly #workerManager: AppServerWorkerManager;
  readonly #projects: ProjectRegistryRepository;
  readonly #ownerships: TaskProjectOwnershipRepository;
  readonly #tasks: TaskPlanRepository;
  readonly #manifests: NodeOperationManifestRepository;
  readonly #bindings: ProjectRoutingProfileBindingRepository;
  readonly #profiles: ModelRoutingProfileRepository;
  readonly #routes: ShadowRouteDecisionRepository;
  readonly #activations: RouteActivationRepository;
  readonly #dependencies: ServiceDependencies;

  constructor(
    stateStore: DaemonStateStore,
    workerManager: AppServerWorkerManager,
    dependencies: Partial<ServiceDependencies> = {},
  ) {
    try {
      if (stateStore.state !== "ready" || workerManager.state !== "ready") {
        throw new NodeExecutionAdmissionServiceError("unavailable");
      }
      this.#stateStore = stateStore;
      this.#workerManager = workerManager;
      this.#projects = new ProjectRegistryRepository(stateStore.events);
      this.#ownerships = new TaskProjectOwnershipRepository(stateStore.events);
      this.#tasks = new TaskPlanRepository(stateStore.events);
      this.#manifests = new NodeOperationManifestRepository(stateStore.events);
      this.#bindings = new ProjectRoutingProfileBindingRepository(stateStore.events);
      this.#profiles = new ModelRoutingProfileRepository(stateStore.events);
      this.#routes = new ShadowRouteDecisionRepository(stateStore.events);
      this.#activations = new RouteActivationRepository(stateStore.events);
      this.#dependencies = Object.freeze({
        now: dependencies.now ?? (() => Date.now()),
        workspaceObserver: dependencies.workspaceObserver ?? new MacosWorkspaceAdmissionObserver(),
      });
    } catch (error: unknown) {
      if (error instanceof NodeExecutionAdmissionServiceError) throw error;
      throw new NodeExecutionAdmissionServiceError("unavailable");
    }
  }

  async activate(input: unknown): Promise<HarnessTaskExecutionActivateResult> {
    const decoded = decodeRequestParams("task.execution.activate", input);
    if (!decoded.ok) throw new NodeExecutionAdmissionServiceError("conflict");
    const params = decoded.value as HarnessTaskExecutionActivateParams;
    const commandDigest = digestJson(params as JsonValue);

    try {
      this.#assertAvailable();
      const existing = this.#readExisting(params.taskId, params.activationId);
      if (existing !== null) {
        if (existing.commandDigest !== commandDigest) {
          throw new NodeExecutionAdmissionServiceError("conflict");
        }
        return resultFromRecord(existing, true);
      }

      const before = this.#capture(params);
      const evaluation = evaluateNodeExecutionAdmission(
        before.task,
        before.manifest.operations,
        params.userConfirmed,
      );
      const decisionOccurredAtMs = requireTimestamp(this.#dependencies.now());
      assertTimestampNotBeforeState(decisionOccurredAtMs, before);
      const routed = this.#routes.record({
        decisionId: params.decisionId,
        taskId: params.taskId,
        taskVersion: params.expectedTaskVersion,
        nodeId: params.nodeId,
        profileId: before.profile.profileId,
        expectedConfigurationRevisionId: params.expectedConfigurationRevisionId,
        occurredAtMs: decisionOccurredAtMs,
        features: evaluation.features,
        metadata: {
          actor: ACTIVATION_ACTOR,
          correlationId: params.activationId,
        },
      }).record;

      let rejectionReason = evaluation.rejectionReason;
      if (
        rejectionReason === null &&
        !routeTargetAvailable(routed.decision.resolvedTarget, before.catalog)
      ) {
        rejectionReason = "model_unavailable";
      }
      const workspace =
        rejectionReason === null
          ? await this.#dependencies.workspaceObserver.observe(before.project.workspace)
          : null;
      if (workspace?.status === "denied") rejectionReason = workspace.rejectionReason;

      const after = this.#capture(params);
      if (!sameCapture(before, after) || !this.#workerManager.isCatalogCurrent(before.catalog)) {
        throw new NodeExecutionAdmissionServiceError("conflict");
      }
      const occurredAtMs = requireTimestamp(this.#dependencies.now());
      assertTimestampNotBeforeState(occurredAtMs, after);
      if (
        occurredAtMs < decisionOccurredAtMs ||
        (workspace?.status === "verified" && occurredAtMs < workspace.snapshot.observedAtMs)
      ) {
        throw new NodeExecutionAdmissionServiceError("conflict");
      }
      const record = materializeAdmissionRecord(
        params,
        commandDigest,
        occurredAtMs,
        before,
        evaluation,
        routed.decision,
        workspace,
        rejectionReason,
      );
      const persisted = this.#activations.record(record, {
        actor: ACTIVATION_ACTOR,
        correlationId: params.decisionId,
      });
      return resultFromRecord(persisted.record, persisted.duplicate);
    } catch (error: unknown) {
      if (error instanceof NodeExecutionAdmissionServiceError) throw error;
      throw new NodeExecutionAdmissionServiceError(mapConflict(error) ? "conflict" : "unavailable");
    }
  }

  #capture(params: HarnessTaskExecutionActivateParams): CapturedState {
    const project = this.#projects.readProject(params.projectId);
    const ownership = this.#ownerships.readOwnership(params.taskId);
    const task = this.#tasks.readTask(params.taskId);
    const manifest = this.#manifests.readCurrentManifest(params.taskId, params.nodeId);
    const binding = this.#bindings.readBinding(params.projectId);
    const profile = this.#profiles.readProfile(binding.profileId);
    const catalog = this.#workerManager.catalog;
    const preview = task.activeGraph === null ? null : previewSerialTaskSchedule(task.activeGraph);
    if (
      project.projectVersion !== params.expectedProjectVersion ||
      ownership.projectId !== params.projectId ||
      ownership.ownershipVersion !== params.expectedOwnershipVersion ||
      task.taskVersion !== params.expectedTaskVersion ||
      task.activeRequirement.revisionId !== params.previousRequirementRevisionId ||
      task.confirmedPlan?.revisionId !== params.confirmedPlanRevisionId ||
      task.latestPlan?.revisionId !== params.confirmedPlanRevisionId ||
      task.latestPlan.status !== "confirmed" ||
      task.activeGraph?.revisionId !== params.graphRevisionId ||
      preview?.state !== "dependency_eligible" ||
      preview.nodeId !== params.nodeId ||
      manifest.status !== "confirmed" ||
      manifest.manifestId !== params.manifestId ||
      manifest.stateVersion !== params.expectedManifestStateVersion ||
      binding.bindingVersion !== params.expectedRoutingBindingVersion ||
      profile.profileVersion !== params.expectedProfileVersion ||
      profile.activeConfiguration.revisionId !== params.expectedConfigurationRevisionId ||
      catalog === null ||
      !this.#workerManager.isCatalogCurrent(catalog)
    ) {
      throw new NodeExecutionAdmissionServiceError("conflict");
    }
    return Object.freeze({ project, ownership, task, manifest, binding, profile, catalog });
  }

  #readExisting(taskId: string, activationId: string): NodeExecutionAdmissionRecord | null {
    try {
      return this.#activations.readAdmission(taskId, activationId);
    } catch (error: unknown) {
      if (error instanceof RouteActivationRepositoryError && error.code === "not_found")
        return null;
      throw error;
    }
  }

  #assertAvailable(): void {
    if (this.#stateStore.state !== "ready" || this.#workerManager.state !== "ready") {
      throw new NodeExecutionAdmissionServiceError("unavailable");
    }
  }
}

function materializeAdmissionRecord(
  params: HarnessTaskExecutionActivateParams,
  commandDigest: string,
  occurredAtMs: number,
  state: CapturedState,
  evaluation: NodeExecutionAdmissionEvaluation,
  routeDecision: RouteActivation["routeDecision"],
  workspace: MacosWorkspaceAdmissionObservation | null,
  rejectionReason: NodeExecutionAdmissionRecord["rejectionReason"],
): NodeExecutionAdmissionRecord {
  const activated =
    rejectionReason === null && evaluation.permission !== null && workspace?.status === "verified";
  const routeActivation: RouteActivation | null = activated
    ? Object.freeze({
        schemaVersion: 1,
        executionAuthorized: true,
        activationId: params.activationId,
        decisionId: params.decisionId,
        projectId: params.projectId,
        projectVersion: params.expectedProjectVersion,
        taskId: params.taskId,
        taskVersion: params.expectedTaskVersion,
        ownershipVersion: params.expectedOwnershipVersion,
        nodeId: params.nodeId,
        requirementRevisionId: params.previousRequirementRevisionId,
        planRevisionId: params.confirmedPlanRevisionId,
        graphRevisionId: params.graphRevisionId,
        manifestId: params.manifestId,
        manifestStateVersion: params.expectedManifestStateVersion,
        routingBindingVersion: params.expectedRoutingBindingVersion,
        profileId: state.profile.profileId,
        profileVersion: params.expectedProfileVersion,
        configurationRevisionId: params.expectedConfigurationRevisionId,
        catalog: Object.freeze({
          snapshotId: state.catalog.snapshotId,
          workerSessionId: state.catalog.workerSessionId,
          provider: state.catalog.provider,
          observedAtMs: state.catalog.observedAtMs,
        }),
        routeDecision,
        permission: evaluation.permission,
        workspace: workspace.snapshot,
        userConfirmedAtMs: occurredAtMs,
      })
    : null;
  return Object.freeze({
    schemaVersion: 1,
    activationId: params.activationId,
    decisionId: params.decisionId,
    commandDigest,
    projectId: params.projectId,
    taskId: params.taskId,
    nodeId: params.nodeId,
    manifestId: params.manifestId,
    occurredAtMs,
    status: routeActivation === null ? "denied" : "activated",
    rejectionReason: routeActivation === null ? (rejectionReason ?? "workspace_unavailable") : null,
    routeActivation,
  });
}

function resultFromRecord(
  record: NodeExecutionAdmissionRecord,
  duplicate: boolean,
): HarnessTaskExecutionActivateResult {
  const activation = record.routeActivation;
  const result = {
    schemaVersion: 1 as const,
    status:
      record.status === "activated"
        ? duplicate
          ? ("existing" as const)
          : ("activated" as const)
        : duplicate
          ? ("existing_denial" as const)
          : ("denied" as const),
    activationId: record.activationId,
    taskId: record.taskId,
    nodeId: record.nodeId,
    rejectionReason: record.rejectionReason,
    route:
      activation === null
        ? null
        : Object.freeze({
            tier: activation.routeDecision.resolvedTarget.tier,
            provider: activation.routeDecision.resolvedTarget.provider,
            model: activation.routeDecision.resolvedTarget.model,
            reasoningEffort: activation.routeDecision.resolvedTarget.reasoningEffort,
          }),
    permission:
      activation === null
        ? null
        : Object.freeze({
            workspaceMode: activation.permission.workspaceMode,
            commandExecution: activation.permission.commandExecution,
            networkAccess: false as const,
            allowedOperationKinds: activation.permission.allowedOperationKinds,
          }),
    evidence:
      activation === null
        ? null
        : Object.freeze({
            manifestId: activation.manifestId,
            catalogSnapshotId: activation.catalog.snapshotId,
            workspaceDigest: activation.workspace.workspaceDigest,
            gitHead: activation.workspace.gitHead,
          }),
  };
  const decoded = decodeResponseResult("task.execution.activate", result);
  if (!decoded.ok) throw new NodeExecutionAdmissionServiceError("unavailable");
  return decoded.value as HarnessTaskExecutionActivateResult;
}

function routeTargetAvailable(
  target: RouteActivation["routeDecision"]["resolvedTarget"],
  catalog: ModelCatalogSnapshot,
): boolean {
  if (target.provider !== catalog.provider) return false;
  const model = catalog.models.find(
    (candidate) => !candidate.hidden && candidate.model === target.model,
  );
  return (
    model !== undefined &&
    model.inputModalities.includes("text") &&
    model.supportedReasoningEfforts.includes(target.reasoningEffort)
  );
}

function sameCapture(left: CapturedState, right: CapturedState): boolean {
  return (
    left.project.projectVersion === right.project.projectVersion &&
    left.project.workspace.absolutePath === right.project.workspace.absolutePath &&
    left.ownership.ownershipVersion === right.ownership.ownershipVersion &&
    left.ownership.projectId === right.ownership.projectId &&
    left.task.taskVersion === right.task.taskVersion &&
    left.task.activeRequirement.revisionId === right.task.activeRequirement.revisionId &&
    left.task.confirmedPlan?.revisionId === right.task.confirmedPlan?.revisionId &&
    left.task.activeGraph?.revisionId === right.task.activeGraph?.revisionId &&
    left.manifest.manifestId === right.manifest.manifestId &&
    left.manifest.stateVersion === right.manifest.stateVersion &&
    left.binding.bindingVersion === right.binding.bindingVersion &&
    left.binding.profileId === right.binding.profileId &&
    left.profile.profileVersion === right.profile.profileVersion &&
    left.profile.activeConfiguration.revisionId === right.profile.activeConfiguration.revisionId &&
    left.catalog === right.catalog
  );
}

function assertTimestampNotBeforeState(timestamp: number, state: CapturedState): void {
  if (
    timestamp < state.project.updatedAtMs ||
    timestamp < state.ownership.updatedAtMs ||
    timestamp < state.task.updatedAtMs ||
    timestamp < state.manifest.updatedAtMs ||
    timestamp < state.binding.updatedAtMs ||
    timestamp < state.profile.updatedAtMs ||
    timestamp < state.catalog.observedAtMs
  ) {
    throw new NodeExecutionAdmissionServiceError("conflict");
  }
}

function digestJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireTimestamp(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new NodeExecutionAdmissionServiceError("unavailable");
  }
  return input;
}

function mapConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["conflict", "invalid_input", "not_found", "stale"].includes(String(error.code));
}
