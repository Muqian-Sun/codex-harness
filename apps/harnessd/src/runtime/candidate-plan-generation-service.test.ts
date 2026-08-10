import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@codex-harness/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import type { ModelRoutingConfiguration } from "../domain/model-routing-config.js";
import { ProjectRegistryRepository } from "../domain/project-registry-repository.js";
import { ProjectRoutingProfileBindingRepository } from "../domain/project-routing-profile-binding-repository.js";
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
  CandidatePlanGenerationService,
  CandidatePlanGenerationServiceError,
} from "./candidate-plan-generation-service.js";
import { DaemonStateStore } from "./daemon-state-store.js";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "./desktop-default-routing-profile.js";
import { ProjectTaskService } from "./project-task-service.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000a01";
const PROJECT_EVENT_ID = "00000000-0000-4000-8000-000000000a02";
const PROFILE_REVISION_ID = "00000000-0000-4000-8000-000000000a03";
const BINDING_EVENT_ID = "00000000-0000-4000-8000-000000000a04";
const TASK_ID = "00000000-0000-4000-8000-000000000a05";
const TASK_COMMAND_ID = "00000000-0000-4000-8000-000000000a06";
const OWNERSHIP_COMMAND_ID = "00000000-0000-4000-8000-000000000a07";
const PLAN_COMMAND_ID = "00000000-0000-4000-8000-000000000a08";
const STEP_ID = "00000000-0000-4000-8000-000000000a09";
const WORKER_SESSION_ID = "00000000-0000-4000-8000-000000000a10";
const CATALOG_ID = "00000000-0000-4000-8000-000000000a11";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000a12";
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
    steps: [
      {
        title: "建立持久计划",
        description: "把当前 Requirement 转换为可审阅的候选步骤。",
        acceptanceCriteria: ["重启后仍能读取候选步骤。"],
      },
    ],
  };
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-candidate-plan-"));
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
): ModelRoutingConfiguration {
  return {
    schemaVersion: 1,
    revisionId,
    revisionNumber,
    tiers: {
      fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
      standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
      deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
    },
  };
}

