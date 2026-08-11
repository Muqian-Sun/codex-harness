import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@codex-harness/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import type { ModelRoutingConfiguration } from "../domain/model-routing-config.js";
import { NodeOperationManifestRepository } from "../domain/node-operation-manifest-repository.js";
import { ProjectRegistryRepository } from "../domain/project-registry-repository.js";
import { ProjectRoutingProfileBindingRepository } from "../domain/project-routing-profile-binding-repository.js";
import { TaskPlanRepository } from "../domain/task-plan-store.js";
import type {
  AppServerReadOnlyAnalysisInput,
  AppServerReadOnlyAnalysisResult,
  AppServerWorkerCloseResult,
  AppServerWorkerConfig,
  AppServerWorkerState,
} from "./app-server-worker.js";
import {
  AppServerWorkerManager,
  type ManagedAppServerWorker,
} from "./app-server-worker-manager.js";
import {
  CandidateOperationManifestGenerationService,
  CandidateOperationManifestGenerationServiceError,
} from "./candidate-operation-manifest-generation-service.js";
import { DaemonStateStore } from "./daemon-state-store.js";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "./desktop-default-routing-profile.js";
import { ProjectTaskService } from "./project-task-service.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000b01";
const PROJECT_EVENT_ID = "00000000-0000-4000-8000-000000000b02";
const PROFILE_REVISION_ID = "00000000-0000-4000-8000-000000000b03";
const BINDING_EVENT_ID = "00000000-0000-4000-8000-000000000b04";
const TASK_ID = "00000000-0000-4000-8000-000000000b05";
const TASK_COMMAND_ID = "00000000-0000-4000-8000-000000000b06";
const OWNERSHIP_COMMAND_ID = "00000000-0000-4000-8000-000000000b07";
const CANDIDATE_PLAN_ID = "00000000-0000-4000-8000-000000000b08";
const CONFIRMED_PLAN_ID = "00000000-0000-4000-8000-000000000b09";
const STEP_ID = "00000000-0000-4000-8000-000000000b10";
const GRAPH_ID = "00000000-0000-4000-8000-000000000b11";
const NODE_ID = "00000000-0000-4000-8000-000000000b12";
const MANIFEST_ID = "00000000-0000-4000-8000-000000000b13";
const NEXT_MANIFEST_ID = "00000000-0000-4000-8000-000000000b14";
const OPERATION_ID_ONE = "00000000-0000-4000-8000-000000000b15";
const OPERATION_ID_TWO = "00000000-0000-4000-8000-000000000b16";
const WORKER_SESSION_ID = "00000000-0000-4000-8000-000000000b17";
const CATALOG_ID = "00000000-0000-4000-8000-000000000b18";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000b19";
const temporaryDirectories: string[] = [];
const stores: DaemonStateStore[] = [];
const managers: AppServerWorkerManager[] = [];

class AnalysisWorker implements ManagedAppServerWorker {
  state: AppServerWorkerState = "ready";
  readonly analysisInputs: AppServerReadOnlyAnalysisInput[] = [];
  readonly closed: Promise<AppServerWorkerCloseResult>;
  #resolveClosed!: (result: AppServerWorkerCloseResult) => void;

  constructor(
    private analysis: (
      input: AppServerReadOnlyAnalysisInput,
    ) => AppServerReadOnlyAnalysisResult | Promise<AppServerReadOnlyAnalysisResult>,
  ) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  setAnalysis(
    analysis: (
      input: AppServerReadOnlyAnalysisInput,
    ) => AppServerReadOnlyAnalysisResult | Promise<AppServerReadOnlyAnalysisResult>,
  ): void {
    this.analysis = analysis;
  }

  async listModels(): Promise<JsonValue> {
    return {
      data: [model("fast", "low"), model("standard", "medium"), model("deep", "high")],
      nextCursor: null,
    };
  }

  async readAccount(): Promise<JsonValue> {
    return { account: null, requiresOpenaiAuth: true };
  }

