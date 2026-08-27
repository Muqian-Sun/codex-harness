import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  TaskExecutionRunFinalResultSchema,
  decodeRequestParams,
  decodeResponseResult,
  type HarnessTaskExecutionGetParams,
  type HarnessTaskExecutionGetResult,
  type HarnessTaskExecutionInterruptParams,
  type HarnessTaskExecutionInterruptResult,
  type HarnessTaskExecutionStartParams,
  type HarnessTaskExecutionStartResult,
  type HarnessTaskExecutionTerminalReason,
  type JsonValue,
} from "@codex-harness/protocol";
import type { AppServerCompletedTurnOutput } from "@codex-harness/app-server-adapter";

import {
  ExecutionRunRepository,
  ExecutionRunRepositoryError,
  type ExecutionRunFinalResult,
  type ExecutionRunRecord,
} from "../domain/execution-run-repository.js";
import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import { NodeOperationManifestRepository } from "../domain/node-operation-manifest-repository.js";
import { ProjectRegistryRepository } from "../domain/project-registry-repository.js";
import { ProjectRoutingProfileBindingRepository } from "../domain/project-routing-profile-binding-repository.js";
import {
  RouteActivationRepository,
  RouteActivationRepositoryError,
  type RouteActivation,
} from "../domain/route-activation-repository.js";
import { previewSerialTaskSchedule } from "../domain/serial-task-scheduler.js";
import { TaskPlanRepository, type TaskPlanRecord } from "../domain/task-plan-store.js";
import { TaskProjectOwnershipRepository } from "../domain/task-project-ownership-repository.js";
import type { TaskNode } from "../domain/task-graph.js";
import type { ModelCatalogSnapshot } from "../domain/model-catalog.js";
import type { NodeOperationManifestRecord } from "../domain/node-operation-manifest-repository.js";
import type { ProjectRecord } from "../domain/project-registry-repository.js";
import type { ProjectRoutingProfileBindingRecord } from "../domain/project-routing-profile-binding-repository.js";
import type { ModelRoutingProfileRecord } from "../domain/model-routing-profile-repository.js";
import type { TaskProjectOwnershipRecord } from "../domain/task-project-ownership-repository.js";
import type { DaemonStateStore } from "./daemon-state-store.js";
import {
  MacosWorkspaceAdmissionObserver,
  type VerifiedMacosWorkspaceSnapshotV2,
} from "./macos-workspace-admission-observer.js";
import type { AppServerWorkerManager } from "./app-server-worker-manager.js";

const ACTOR = "daemon.node_execution_run";
const SHA256_EMPTY = createHash("sha256").update("").digest("hex");
const MAX_COMMAND_CHARACTERS = 8_192;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_TOTAL_PATH_CHARACTERS = 256 * 1024;

export type NodeExecutionRunServiceErrorCode = "conflict" | "unavailable";

export class NodeExecutionRunServiceError extends Error {
  readonly code: NodeExecutionRunServiceErrorCode;

  constructor(code: NodeExecutionRunServiceErrorCode) {
    super(`The node execution run service failed: ${code}.`);
    this.name = "NodeExecutionRunServiceError";
    this.code = code;
  }
}

type ServiceDependencies = Readonly<{
  now(): number;
  newId(): string;
  workspaceObserver: MacosWorkspaceAdmissionObserver;
}>;

const PRODUCTION_DEPENDENCIES: ServiceDependencies = Object.freeze({
  now: () => Date.now(),
  newId: () => randomUUID(),
  workspaceObserver: new MacosWorkspaceAdmissionObserver(),
});

type CapturedState = Readonly<{
  project: ProjectRecord;
  ownership: TaskProjectOwnershipRecord;
  task: TaskPlanRecord;
  node: TaskNode;
  manifest: NodeOperationManifestRecord;
  binding: ProjectRoutingProfileBindingRecord;
  profile: ModelRoutingProfileRecord;
  catalog: ModelCatalogSnapshot;
  activation: RouteActivation;
}>;

type ActiveController = {
  stopRequested: boolean;
  forbiddenItem: boolean;
  threadId: string | null;
  turnId: string | null;
};

export class NodeExecutionRunService {
  readonly #stateStore: DaemonStateStore;
  readonly #workerManager: AppServerWorkerManager;
  readonly #projects: ProjectRegistryRepository;
  readonly #ownerships: TaskProjectOwnershipRepository;
  readonly #tasks: TaskPlanRepository;
  readonly #manifests: NodeOperationManifestRepository;
  readonly #bindings: ProjectRoutingProfileBindingRepository;
  readonly #profiles: ModelRoutingProfileRepository;
  readonly #activations: RouteActivationRepository;
  readonly #runs: ExecutionRunRepository;
  readonly #dependencies: ServiceDependencies;
  readonly #active = new Map<string, ActiveController>();

