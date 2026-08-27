import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessTaskExecutionActivateParams } from "@codex-harness/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalogSnapshot } from "../domain/model-catalog.js";
import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import { NodeOperationManifestRepository } from "../domain/node-operation-manifest-repository.js";
import { ProjectRegistryRepository } from "../domain/project-registry-repository.js";
import { ProjectRoutingProfileBindingRepository } from "../domain/project-routing-profile-binding-repository.js";
import { TaskPlanRepository } from "../domain/task-plan-store.js";
import { TaskProjectOwnershipRepository } from "../domain/task-project-ownership-repository.js";
import type { AppServerWorkerManager } from "./app-server-worker-manager.js";
import { DaemonStateStore } from "./daemon-state-store.js";
import type { MacosWorkspaceAdmissionObservation } from "./macos-workspace-admission-observer.js";
import { NodeExecutionAdmissionService } from "./node-execution-admission-service.js";
import { NodeExecutionRunService } from "./node-execution-run-service.js";

const directories: string[] = [];
const stores: DaemonStateStore[] = [];
const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const PROJECT_ID = id(1);
const TASK_ID = id(2);
const REQUIREMENT_ID = id(3);
const PLAN_ID = id(6);
const GRAPH_ID = id(8);
const NODE_ID = id(9);
const MANIFEST_ID = id(10);
const PROFILE_ID = id(12);
const CONFIGURATION_ID = id(13);
const ACTIVATION_ID = id(19);
const RUN_ID = id(40);
const ROOT = "/Users/example/project";