function seed(store: DaemonStateStore): void {
  new ProjectRegistryRepository(store.events).registerProject({
    eventId: PROJECT_EVENT_ID,
    projectId: PROJECT_ID,
    displayName: "candidate-workspace",
    workspace: { platform: "macos", absolutePath: "/Users/example/candidate-workspace" },
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
  new ProjectTaskService(store, { now: () => 103 }).create({
    commandId: TASK_COMMAND_ID,
    ownershipCommandId: OWNERSHIP_COMMAND_ID,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    expectedProjectVersion: 1,
    expectedRoutingBindingVersion: 1,
    title: "生成候选计划",
    sourceText: "为当前需求生成持久、可审阅但不可执行的候选计划。",
  });
}

function params(commandId = PLAN_COMMAND_ID, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandId,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    expectedProjectVersion: 1,
    expectedTaskVersion: 1,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: TASK_COMMAND_ID,
    previousPlanRevisionId: null,
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

describe("CandidatePlanGenerationService", () => {
  it("uses the configured deep target and persists a restart-safe candidate Plan", async () => {
    const path = await databasePath();
    const store = await openStore(path);
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    const service = new CandidatePlanGenerationService(store, manager, {
      now: () => 210,
      newId: () => STEP_ID,
    });

    await expect(service.generate(params())).resolves.toEqual({
      schemaVersion: 1,
      status: "generated",
      taskId: TASK_ID,
    });
    expect(worker.analysisInputs).toHaveLength(1);
    expect(worker.analysisInputs[0]).toMatchObject({
      cwd: "/Users/example/candidate-workspace",
      modelProvider: "openai",
      model: "deep",
      reasoningEffort: "high",
      outputSchema: { type: "object", additionalProperties: false },
    });
    expect(worker.analysisInputs[0]?.prompt).toContain("不可信的任务数据");
    expect(
      new ProjectTaskService(store).detail({ projectId: PROJECT_ID, taskId: TASK_ID }),
    ).toMatchObject({
      taskVersion: 2,
      stage: "candidate_plan",
      latestPlanRevisionId: PLAN_COMMAND_ID,
      candidatePlan: {
        revisionId: PLAN_COMMAND_ID,
        revisionNumber: 1,
        basedOnRequirementRevisionId: TASK_COMMAND_ID,
        steps: [{ stepId: STEP_ID, title: "建立持久计划" }],
      },
    });
    expect(store.events.readByEventId(PLAN_COMMAND_ID)).toMatchObject({
      eventType: "task.plan_revised",
      metadata: {
        actor: "desktop.project_task.candidate_plan",
        correlationId: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    store.close();

    const reopened = await openStore(path);
    expect(
      new ProjectTaskService(reopened).detail({ projectId: PROJECT_ID, taskId: TASK_ID }),
    ).toMatchObject({ stage: "candidate_plan", candidatePlan: { revisionId: PLAN_COMMAND_ID } });
  });

  it("returns an existing command without invoking Codex again", async () => {
    const store = await openStore();
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    const service = new CandidatePlanGenerationService(store, manager, {
      now: () => 210,
      newId: () => STEP_ID,
    });

    await service.generate(params());
    await expect(service.generate(params())).resolves.toMatchObject({ status: "existing" });
    expect(worker.analysisInputs).toHaveLength(1);
    await expect(
      service.generate(params(PLAN_COMMAND_ID, { expectedProfileVersion: 2 })),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      service.generate(params(PLAN_COMMAND_ID, { expectedTaskVersion: 2 })),
    ).rejects.toMatchObject({ code: "conflict" });

    new ModelRoutingProfileRepository(store.events).setConfiguration({
      profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
      expectedProfileVersion: 1,
      previousConfigurationRevisionId: PROFILE_REVISION_ID,
      occurredAtMs: 211,
      configuration: configuration("00000000-0000-4000-8000-000000000a13", 2),
    });
    await expect(service.generate(params())).resolves.toMatchObject({ status: "existing" });
    expect(worker.analysisInputs).toHaveLength(1);
  });

  it("rejects stale fences before analysis and after a concurrent routing change", async () => {
    const store = await openStore();
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    const service = new CandidatePlanGenerationService(store, manager, {
      now: () => 220,
      newId: () => STEP_ID,
    });

    await expect(
      service.generate(params(PLAN_COMMAND_ID, { expectedTaskVersion: 2 })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(worker.analysisInputs).toHaveLength(0);

    worker.setAnalysis(() => {
      new ModelRoutingProfileRepository(store.events).setConfiguration({
        profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
        expectedProfileVersion: 1,
        previousConfigurationRevisionId: PROFILE_REVISION_ID,
        occurredAtMs: 211,
        configuration: configuration("00000000-0000-4000-8000-000000000a13", 2),
      });
      return generatedOutput();
    });
    await expect(service.generate(params())).rejects.toMatchObject({ code: "conflict" });
    expect(
      new ProjectTaskService(store).detail({ projectId: PROJECT_ID, taskId: TASK_ID }),
    ).toMatchObject({ taskVersion: 1, candidatePlan: null });
  });

  it("fails closed for invalid model output, worker failure, timestamps, and generated IDs", async () => {
    const store = await openStore();
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput({ steps: [] }));
    const manager = await startManager(worker);
    let now = 210;
    let stepId = STEP_ID;
    const service = new CandidatePlanGenerationService(store, manager, {
      now: () => now,
      newId: () => stepId,
    });

    for (const output of [
      { steps: [] },
      { steps: [{ title: " ", description: "x", acceptanceCriteria: [] }] },
      { steps: [{ title: "x", description: "x", acceptanceCriteria: "bad" }] },
      { steps: [{ title: "x", description: "x", acceptanceCriteria: [], extra: true }] },
      { steps: [{ title: "x".repeat(513), description: "x", acceptanceCriteria: [] }] },
      { steps: [{ title: "x", description: "x".repeat(8_193), acceptanceCriteria: [] }] },
      {
        steps: [{ title: "x", description: "x", acceptanceCriteria: ["x".repeat(4_097)] }],
      },
      {
        steps: Array.from({ length: 41 }, () => ({
          title: "x",
          description: "x",
          acceptanceCriteria: [],
        })),
      },
    ] satisfies JsonValue[]) {
      worker.setAnalysis(() => generatedOutput(output));
      await expect(service.generate(params())).rejects.toBeInstanceOf(
        CandidatePlanGenerationServiceError,
      );
    }

    worker.setAnalysis(async () => {
      throw new Error("private worker detail");
    });
    await expect(service.generate(params())).rejects.toMatchObject({ code: "unavailable" });

    worker.setAnalysis(() => generatedOutput());
    now = 99;
    await expect(service.generate(params())).rejects.toMatchObject({ code: "conflict" });
    now = 210;
    stepId = TASK_ID;
    await expect(service.generate(params())).rejects.toMatchObject({ code: "unavailable" });
    stepId = "bad";
    await expect(service.generate(params())).rejects.toMatchObject({ code: "unavailable" });
    expect(
      new ProjectTaskService(store).detail({ projectId: PROJECT_ID, taskId: TASK_ID }),
    ).toMatchObject({ taskVersion: 1, candidatePlan: null });
  });

  it("normalizes invalid construction and request boundaries to stable errors", async () => {
    const store = await openStore();
    seed(store);
    const worker = new AnalysisWorker(() => generatedOutput());
    const manager = await startManager(worker);
    expect(
      () =>
        new CandidatePlanGenerationService(store, manager, { now: null as never, newId: vi.fn() }),
    ).toThrow(CandidatePlanGenerationServiceError);
    const service = new CandidatePlanGenerationService(store, manager);
    await expect(service.generate({ ...params(), extra: true })).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