  constructor(
    stateStore: DaemonStateStore,
    workerManager: AppServerWorkerManager,
    dependencies: Partial<ServiceDependencies> = {},
  ) {
    try {
      if (stateStore.state !== "ready" || workerManager.state !== "ready") failUnavailable();
      this.#stateStore = stateStore;
      this.#workerManager = workerManager;
      this.#projects = new ProjectRegistryRepository(stateStore.events);
      this.#ownerships = new TaskProjectOwnershipRepository(stateStore.events);
      this.#tasks = new TaskPlanRepository(stateStore.events);
      this.#manifests = new NodeOperationManifestRepository(stateStore.events);
      this.#bindings = new ProjectRoutingProfileBindingRepository(stateStore.events);
      this.#profiles = new ModelRoutingProfileRepository(stateStore.events);
      this.#activations = new RouteActivationRepository(stateStore.events);
      this.#runs = new ExecutionRunRepository(stateStore.events);
      this.#dependencies = Object.freeze({
        now: dependencies.now ?? PRODUCTION_DEPENDENCIES.now,
        newId: dependencies.newId ?? PRODUCTION_DEPENDENCIES.newId,
        workspaceObserver:
          dependencies.workspaceObserver ?? PRODUCTION_DEPENDENCIES.workspaceObserver,
      });
      this.#recoverActiveRun();
    } catch (error: unknown) {
      if (error instanceof NodeExecutionRunServiceError) throw error;
      throw new NodeExecutionRunServiceError("unavailable");
    }
  }

  async start(input: unknown): Promise<HarnessTaskExecutionStartResult> {
    const decoded = decodeRequestParams("task.execution.start", input);
    if (!decoded.ok) throw new NodeExecutionRunServiceError("conflict");
    const params = decoded.value as HarnessTaskExecutionStartParams;
    try {
      this.#assertAvailable();
      const existing = this.#readExisting(params.taskId, params.runId);
      if (existing !== null) {
        if (!sameStartCommand(existing, params)) failConflict();
        return startResult(existing, true);
      }
      if (this.#runs.readActive() !== null) failConflict();
      const before = this.#capture(params);
      const observed = await this.#dependencies.workspaceObserver.observe(before.project.workspace);
      if (
        observed.status !== "verified" ||
        observed.snapshot.schemaVersion !== 2 ||
        !sameWorkspace(observed.snapshot, before.activation.workspace)
      ) {
        failConflict();
      }
      const after = this.#capture(params);
      if (!sameCapture(before, after) || !this.#workerManager.isCatalogCurrent(before.catalog)) {
        failConflict();
      }
      const startedAtMs = timestamp(this.#dependencies.now());
      if (startedAtMs < maxStateTimestamp(after, observed.snapshot)) failConflict();
      const latest = this.#runs.readLatestForNode(params.taskId, params.nodeId);
      const route = routeSummary(after.activation);
      const permission = permissionSummary(after.activation);
      const record: ExecutionRunRecord = Object.freeze({
        schemaVersion: 1,
        runId: params.runId,
        taskId: params.taskId,
        nodeId: params.nodeId,
        activationId: params.activationId,
        graphRevisionId: params.expectedGraphRevisionId,
        manifestId: after.activation.manifestId,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1,
        runVersion: 1,
        taskVersionAtStart: params.expectedTaskVersion,
        status: "running",
        route,
        permission,
        workspaceBefore: observed.snapshot,
        workspaceAfter: null,
        threadId: null,
        turnId: null,
        commands: Object.freeze([]),
        files: Object.freeze([]),
        finalResult: null,
        terminalReason: null,
        startedAtMs,
        updatedAtMs: startedAtMs,
        completedAtMs: null,
      });
      const persisted = this.#runs.start({
        run: record,
        expectedTaskVersion: params.expectedTaskVersion,
        metadata: { actor: ACTOR, correlationId: params.activationId },
      });
      const controller: ActiveController = {
        stopRequested: false,
        forbiddenItem: false,
        threadId: null,
        turnId: null,
      };
      this.#active.set(params.runId, controller);
      void this.#execute(persisted.run, after.task, after.node, controller);
      return startResult(persisted.run, persisted.duplicate);
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  get(input: unknown): HarnessTaskExecutionGetResult {
    const decoded = decodeRequestParams("task.execution.get", input);
    if (!decoded.ok) throw new NodeExecutionRunServiceError("conflict");
    const params = decoded.value as HarnessTaskExecutionGetParams;
    try {
      this.#assertStateAvailable();
      return getResult(this.#runs.readRun(params.taskId, params.runId));
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  async interrupt(input: unknown): Promise<HarnessTaskExecutionInterruptResult> {
    const decoded = decodeRequestParams("task.execution.interrupt", input);
    if (!decoded.ok) throw new NodeExecutionRunServiceError("conflict");
    const params = decoded.value as HarnessTaskExecutionInterruptParams;
    try {
      this.#assertStateAvailable();
      const run = this.#runs.readRun(params.taskId, params.runId);
      if (isTerminal(run.status)) return interruptResult(run, "already_terminal");
      const interrupted = this.#runs.requestInterrupt({
        eventId: params.commandId,
        taskId: params.taskId,
        runId: params.runId,
        expectedRunVersion: params.expectedRunVersion,
        occurredAtMs: timestamp(this.#dependencies.now()),
        metadata: { actor: ACTOR, correlationId: params.runId },
      });
      const controller = this.#active.get(params.runId);
      if (controller !== undefined) {
        controller.stopRequested = true;
        if (controller.threadId !== null && controller.turnId !== null) {
          await this.#workerManager.interruptWorkspaceExecutionTurn(
            controller.threadId,
            controller.turnId,
          );
        }
      }
      return interruptResult(interrupted.run, interrupted.duplicate ? "existing" : "stopping");
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  async #execute(
    initial: ExecutionRunRecord,
    task: TaskPlanRecord,
    node: TaskNode,
    controller: ActiveController,
  ): Promise<void> {
    let terminalStatus: "completed" | "failed" | "interrupted";
    let output: JsonValue | null = null;
    try {
      const result = await this.#workerManager.runWorkspaceExecutionTurn(
        {
          cwd: initial.workspaceBefore.canonicalPath,
          modelProvider: initial.route.provider,
          model: initial.route.model,
          reasoningEffort: initial.route.reasoningEffort,
          prompt: buildExecutionPrompt(task, node, initial.permission.allowedOperationKinds),
          outputSchema: EXECUTION_OUTPUT_SCHEMA,
        },
        {
          onBound: (binding) => {
            const current = this.#runs.readRun(initial.taskId, initial.runId);
            const bound = this.#runs.bind({
              eventId: this.#newId(),
              taskId: initial.taskId,
              runId: initial.runId,
              expectedRunVersion: current.runVersion,
              threadId: binding.threadId,
              turnId: binding.turnId,
              occurredAtMs: this.#nowAtLeast(current.updatedAtMs),
              metadata: { actor: ACTOR, correlationId: initial.runId },
            }).run;
            controller.threadId = bound.threadId;
            controller.turnId = bound.turnId;
            if (controller.stopRequested && bound.threadId !== null && bound.turnId !== null) {
              void this.#workerManager
                .interruptWorkspaceExecutionTurn(bound.threadId, bound.turnId)
                .catch(() => undefined);
            }
          },
          onOutput: (signal) => this.#observeOutput(initial, controller, signal),
        },
      );
      terminalStatus = result.terminalStatus;
      output = result.output;
    } catch {
      terminalStatus = "failed";
    }

    try {
      const current = this.#runs.readRun(initial.taskId, initial.runId);
      if (isTerminal(current.status)) return;
      let workspaceAfter: VerifiedMacosWorkspaceSnapshotV2 | null = null;
      const observation = await this.#dependencies.workspaceObserver.observe(
        {
          platform: "macos",
          absolutePath: initial.workspaceBefore.canonicalPath,
          identityStatus: "unverified",
        },
        { requireClean: false },
      );
      if (observation.status === "verified" && observation.snapshot.schemaVersion === 2) {
        workspaceAfter = observation.snapshot;
      }
      const refreshed = this.#runs.readRun(initial.taskId, initial.runId);
      const verdict = verifyRun(
        refreshed,
        node,
        terminalStatus,
        output,
        workspaceAfter,
        controller,
      );
      const taskAtFinish = this.#tasks.readTask(initial.taskId);
      this.#runs.finish({
        eventId: this.#newId(),
        taskId: initial.taskId,
        runId: initial.runId,
        expectedRunVersion: refreshed.runVersion,
        expectedTaskVersion: taskAtFinish.taskVersion,
        status: verdict.status,
        terminalReason: verdict.reason,
        finalResult: verdict.finalResult,
        workspaceAfter,
        occurredAtMs: this.#nowAtLeast(
          Math.max(refreshed.updatedAtMs, workspaceAfter?.observedAtMs ?? 0),
        ),
        metadata: { actor: ACTOR, correlationId: initial.activationId },
      });
    } catch {
      this.#finishAfterCoordinatorFailure(initial, controller);
    } finally {
      this.#active.delete(initial.runId);
    }
  }

  #observeOutput(
    initial: ExecutionRunRecord,
    controller: ActiveController,
    signal: AppServerCompletedTurnOutput,
  ): void {
    if (signal.type === "agent_message") return;
    if (signal.type === "forbidden_item") {
      controller.forbiddenItem = true;
      return;
    }
    const current = this.#runs.readRun(initial.taskId, initial.runId);
    if (signal.type === "command_execution") {
      const cwd = workspaceRelativePath(initial.workspaceBefore.canonicalPath, signal.cwd, true);
      if (cwd === null || signal.command.length > MAX_COMMAND_CHARACTERS) failUnavailable();
      const output = signal.aggregatedOutput ?? "";
      this.#runs.appendEvidence({
        eventId: this.#newId(),
        taskId: initial.taskId,
        runId: initial.runId,
        expectedRunVersion: current.runVersion,
        evidence: {
          kind: "command",
          value: Object.freeze({
            sequence: current.commands.length + current.files.length + 1,
            sourceItemId: signal.itemId,
            command: signal.command,
            status: signal.status,
            exitCode: signal.exitCode,
            durationMs: signal.durationMs,
            outputBytes: Buffer.byteLength(output, "utf8"),
            outputDigest: sha256(output),
          }),
        },
        occurredAtMs: this.#nowAtLeast(current.updatedAtMs),
        metadata: { actor: ACTOR, correlationId: initial.runId },
      });
      return;
    }
    let run = current;
    for (let index = 0; index < signal.changes.length; index += 1) {
      const change = signal.changes[index]!;
      const path = workspaceRelativePath(initial.workspaceBefore.canonicalPath, change.path, false);
      if (
        path === null ||
        path.length > MAX_PATH_CHARACTERS ||
        run.files.length >= 128 ||
        totalCharacters([...run.files.map((item) => item.path), path]) > MAX_TOTAL_PATH_CHARACTERS
      )
        failUnavailable();
      run = this.#runs.appendEvidence({
        eventId: this.#newId(),
        taskId: initial.taskId,
        runId: initial.runId,
        expectedRunVersion: run.runVersion,
        evidence: {
          kind: "file",
          value: Object.freeze({
            sequence: run.commands.length + run.files.length + 1,
            sourceItemId: sha256(`${signal.itemId}:${index}`),
            path,
            changeKind: change.changeKind,
            status: signal.status,
            diffDigest: sha256(change.diff),
          }),
        },
        occurredAtMs: this.#nowAtLeast(run.updatedAtMs),
        metadata: { actor: ACTOR, correlationId: initial.runId },
      }).run;
    }
  }

  #finishAfterCoordinatorFailure(initial: ExecutionRunRecord, controller: ActiveController): void {
    try {
      const run = this.#runs.readRun(initial.taskId, initial.runId);
      if (isTerminal(run.status)) return;
      const task = this.#tasks.readTask(initial.taskId);
      this.#runs.finish({
        eventId: this.#newId(),
        taskId: initial.taskId,
        runId: initial.runId,
        expectedRunVersion: run.runVersion,
        expectedTaskVersion: task.taskVersion,
        status: controller.stopRequested ? "interrupted" : "failed",
        terminalReason: controller.stopRequested ? "user_interrupted" : "worker_unavailable",
        finalResult: null,
        workspaceAfter: null,
        occurredAtMs: this.#nowAtLeast(run.updatedAtMs),
        metadata: { actor: ACTOR, correlationId: initial.activationId },
      });
    } catch {
      // The daemon state store will fail closed if the terminal event cannot be committed.
    }
  }

  #capture(params: HarnessTaskExecutionStartParams): CapturedState {
    const admission = this.#activations.readAdmission(params.taskId, params.activationId);
    const latestAdmission = this.#activations.readLatestForNode(params.taskId, params.nodeId);
    const activation = admission.routeActivation;
    if (
      admission.status !== "activated" ||
      activation === null ||
      latestAdmission.activationId !== admission.activationId ||
      activation.workspace.schemaVersion !== 2 ||
      activation.permission.workspaceMode !== "workspace_write" ||
      !activation.permission.commandExecution ||
      !activation.permission.allowedOperationKinds.includes("run_workspace_command") ||
      !activation.permission.allowedOperationKinds.some(
        (kind) => kind === "modify_workspace" || kind === "public_api_change",
      )
    ) {
      failConflict();
    }
    const project = this.#projects.readProject(activation.projectId);
    const ownership = this.#ownerships.readOwnership(params.taskId);
    const task = this.#tasks.readTask(params.taskId);
    const manifest = this.#manifests.readCurrentManifest(params.taskId, params.nodeId);
    const binding = this.#bindings.readBinding(activation.projectId);
    const profile = this.#profiles.readProfile(binding.profileId);
    const catalog = this.#workerManager.catalog;
    const preview = task.activeGraph === null ? null : previewSerialTaskSchedule(task.activeGraph);
    const node = task.activeGraph?.nodes.find((candidate) => candidate.nodeId === params.nodeId);
    if (
      catalog === null ||
      !this.#workerManager.isCatalogCurrent(catalog) ||
      params.expectedTaskVersion !== task.taskVersion ||
      params.expectedGraphRevisionId !== task.activeGraph?.revisionId ||
      activation.taskId !== params.taskId ||
      activation.nodeId !== params.nodeId ||
      (activation.taskVersion !== task.taskVersion &&
        activation.taskVersion + 1 !== task.taskVersion) ||
      activation.graphRevisionId !== task.activeGraph?.revisionId ||
      activation.projectVersion !== project.projectVersion ||
      activation.ownershipVersion !== ownership.ownershipVersion ||
      ownership.projectId !== project.projectId ||
      activation.requirementRevisionId !== task.activeRequirement.revisionId ||
      activation.planRevisionId !== task.confirmedPlan?.revisionId ||
      task.latestPlan?.revisionId !== task.confirmedPlan?.revisionId ||
      activation.manifestId !== manifest.manifestId ||
      activation.manifestStateVersion !== manifest.stateVersion ||
      manifest.status !== "confirmed" ||
      activation.routingBindingVersion !== binding.bindingVersion ||
      activation.profileId !== profile.profileId ||
      activation.profileVersion !== profile.profileVersion ||
      activation.configurationRevisionId !== profile.activeConfiguration.revisionId ||
      activation.catalog.snapshotId !== catalog.snapshotId ||
      activation.catalog.workerSessionId !== catalog.workerSessionId ||
      activation.catalog.provider !== catalog.provider ||
      !routeTargetAvailable(activation, catalog) ||
      preview?.state !== "awaiting_claim" ||
      preview.nodeId !== params.nodeId ||
      node === undefined
    ) {
      failConflict();
    }
    return Object.freeze({
      project,
      ownership,
      task,
      node,
      manifest,
      binding,
      profile,
      catalog,
      activation,
    });
  }

  #recoverActiveRun(): void {
    const active = this.#runs.readActive();
    if (active === null) return;
    const task = this.#tasks.readTask(active.taskId);
    this.#runs.finish({
      eventId: this.#newId(),
      taskId: active.taskId,
      runId: active.runId,
      expectedRunVersion: active.runVersion,
      expectedTaskVersion: task.taskVersion,
      status: "interrupted",
      terminalReason: "daemon_restarted",
      finalResult: null,
      workspaceAfter: null,
      occurredAtMs: this.#nowAtLeast(active.updatedAtMs),
      metadata: { actor: ACTOR, correlationId: active.activationId },
    });
  }

  #readExisting(taskId: string, runId: string): ExecutionRunRecord | null {
    try {
      return this.#runs.readRun(taskId, runId);
    } catch (error: unknown) {
      if (error instanceof ExecutionRunRepositoryError && error.code === "not_found") return null;
      throw error;
    }
  }

  #newId(): string {
    const id = this.#dependencies.newId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      failUnavailable();
    return id;
  }

  #nowAtLeast(minimum: number): number {
    const now = timestamp(this.#dependencies.now());
    return Math.max(now, minimum);
  }

  #assertAvailable(): void {
    this.#assertStateAvailable();
    if (this.#workerManager.state !== "ready") failUnavailable();
  }

  #assertStateAvailable(): void {
    if (this.#stateStore.state !== "ready") failUnavailable();
  }
}