afterEach(async () => {
  for (const store of stores.splice(0)) {
    if (store.state === "ready") store.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function cleanWorkspace(): Extract<
  MacosWorkspaceAdmissionObservation,
  { status: "verified" }
>["snapshot"] {
  const changedPaths = Object.freeze([] as string[]);
  const statusDigest = digest("");
  const contentDigest = digest("\0\0");
  return Object.freeze({
    schemaVersion: 2,
    policyVersion: "macos-workspace-admission-policy-v2",
    platform: "macos",
    canonicalPath: ROOT,
    deviceId: "1",
    inode: "2",
    gitHead: "a".repeat(40),
    statusDigest,
    contentDigest,
    changedPaths,
    workspaceDigest: digest(
      JSON.stringify({
        canonicalPath: ROOT,
        changedPaths,
        contentDigest,
        deviceId: "1",
        gitHead: "a".repeat(40),
        inode: "2",
        statusDigest,
      }),
    ),
    observedAtMs: 7,
  });
}

function dirtyWorkspace(
  path = "src/index.ts",
  inodeOverride?: string,
): Extract<MacosWorkspaceAdmissionObservation, { status: "verified" }>["snapshot"] {
  const changedPaths = Object.freeze([path]);
  const base = cleanWorkspace();
  const statusDigest = digest(` M ${path}\0`);
  const contentDigest = digest(`diff:${path}`);
  const inode = inodeOverride ?? base.inode;
  return Object.freeze({
    ...base,
    statusDigest,
    contentDigest,
    changedPaths,
    workspaceDigest: digest(
      JSON.stringify({
        canonicalPath: base.canonicalPath,
        changedPaths,
        contentDigest,
        deviceId: base.deviceId,
        gitHead: base.gitHead,
        inode,
        statusDigest,
      }),
    ),
    inode,
    observedAtMs: 20,
  });
}

type FakeManagerOptions = Readonly<{
  declaredPath?: string;
  holdExecution?: boolean;
  terminalStatus?: "completed" | "failed" | "interrupted";
  finalOutput?: unknown;
  commandStatus?: "completed" | "failed" | "declined";
  commandExitCode?: number | null;
  fileStatus?: "completed" | "failed" | "declined";
  forbiddenItem?: boolean;
  workerFailure?: boolean;
  beforeWorkspaceDenied?: boolean;
  afterWorkspaceDenied?: boolean;
  afterWorkspaceIdentityChanged?: boolean;
}>;

async function setup(options: FakeManagerOptions = {}): Promise<{
  store: DaemonStateStore;
  service: NodeExecutionRunService;
  manager: AppServerWorkerManager;
  releaseInterrupted: () => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-node-run-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const store = await DaemonStateStore.open({ databasePath: join(directory, "harness.db") });
  stores.push(store);
  const projects = new ProjectRegistryRepository(store.events);
  const profiles = new ModelRoutingProfileRepository(store.events);
  const bindings = new ProjectRoutingProfileBindingRepository(store.events);
  const ownerships = new TaskProjectOwnershipRepository(store.events);
  const tasks = new TaskPlanRepository(store.events);
  const manifests = new NodeOperationManifestRepository(store.events);
  projects.registerProject({
    eventId: id(21),
    projectId: PROJECT_ID,
    displayName: "Project",
    workspace: { platform: "macos", absolutePath: ROOT },
    occurredAtMs: 1,
  });
  profiles.setConfiguration({
    profileId: PROFILE_ID,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs: 1,
    configuration: {
      schemaVersion: 1,
      revisionId: CONFIGURATION_ID,
      revisionNumber: 1,
      tiers: {
        fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
        standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
      },
    },
  });
  bindings.bindProfile({
    eventId: id(14),
    projectId: PROJECT_ID,
    expectedBindingVersion: 0,
    previousProfileId: null,
    profileId: PROFILE_ID,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_ID,
    occurredAtMs: 2,
  });
  ownerships.createTaskInProject({
    task: {
      eventId: REQUIREMENT_ID,
      taskId: TASK_ID,
      title: "Task",
      occurredAtMs: 1,
      requirement: {
        revisionId: REQUIREMENT_ID,
        sourceText: "修改代码并运行测试",
        objective: "修改代码并运行测试",
        constraints: ["禁止网络"],
        acceptanceCriteria: ["测试通过"],
      },
    },
    ownershipEventId: id(5),
    projectId: PROJECT_ID,
    expectedProjectVersion: 1,
  });
  tasks.revisePlan({
    eventId: PLAN_ID,
    taskId: TASK_ID,
    occurredAtMs: 3,
    expectedTaskVersion: 1,
    previousPlanRevisionId: null,
    plan: {
      revisionId: PLAN_ID,
      status: "confirmed",
      basedOnRequirementRevisionId: REQUIREMENT_ID,
      steps: [
        { stepId: id(7), title: "修改", description: "修改代码", acceptanceCriteria: ["测试通过"] },
      ],
    },
  });
  tasks.commitTaskGraph({
    eventId: GRAPH_ID,
    taskId: TASK_ID,
    occurredAtMs: 4,
    expectedTaskVersion: 2,
    previousGraphRevisionId: null,
    graph: {
      revisionId: GRAPH_ID,
      basedOnPlanRevisionId: PLAN_ID,
      nodes: [
        {
          nodeId: NODE_ID,
          sourcePlanStepId: id(7),
          title: "修改",
          description: "修改代码",
          acceptanceCriteria: ["测试通过"],
          dependsOnNodeIds: [],
        },
      ],
    },
  });
  manifests.propose({
    manifestId: MANIFEST_ID,
    taskId: TASK_ID,
    nodeId: NODE_ID,
    expectedTaskVersion: 3,
    expectedGraphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 0,
    previousManifestId: null,
    occurredAtMs: 5,
    operations: [
      { operationId: id(30), kind: "modify_workspace" },
      { operationId: id(31), kind: "run_workspace_command" },
    ],
  });
  manifests.confirm({
    eventId: id(11),
    taskId: TASK_ID,
    nodeId: NODE_ID,
    manifestId: MANIFEST_ID,
    expectedTaskVersion: 3,
    expectedGraphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 1,
    occurredAtMs: 6,
  });

  const catalog: ModelCatalogSnapshot = Object.freeze({
    schemaVersion: 1,
    snapshotId: id(15),
    workerSessionId: id(16),
    provider: "openai",
    observedAtMs: 1,
    includeHidden: true,
    complete: true,
    models: Object.freeze([
      Object.freeze({
        id: "fast-id",
        model: "fast",
        hidden: false,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: Object.freeze(["low"]),
        inputModalities: Object.freeze(["text" as const]),
      }),
      Object.freeze({
        id: "standard-id",
        model: "standard",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: Object.freeze(["medium"]),
        inputModalities: Object.freeze(["text" as const]),
      }),
      Object.freeze({
        id: "deep-id",
        model: "deep",
        hidden: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: Object.freeze(["high"]),
        inputModalities: Object.freeze(["text" as const]),
      }),
    ]),
  });
  let resolveExecution!: () => void;
  const executionGate = new Promise<void>((resolve) => {
    resolveExecution = resolve;
  });
  let interrupted = false;
  const manager = {
    state: "ready",
    catalog,
    isCatalogCurrent: (candidate: unknown) => candidate === catalog,
    runWorkspaceExecutionTurn: async (
      _input: unknown,
      observer: { onBound(value: unknown): void; onOutput(value: unknown): void },
    ) => {
      if (options.workerFailure) throw new Error("private worker failure");
      observer.onBound({ threadId: "thread-1", turnId: "turn-1" });
      if (options.holdExecution) {
        await executionGate;
        return {
          threadId: "thread-1",
          turnId: "turn-1",
          terminalStatus: interrupted ? "interrupted" : "failed",
          output: null,
        };
      }
      if (options.forbiddenItem) {
        observer.onOutput({
          type: "forbidden_item",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "web-1",
          itemType: "webSearch",
        });
      }
      observer.onOutput({
        type: "command_execution",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "pnpm test",
        cwd: ROOT,
        status: options.commandStatus ?? "completed",
        exitCode: options.commandExitCode === undefined ? 0 : options.commandExitCode,
        durationMs: 10,
        aggregatedOutput: "TOP-SECRET-COMMAND-OUTPUT",
      });
      observer.onOutput({
        type: "file_change",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-1",
        status: options.fileStatus ?? "completed",
        changes: [{ path: "src/index.ts", changeKind: "update", movePath: null, diff: "diff" }],
      });
      return {
        threadId: "thread-1",
        turnId: "turn-1",
        terminalStatus: options.terminalStatus ?? "completed",
        output:
          "finalOutput" in options
            ? (options.finalOutput ?? null)
            : {
                outcome: "completed",
                summary: "完成",
                validationCommands: ["pnpm test"],
                changedFiles: [
                  { path: options.declaredPath ?? "src/index.ts", changeKind: "update" },
                ],
                acceptanceCriteria: [
                  { criterion: "测试通过", passed: true, evidence: "pnpm test" },
                ],
              },
      };
    },
    interruptWorkspaceExecutionTurn: async () => {
      interrupted = true;
      resolveExecution();
    },
  } as unknown as AppServerWorkerManager;
  const cleanObservation = Object.freeze({
    status: "verified" as const,
    snapshot: cleanWorkspace(),
  });
  const admission = new NodeExecutionAdmissionService(store, manager, {
    now: () => 10,
    workspaceObserver: { observe: vi.fn(async () => cleanObservation) },
  });
  const params: HarnessTaskExecutionActivateParams = {
    activationId: ACTIVATION_ID,
    decisionId: id(20),
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    nodeId: NODE_ID,
    manifestId: MANIFEST_ID,
    expectedProjectVersion: 1,
    expectedTaskVersion: 3,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: REQUIREMENT_ID,
    confirmedPlanRevisionId: PLAN_ID,
    graphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 2,
    expectedRoutingBindingVersion: 1,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_ID,
    userConfirmed: true,
  };
  await admission.activate(params);
  let observationCount = 0;
  let nextId = 100;
  const service = new NodeExecutionRunService(store, manager, {
    now: () => 20 + observationCount,
    newId: () => id(nextId++),
    workspaceObserver: {
      observe: vi.fn(async (_workspace, observeOptions) => {
        observationCount += 1;
        if (observeOptions?.requireClean === false && options.afterWorkspaceDenied) {
          return { status: "denied" as const, rejectionReason: "workspace_changed" as const };
        }
        if (observeOptions?.requireClean === false && options.afterWorkspaceIdentityChanged) {
          return { status: "verified" as const, snapshot: dirtyWorkspace("src/index.ts", "3") };
        }
        if (observeOptions?.requireClean !== false && options.beforeWorkspaceDenied) {
          return { status: "denied" as const, rejectionReason: "workspace_dirty" as const };
        }
        return observeOptions?.requireClean === false
          ? { status: "verified" as const, snapshot: dirtyWorkspace() }
          : cleanObservation;
      }),
    } as never,
  });
  return {
    store,
    service,
    manager,
    releaseInterrupted: () => {
      interrupted = true;
      resolveExecution();
    },
  };
}

describe("node execution Run service", () => {
  it("executes an activated code node and independently commits verified success", async () => {
    const { service } = await setup();
    await expect(
      service.start({
        runId: RUN_ID,
        taskId: TASK_ID,
        nodeId: NODE_ID,
        activationId: ACTIVATION_ID,
        expectedTaskVersion: 4,
        expectedGraphRevisionId: GRAPH_ID,
      }),
    ).resolves.toMatchObject({ status: "started", runStatus: "running" });
    await vi.waitFor(() => {
      expect(service.get({ taskId: TASK_ID, runId: RUN_ID })).toMatchObject({
        status: "succeeded",
        route: { tier: "standard", model: "standard" },
        permission: {
          workspaceMode: "workspace_write",
          commandExecution: true,
          networkAccess: false,
        },
        commands: [{ command: "pnpm test", exitCode: 0, outputBytes: 25 }],
        files: [{ path: "src/index.ts", changeKind: "update" }],
        terminalReason: "completed",
      });
    });
    const result = service.get({ taskId: TASK_ID, runId: RUN_ID });
    expect(JSON.stringify(result)).not.toContain(ROOT);
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET-COMMAND-OUTPUT");
    await expect(
      service.start({
        runId: RUN_ID,
        taskId: TASK_ID,
        nodeId: NODE_ID,
        activationId: ACTIVATION_ID,
        expectedTaskVersion: 4,
        expectedGraphRevisionId: GRAPH_ID,
      }),
    ).resolves.toMatchObject({ status: "existing", runStatus: "succeeded" });
    await expect(
      service.interrupt({
        commandId: id(42),
        taskId: TASK_ID,
        runId: RUN_ID,
        expectedRunVersion: result.runVersion,
      }),
    ).resolves.toMatchObject({ status: "already_terminal" });
    await expect(
      service.start({
        runId: RUN_ID,
        taskId: TASK_ID,
        nodeId: NODE_ID,
        activationId: id(43),
        expectedTaskVersion: 4,
        expectedGraphRevisionId: GRAPH_ID,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("blocks a completed turn when declared and observed file evidence diverge", async () => {
    const { service } = await setup({ declaredPath: "src/other.ts" });
    await service.start({
      runId: RUN_ID,
      taskId: TASK_ID,
      nodeId: NODE_ID,
      activationId: ACTIVATION_ID,
      expectedTaskVersion: 4,
      expectedGraphRevisionId: GRAPH_ID,
    });
    await vi.waitFor(() => {
      expect(service.get({ taskId: TASK_ID, runId: RUN_ID })).toMatchObject({
        status: "blocked",
        terminalReason: "evidence_mismatch",
      });
    });
  });

  it("persists stopping before forwarding interrupt and waits for the terminal turn", async () => {
    const { service } = await setup({ holdExecution: true });
    await service.start({
      runId: RUN_ID,
      taskId: TASK_ID,
      nodeId: NODE_ID,
      activationId: ACTIVATION_ID,
      expectedTaskVersion: 4,
      expectedGraphRevisionId: GRAPH_ID,
    });
    await vi.waitFor(() =>
      expect(service.get({ taskId: TASK_ID, runId: RUN_ID }).turnBound).toBe(true),
    );
    const before = service.get({ taskId: TASK_ID, runId: RUN_ID });
    await expect(
      service.interrupt({
        commandId: id(41),
        taskId: TASK_ID,
        runId: RUN_ID,
        expectedRunVersion: before.runVersion,
      }),
    ).resolves.toMatchObject({ status: "stopping" });
    await vi.waitFor(() => {
      expect(service.get({ taskId: TASK_ID, runId: RUN_ID })).toMatchObject({
        status: "interrupted",
        terminalReason: "user_interrupted",
      });
    });
  });

  it.each([
    [{ terminalStatus: "failed" as const }, "failed", "turn_failed"],
    [{ commandStatus: "failed" as const, commandExitCode: 1 }, "failed", "tool_failed"],
    [{ forbiddenItem: true }, "failed", "forbidden_tool"],
    [{ finalOutput: null }, "blocked", "evidence_missing"],
    [
      {
        finalOutput: {
          outcome: "blocked",
          summary: "缺少证据",
          validationCommands: ["pnpm test"],
          changedFiles: [{ path: "src/index.ts", changeKind: "update" }],
          acceptanceCriteria: [{ criterion: "测试通过", passed: false, evidence: "未通过" }],
        },
      },
      "blocked",
      "evidence_missing",
    ],
    [{ afterWorkspaceDenied: true }, "blocked", "evidence_missing"],
    [{ afterWorkspaceIdentityChanged: true }, "blocked", "workspace_changed"],
    [
      {
        finalOutput: {
          outcome: "completed",
          summary: "完成",
          validationCommands: [],
          changedFiles: [{ path: "src/index.ts", changeKind: "update" }],
          acceptanceCriteria: [{ criterion: "测试通过", passed: true, evidence: "pnpm test" }],
        },
      },
      "blocked",
      "evidence_mismatch",
    ],
    [{ workerFailure: true }, "failed", "turn_failed"],
  ] as const)(
    "maps execution evidence variant %# to %s/%s",
    async (options, status, terminalReason) => {
      const { service } = await setup(options);
      await service.start({
        runId: RUN_ID,
        taskId: TASK_ID,
        nodeId: NODE_ID,
        activationId: ACTIVATION_ID,
        expectedTaskVersion: 4,
        expectedGraphRevisionId: GRAPH_ID,
      });
      await vi.waitFor(() => {
        expect(service.get({ taskId: TASK_ID, runId: RUN_ID })).toMatchObject({
          status,
          terminalReason,
        });
      });
    },
  );

  it("fails closed before claiming a node when the workspace or request fence is stale", async () => {
    const { service } = await setup({ beforeWorkspaceDenied: true });
    await expect(
      service.start({
        runId: RUN_ID,
        taskId: TASK_ID,
        nodeId: NODE_ID,
        activationId: ACTIVATION_ID,
        expectedTaskVersion: 4,
        expectedGraphRevisionId: GRAPH_ID,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(() => service.get({ taskId: TASK_ID, runId: RUN_ID })).toThrow();
    await expect(service.start({ invalid: true })).rejects.toMatchObject({ code: "conflict" });
    expect(() => service.get({ invalid: true })).toThrow();
    await expect(service.interrupt({ invalid: true })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("conservatively interrupts a persisted active Run when a new coordinator starts", async () => {
    const { store, manager, service, releaseInterrupted } = await setup({ holdExecution: true });
    await service.start({
      runId: RUN_ID,
      taskId: TASK_ID,
      nodeId: NODE_ID,
      activationId: ACTIVATION_ID,
      expectedTaskVersion: 4,
      expectedGraphRevisionId: GRAPH_ID,
    });
    await vi.waitFor(() =>
      expect(service.get({ taskId: TASK_ID, runId: RUN_ID }).turnBound).toBe(true),
    );
    let nextId = 300;
    const recovered = new NodeExecutionRunService(store, manager, {
      now: () => 30,
      newId: () => id(nextId++),
      workspaceObserver: { observe: vi.fn() } as never,
    });
    expect(recovered.get({ taskId: TASK_ID, runId: RUN_ID })).toMatchObject({
      status: "interrupted",
      terminalReason: "daemon_restarted",
    });
    releaseInterrupted();
  });
});