  async runReadOnlyAnalysisTurn(
    input: AppServerReadOnlyAnalysisInput,
  ): Promise<AppServerReadOnlyAnalysisResult> {
    this.analysisInputs.push(structuredClone(input));
    return await this.analysis(input);
  }

  async close(): Promise<AppServerWorkerCloseResult> {
    const result = closeResult();
    if (this.state !== "closed") {
      this.state = "closed";
      this.#resolveClosed(result);
    }
    return result;
  }
}

function model(name: string, effort: string): JsonValue {
  return {
    id: `id-${name}`,
    model: name,
    hidden: false,
    defaultReasoningEffort: effort,
    supportedReasoningEfforts: [{ reasoningEffort: effort }],
    inputModalities: ["text"],
  };
}

function closeResult(): AppServerWorkerCloseResult {
  return Object.freeze({
    reason: "requested",
    containment: "graceful",
    exitCode: 0,
    signal: null,
    stderrObserved: false,
  });
}

function generatedOutput(output: JsonValue = validOutput()): AppServerReadOnlyAnalysisResult {
  return Object.freeze({ threadId: "thread-1", turnId: "turn-1", output });
}

function validOutput(): JsonValue {
  return {
    operations: [{ kind: "inspect_workspace" }, { kind: "modify_workspace" }],
  };
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-operation-manifest-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openStore(path?: string): Promise<DaemonStateStore> {
  const store = await DaemonStateStore.open({ databasePath: path ?? (await databasePath()) });
  stores.push(store);
  return store;
}

async function startManager(worker: ManagedAppServerWorker): Promise<AppServerWorkerManager> {
  const ids = [WORKER_SESSION_ID, CATALOG_ID, ACCOUNT_ID];
  const times = [200, 201];
  const manager = await AppServerWorkerManager.start(
    { provider: "openai", worker: {} as AppServerWorkerConfig },
    {
      startWorker: async () => worker,
      newId: () => ids.shift() ?? "missing-id",
      now: () => times.shift() ?? -1,
    },
  );
  managers.push(manager);
  return manager;
}

function configuration(
  revisionId = PROFILE_REVISION_ID,
  revisionNumber = 1,
  deepModel = "deep",
): ModelRoutingConfiguration {
  return {
    schemaVersion: 1,
    revisionId,
    revisionNumber,
    tiers: {
      fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
      standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
      deep: { provider: "openai", model: deepModel, reasoningEffort: "high" },
    },
  };
}

function seed(store: DaemonStateStore): void {
  new ProjectRegistryRepository(store.events).registerProject({
    eventId: PROJECT_EVENT_ID,
    projectId: PROJECT_ID,
    displayName: "manifest-workspace",
    workspace: { platform: "macos", absolutePath: "/Users/example/manifest-workspace" },
    occurredAtMs: 100,
  });
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
  const tasks = new ProjectTaskService(store, { now: () => 103, newId: () => NODE_ID });
  tasks.create({
    commandId: TASK_COMMAND_ID,
    ownershipCommandId: OWNERSHIP_COMMAND_ID,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    expectedProjectVersion: 1,
    expectedRoutingBindingVersion: 1,
    title: "生成节点操作清单",
    sourceText: "为当前节点识别完整操作边界，但不执行。",
  });
  new TaskPlanRepository(store.events).revisePlan({
    eventId: CANDIDATE_PLAN_ID,
    taskId: TASK_ID,
    occurredAtMs: 104,
    expectedTaskVersion: 1,
    previousPlanRevisionId: null,
    plan: {
      revisionId: CANDIDATE_PLAN_ID,
      status: "candidate",
      basedOnRequirementRevisionId: TASK_COMMAND_ID,
      steps: [
        {
          stepId: STEP_ID,
          title: "实现节点功能",
          description: "检查工作区并修改代码。",
          acceptanceCriteria: ["验证修改后的行为。"],
        },
      ],
    },
  });
  new ProjectTaskService(store, { now: () => 105 }).confirmCandidatePlan({
    commandId: CONFIRMED_PLAN_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    expectedTaskVersion: 2,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: TASK_COMMAND_ID,
    candidatePlanRevisionId: CANDIDATE_PLAN_ID,
  });
  new ProjectTaskService(store, { now: () => 106, newId: () => NODE_ID }).materializeGraph({
    commandId: GRAPH_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    expectedTaskVersion: 3,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: TASK_COMMAND_ID,
    confirmedPlanRevisionId: CONFIRMED_PLAN_ID,
    previousGraphRevisionId: null,
  });
}

function params(commandId = MANIFEST_ID, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandId,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    nodeId: NODE_ID,
    expectedProjectVersion: 1,
    expectedTaskVersion: 4,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: TASK_COMMAND_ID,
    confirmedPlanRevisionId: CONFIRMED_PLAN_ID,
    graphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 0,
    previousManifestId: null,
    expectedRoutingBindingVersion: 1,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: PROFILE_REVISION_ID,
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) {
    await manager.close();
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("CandidateOperationManifestGenerationService", () => {
  it("uses the configured deep target and persists a restart-safe candidate manifest", async () => {
    const path = await databasePath();
    const store = await openStore(path);
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    const operationIds = [OPERATION_ID_ONE, OPERATION_ID_TWO];
    const service = new CandidateOperationManifestGenerationService(store, manager, {
      now: () => 210,
      newId: () => operationIds.shift() ?? "missing-id",
    });

    await expect(service.generate(params())).resolves.toEqual({
      schemaVersion: 1,
      status: "generated",
      taskId: TASK_ID,
      nodeId: NODE_ID,
    });
    expect(worker.analysisInputs).toHaveLength(1);
    expect(worker.analysisInputs[0]).toMatchObject({
      cwd: "/Users/example/manifest-workspace",
      modelProvider: "openai",
      model: "deep",
      reasoningEffort: "high",
      outputSchema: { type: "object", additionalProperties: false },
    });
    expect(worker.analysisInputs[0]?.prompt).toContain("不可信的任务数据");
    expect(
      new ProjectTaskService(store).detail({ projectId: PROJECT_ID, taskId: TASK_ID }),
    ).toMatchObject({
      taskVersion: 4,
      stage: "active_graph",
      activeGraph: {
        operationManifest: {
          manifestId: MANIFEST_ID,
          nodeId: NODE_ID,
          stateVersion: 1,
          status: "candidate",
          operations: [
            { operationId: OPERATION_ID_ONE, kind: "inspect_workspace" },
            { operationId: OPERATION_ID_TWO, kind: "modify_workspace" },
          ],
        },
      },
    });
    store.close();

    const reopened = await openStore(path);
    expect(
      new ProjectTaskService(reopened).detail({ projectId: PROJECT_ID, taskId: TASK_ID }),
    ).toMatchObject({ activeGraph: { operationManifest: { manifestId: MANIFEST_ID } } });
  });

  it("returns exact retries without a second model call and permits fenced regeneration", async () => {
    const store = await openStore();
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    const operationIds = [
      OPERATION_ID_ONE,
      OPERATION_ID_TWO,
      "00000000-0000-4000-8000-000000000b20",
      "00000000-0000-4000-8000-000000000b21",
    ];
    const service = new CandidateOperationManifestGenerationService(store, manager, {
      now: () => 210,
      newId: () => operationIds.shift() ?? "missing-id",
    });

    await service.generate(params());
    await expect(service.generate(params())).resolves.toMatchObject({ status: "existing" });
    expect(worker.analysisInputs).toHaveLength(1);
    await expect(
      service.generate(params(MANIFEST_ID, { expectedTaskVersion: 5 })),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      service.generate(
        params(NEXT_MANIFEST_ID, {
          expectedManifestStateVersion: 1,
          previousManifestId: MANIFEST_ID,
        }),
      ),
    ).resolves.toMatchObject({ status: "generated" });
    expect(worker.analysisInputs).toHaveLength(2);
    expect(
      new NodeOperationManifestRepository(store.events).readCurrentManifest(TASK_ID, NODE_ID),
    ).toMatchObject({ manifestId: NEXT_MANIFEST_ID, stateVersion: 2, status: "candidate" });
  });

  it("rejects stale fences before analysis and after a concurrent manifest change", async () => {
    const store = await openStore();
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    const service = new CandidateOperationManifestGenerationService(store, manager, {
      now: () => 220,
      newId: () => OPERATION_ID_ONE,
    });

    await expect(
      service.generate(params(MANIFEST_ID, { graphRevisionId: STEP_ID })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(worker.analysisInputs).toHaveLength(0);

    worker.setAnalysis(() => {
      new NodeOperationManifestRepository(store.events).propose({
        manifestId: NEXT_MANIFEST_ID,
        taskId: TASK_ID,
        nodeId: NODE_ID,
        expectedTaskVersion: 4,
        expectedGraphRevisionId: GRAPH_ID,
        expectedManifestStateVersion: 0,
        previousManifestId: null,
        occurredAtMs: 211,
        operations: [{ operationId: OPERATION_ID_TWO, kind: "answer" }],
      });
      return generatedOutput();
    });
    await expect(service.generate(params())).rejects.toMatchObject({ code: "conflict" });
    expect(
      new NodeOperationManifestRepository(store.events).readCurrentManifest(TASK_ID, NODE_ID),
    ).toMatchObject({ manifestId: NEXT_MANIFEST_ID });
  });

  it("fails closed for malformed output, worker failure, time, and generated IDs", async () => {
    const store = await openStore();
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    let now = 210;
    let generatedId = OPERATION_ID_ONE;
    const service = new CandidateOperationManifestGenerationService(store, manager, {
      now: () => now,
      newId: () => generatedId,
    });

    for (const output of [
      { operations: [] },
      { operations: [{ kind: "unknown" }] },
      { operations: [{ kind: "answer", extra: true }] },
      { operations: [{ kind: "answer" }, { kind: "answer" }] },
      { operations: "bad" },
      { operations: Array.from({ length: 17 }, () => ({ kind: "answer" })) },
    ] satisfies JsonValue[]) {
      worker.setAnalysis(() => generatedOutput(output));
      await expect(service.generate(params())).rejects.toBeInstanceOf(
        CandidateOperationManifestGenerationServiceError,
      );
    }
    worker.setAnalysis(async () => {
      throw new Error("private worker detail");
    });
    await expect(service.generate(params())).rejects.toMatchObject({ code: "unavailable" });

    worker.setAnalysis(() => generatedOutput({ operations: [{ kind: "answer" }] }));
    now = 99;
    await expect(service.generate(params())).rejects.toMatchObject({ code: "conflict" });
    now = 210;
    generatedId = TASK_ID;
    await expect(service.generate(params())).rejects.toMatchObject({ code: "unavailable" });
    generatedId = "bad";
    await expect(service.generate(params())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("normalizes invalid construction, requests, and unavailable deep targets", async () => {
    const store = await openStore();
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    expect(
      () =>
        new CandidateOperationManifestGenerationService(store, manager, {
          now: null as never,
          newId: vi.fn(),
        }),
    ).toThrow(CandidateOperationManifestGenerationServiceError);
    const service = new CandidateOperationManifestGenerationService(store, manager);
    await expect(service.generate({ ...params(), extra: true })).rejects.toMatchObject({
      code: "conflict",
    });

    new ModelRoutingProfileRepository(store.events).setConfiguration({
      profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
      expectedProfileVersion: 1,
      previousConfigurationRevisionId: PROFILE_REVISION_ID,
      occurredAtMs: 211,
      configuration: configuration("00000000-0000-4000-8000-000000000b22", 2, "missing"),
    });
    await expect(
      service.generate(
        params(MANIFEST_ID, {
          expectedProfileVersion: 2,
          expectedConfigurationRevisionId: "00000000-0000-4000-8000-000000000b22",
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