const EXECUTION_OUTPUT_SCHEMA: JsonValue = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "validationCommands", "changedFiles", "acceptanceCriteria"],
  properties: {
    outcome: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string", minLength: 1, maxLength: 65_536 },
    validationCommands: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: MAX_COMMAND_CHARACTERS },
    },
    changedFiles: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "changeKind"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: MAX_PATH_CHARACTERS },
          changeKind: { type: "string", enum: ["add", "delete", "update"] },
        },
      },
    },
    acceptanceCriteria: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "passed", "evidence"],
        properties: {
          criterion: { type: "string", minLength: 1, maxLength: 4096 },
          passed: { type: "boolean" },
          evidence: { type: "string", minLength: 1, maxLength: 8192 },
        },
      },
    },
  },
});

function buildExecutionPrompt(
  task: TaskPlanRecord,
  node: TaskNode,
  operationKinds: readonly string[],
): string {
  const dependencySummaries = node.dependsOnNodeIds.map((dependencyId) => ({
    nodeId: dependencyId,
    status: task.activeGraph?.nodes.find((candidate) => candidate.nodeId === dependencyId)?.status,
  }));
  return [
    "你正在执行 Codex Harness 已确认的单个本地代码节点。",
    "只允许在当前 cwd 内工作；禁止网络、凭据、外部写入、部署、迁移、权限升级、子代理和用户交互。",
    "必须执行必要的验证命令，并以唯一 final JSON 严格符合 outputSchema；不要把自然语言完成声明当成验证。",
    "final.validationCommands 必须逐字复制实际执行且用于验证的 commandExecution.command；final.changedFiles 必须使用仓库相对路径并与实际 fileChange 完全一致。",
    "final.acceptanceCriteria 必须按下方节点验收条件的原顺序逐字复制 criterion，并逐项给出 passed 与 evidence。",
    JSON.stringify({
      requirement: {
        objective: task.activeRequirement.objective,
        constraints: task.activeRequirement.constraints,
        acceptanceCriteria: task.activeRequirement.acceptanceCriteria,
      },
      node: {
        title: node.title,
        description: node.description,
        acceptanceCriteria: node.acceptanceCriteria,
      },
      dependencySummaries,
      allowedOperationKinds: operationKinds,
    }),
  ].join("\n\n");
}

type RunVerdict = Readonly<{
  status: "succeeded" | "failed" | "blocked" | "interrupted";
  reason: HarnessTaskExecutionTerminalReason;
  finalResult: ExecutionRunFinalResult | null;
}>;

function verifyRun(
  run: ExecutionRunRecord,
  node: TaskNode,
  terminalStatus: "completed" | "failed" | "interrupted" | null,
  rawOutput: JsonValue | null,
  workspaceAfter: VerifiedMacosWorkspaceSnapshotV2 | null,
  controller: ActiveController,
): RunVerdict {
  if (controller.stopRequested || terminalStatus === "interrupted") {
    return verdict("interrupted", "user_interrupted", null);
  }
  if (controller.forbiddenItem) return verdict("failed", "forbidden_tool", null);
  if (terminalStatus !== "completed") return verdict("failed", "turn_failed", null);
  if (
    run.commands.some((item) => item.status !== "completed" || item.exitCode !== 0) ||
    run.files.some((item) => item.status !== "completed")
  ) {
    return verdict("failed", "tool_failed", null);
  }
  const parsed = TaskExecutionRunFinalResultSchema.safeParse(rawOutput);
  if (!parsed.success) return verdict("blocked", "evidence_missing", null);
  const finalResult = parsed.data as ExecutionRunFinalResult;
  if (finalResult.outcome !== "completed" || workspaceAfter === null) {
    return verdict("blocked", "evidence_missing", finalResult);
  }
  if (
    workspaceAfter.canonicalPath !== run.workspaceBefore.canonicalPath ||
    workspaceAfter.deviceId !== run.workspaceBefore.deviceId ||
    workspaceAfter.inode !== run.workspaceBefore.inode ||
    workspaceAfter.gitHead !== run.workspaceBefore.gitHead
  ) {
    return verdict("blocked", "workspace_changed", finalResult);
  }
  if (
    finalResult.validationCommands.length < 1 ||
    finalResult.validationCommands.some(
      (command) =>
        !run.commands.some(
          (evidence) =>
            evidence.command === command &&
            evidence.status === "completed" &&
            evidence.exitCode === 0,
        ),
    ) ||
    finalResult.acceptanceCriteria.length !== node.acceptanceCriteria.length ||
    finalResult.acceptanceCriteria.some(
      (criterion, index) =>
        !criterion.passed || criterion.criterion !== node.acceptanceCriteria[index],
    )
  ) {
    return verdict("blocked", "evidence_mismatch", finalResult);
  }
  const declaredPaths = sortedUnique(finalResult.changedFiles.map((item) => item.path));
  const itemPaths = sortedUnique(run.files.map((item) => item.path));
  const observedPaths = sortedUnique(workspaceAfter.changedPaths);
  if (
    declaredPaths.length === 0 ||
    declaredPaths.length !== finalResult.changedFiles.length ||
    totalCharacters(declaredPaths) > MAX_TOTAL_PATH_CHARACTERS ||
    !sameStrings(declaredPaths, itemPaths) ||
    !sameStrings(declaredPaths, observedPaths) ||
    run.files.some(
      (evidence) =>
        finalResult.changedFiles.find((declared) => declared.path === evidence.path)?.changeKind !==
        evidence.changeKind,
    ) ||
    sameWorkspace(workspaceAfter, run.workspaceBefore)
  ) {
    return verdict("blocked", "evidence_mismatch", finalResult);
  }
  return verdict("succeeded", "completed", finalResult);
}

function verdict(
  status: RunVerdict["status"],
  reason: HarnessTaskExecutionTerminalReason,
  finalResult: ExecutionRunFinalResult | null,
): RunVerdict {
  return Object.freeze({ status, reason, finalResult });
}

function routeSummary(activation: RouteActivation): ExecutionRunRecord["route"] {
  const target = activation.routeDecision.resolvedTarget;
  return Object.freeze({
    tier: target.tier,
    provider: target.provider,
    model: target.model,
    reasoningEffort: target.reasoningEffort,
  });
}

function permissionSummary(activation: RouteActivation): ExecutionRunRecord["permission"] {
  return Object.freeze({
    workspaceMode: activation.permission.workspaceMode,
    commandExecution: activation.permission.commandExecution,
    networkAccess: false,
    allowedOperationKinds: activation.permission.allowedOperationKinds,
  });
}

function routeTargetAvailable(activation: RouteActivation, catalog: ModelCatalogSnapshot): boolean {
  const target = activation.routeDecision.resolvedTarget;
  const model = catalog.models.find(
    (candidate) => !candidate.hidden && candidate.model === target.model,
  );
  return (
    target.provider === catalog.provider &&
    model !== undefined &&
    model.inputModalities.includes("text") &&
    model.supportedReasoningEfforts.includes(target.reasoningEffort)
  );
}

function sameCapture(left: CapturedState, right: CapturedState): boolean {
  return (
    left.project.projectVersion === right.project.projectVersion &&
    left.ownership.ownershipVersion === right.ownership.ownershipVersion &&
    left.task.taskVersion === right.task.taskVersion &&
    left.task.activeRequirement.revisionId === right.task.activeRequirement.revisionId &&
    left.task.confirmedPlan?.revisionId === right.task.confirmedPlan?.revisionId &&
    left.task.activeGraph?.revisionId === right.task.activeGraph?.revisionId &&
    left.manifest.manifestId === right.manifest.manifestId &&
    left.manifest.stateVersion === right.manifest.stateVersion &&
    left.binding.bindingVersion === right.binding.bindingVersion &&
    left.profile.profileVersion === right.profile.profileVersion &&
    left.profile.activeConfiguration.revisionId === right.profile.activeConfiguration.revisionId &&
    left.catalog === right.catalog &&
    left.activation.activationId === right.activation.activationId
  );
}

function sameWorkspace(
  left: VerifiedMacosWorkspaceSnapshotV2,
  right: RouteActivation["workspace"],
): boolean {
  return (
    right.schemaVersion === 2 &&
    left.canonicalPath === right.canonicalPath &&
    left.deviceId === right.deviceId &&
    left.inode === right.inode &&
    left.gitHead === right.gitHead &&
    left.statusDigest === right.statusDigest &&
    left.contentDigest === right.contentDigest &&
    left.workspaceDigest === right.workspaceDigest &&
    sameStrings(left.changedPaths, right.changedPaths)
  );
}

function workspaceRelativePath(root: string, candidate: string, allowRoot: boolean): string | null {
  if (candidate.includes("\0")) return null;
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const value = relative(root, absolute);
  if (value === "") return allowRoot ? "." : null;
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return null;
  return value.split(sep).join("/");
}

function startResult(run: ExecutionRunRecord, duplicate: boolean): HarnessTaskExecutionStartResult {
  const candidate = {
    schemaVersion: 1 as const,
    status: duplicate ? ("existing" as const) : ("started" as const),
    runId: run.runId,
    taskId: run.taskId,
    nodeId: run.nodeId,
    runVersion: run.runVersion,
    runStatus: run.status,
  };
  const decoded = decodeResponseResult("task.execution.start", candidate);
  if (!decoded.ok) failUnavailable();
  return decoded.value as HarnessTaskExecutionStartResult;
}

function getResult(run: ExecutionRunRecord): HarnessTaskExecutionGetResult {
  const candidate = {
    schemaVersion: 1 as const,
    runId: run.runId,
    taskId: run.taskId,
    nodeId: run.nodeId,
    activationId: run.activationId,
    attemptNumber: run.attemptNumber,
    runVersion: run.runVersion,
    status: run.status,
    route: run.route,
    permission: run.permission,
    threadBound: run.threadId !== null,
    turnBound: run.turnId !== null,
    commands: run.commands.map((item) => ({
      sequence: item.sequence,
      command: item.command,
      status: item.status,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
      outputBytes: item.outputBytes,
      outputDigest: item.outputDigest,
    })),
    files: run.files.map((item) => ({
      sequence: item.sequence,
      path: item.path,
      changeKind: item.changeKind,
      status: item.status,
      diffDigest: item.diffDigest,
    })),
    finalResult: run.finalResult,
    terminalReason: run.terminalReason,
    startedAtMs: run.startedAtMs,
    completedAtMs: run.completedAtMs,
  };
  const decoded = decodeResponseResult("task.execution.get", candidate);
  if (!decoded.ok) failUnavailable();
  return decoded.value as HarnessTaskExecutionGetResult;
}

function interruptResult(
  run: ExecutionRunRecord,
  status: HarnessTaskExecutionInterruptResult["status"],
): HarnessTaskExecutionInterruptResult {
  const candidate = {
    schemaVersion: 1 as const,
    status,
    taskId: run.taskId,
    runId: run.runId,
    runVersion: run.runVersion,
  };
  const decoded = decodeResponseResult("task.execution.interrupt", candidate);
  if (!decoded.ok) failUnavailable();
  return decoded.value as HarnessTaskExecutionInterruptResult;
}

function sameStartCommand(
  run: ExecutionRunRecord,
  params: HarnessTaskExecutionStartParams,
): boolean {
  return (
    run.runId === params.runId &&
    run.taskId === params.taskId &&
    run.nodeId === params.nodeId &&
    run.activationId === params.activationId &&
    run.taskVersionAtStart === params.expectedTaskVersion &&
    run.graphRevisionId === params.expectedGraphRevisionId
  );
}
function maxStateTimestamp(
  state: CapturedState,
  workspace: VerifiedMacosWorkspaceSnapshotV2,
): number {
  return Math.max(
    state.project.updatedAtMs,
    state.ownership.updatedAtMs,
    state.task.updatedAtMs,
    state.manifest.updatedAtMs,
    state.binding.updatedAtMs,
    state.profile.updatedAtMs,
    state.catalog.observedAtMs,
    state.activation.userConfirmedAtMs,
    workspace.observedAtMs,
  );
}
function timestamp(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) failUnavailable();
  return input;
}
function sha256(input: string): string {
  return input.length === 0 ? SHA256_EMPTY : createHash("sha256").update(input).digest("hex");
}
function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function totalCharacters(values: readonly string[]): number {
  return values.reduce((total, value) => total + value.length, 0);
}
function isTerminal(status: ExecutionRunRecord["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "blocked" ||
    status === "interrupted"
  );
}
function failConflict(): never {
  throw new NodeExecutionRunServiceError("conflict");
}
function failUnavailable(): never {
  throw new NodeExecutionRunServiceError("unavailable");
}
function mapServiceError(error: unknown): NodeExecutionRunServiceError {
  if (error instanceof NodeExecutionRunServiceError) return error;
  if (
    error instanceof ExecutionRunRepositoryError ||
    error instanceof RouteActivationRepositoryError
  )
    return new NodeExecutionRunServiceError(
      error.code === "conflict" || error.code === "invalid_input" || error.code === "not_found"
        ? "conflict"
        : "unavailable",
    );
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["conflict", "invalid_input", "not_found", "stale"].includes(String(error.code))
  )
    return new NodeExecutionRunServiceError("conflict");
  return new NodeExecutionRunServiceError("unavailable");
}
