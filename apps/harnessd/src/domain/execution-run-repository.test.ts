import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore, type ProjectionDefinition } from "../persistence/event-store.js";
import {
  EXECUTION_RUN_PROJECTION,
  ExecutionRunRepository,
  ExecutionRunRepositoryError,
  type ExecutionRunRecord,
} from "./execution-run-repository.js";
import { TASK_PLAN_PROJECTION, TaskPlanRepository } from "./task-plan-store.js";

const directories: string[] = [];
const stores: HarnessEventStore[] = [];
const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

async function context(): Promise<{
  events: HarnessEventStore;
  tasks: TaskPlanRepository;
  runs: ExecutionRunRepository;
}> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-execution-run-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const events = await HarnessEventStore.open({
    path: join(directory, "harness.db"),
    projections: [TASK_PLAN_PROJECTION, EXECUTION_RUN_PROJECTION],
  });
  stores.push(events);
  const tasks = new TaskPlanRepository(events);
  tasks.createTask({
    eventId: id(2),
    taskId: id(1),
    title: "执行节点",
    occurredAtMs: 1,
    requirement: {
      revisionId: id(2),
      sourceText: "修改代码并验证",
      objective: "修改代码并验证",
      constraints: [],
      acceptanceCriteria: ["测试通过"],
    },
  });
  tasks.revisePlan({
    eventId: id(3),
    taskId: id(1),
    occurredAtMs: 2,
    expectedTaskVersion: 1,
    previousPlanRevisionId: null,
    plan: {
      revisionId: id(3),
      status: "confirmed",
      basedOnRequirementRevisionId: id(2),
      steps: [
        { stepId: id(4), title: "修改", description: "修改代码", acceptanceCriteria: ["测试通过"] },
      ],
    },
  });
  tasks.commitTaskGraph({
    eventId: id(5),
    taskId: id(1),
    occurredAtMs: 3,
    expectedTaskVersion: 2,
    previousGraphRevisionId: null,
    graph: {
      revisionId: id(5),
      basedOnPlanRevisionId: id(3),
      nodes: [
        {
          nodeId: id(6),
          sourcePlanStepId: id(4),
          title: "修改",
          description: "修改代码",
          acceptanceCriteria: ["测试通过"],
          dependsOnNodeIds: [],
        },
      ],
    },
  });
  events.append({
    eventId: id(9),
    streamType: "execution.node_admission",
    streamId: id(1),
    eventType: "execution.node_admission_decided",
    eventVersion: 1,
    occurredAtMs: 4,
    payload: {
      schemaVersion: 1,
      activationId: id(9),
      decisionId: id(15),
      commandDigest: "a".repeat(64),
      projectId: id(16),
      taskId: id(1),
      nodeId: id(6),
      manifestId: id(8),
      operationKinds: ["modify_workspace", "run_workspace_command"],
      occurredAtMs: 4,
      status: "activated",
      rejectionReason: null,
      routeActivation: {
        schemaVersion: 1,
        executionAuthorized: true,
        activationId: id(9),
        decisionId: id(15),
        projectId: id(16),
        projectVersion: 1,
        taskId: id(1),
        taskVersion: 3,
        ownershipVersion: 1,
        nodeId: id(6),
        requirementRevisionId: id(2),
        planRevisionId: id(3),
        graphRevisionId: id(5),
        manifestId: id(8),
        manifestStateVersion: 2,
        manifestPlanningFence: {},
        routingBindingVersion: 1,
        profileId: id(17),
        profileVersion: 1,
        configurationRevisionId: id(18),
        catalog: {},
        routeDecision: {},
        permission: {},
        workspace: {},
        userConfirmedAtMs: 4,
      },
    },
  });
  return { events, tasks, runs: new ExecutionRunRepository(events) };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function workspace(changedPaths: readonly string[] = []): ExecutionRunRecord["workspaceBefore"] {
  const canonicalPath = "/Users/example/project";
  const normalizedPaths = Object.freeze([...changedPaths]);
  const contentDigest = createHash("sha256")
    .update(changedPaths.length === 0 ? "\0\0" : `content:${changedPaths.join(",")}`)
    .digest("hex");
  const deviceId = "1";
  const gitHead = "a".repeat(40);
  const inode = "2";
  const statusDigest = createHash("sha256")
    .update(changedPaths.length === 0 ? "" : `status:${changedPaths.join(",")}`)
    .digest("hex");
  return Object.freeze({
    schemaVersion: 2,
    policyVersion: "macos-workspace-admission-policy-v2",
    platform: "macos",
    canonicalPath,
    deviceId,
    inode,
    gitHead,
    statusDigest,
    contentDigest,
    changedPaths: normalizedPaths,
    workspaceDigest: createHash("sha256")
      .update(
        JSON.stringify({
          canonicalPath,
          changedPaths: normalizedPaths,
          contentDigest,
          deviceId,
          gitHead,
          inode,
          statusDigest,
        }),
      )
      .digest("hex"),
    observedAtMs: 3,
  });
}

function run(): ExecutionRunRecord {
  return Object.freeze({
    schemaVersion: 1,
    runId: id(10),
    taskId: id(1),
    nodeId: id(6),
    activationId: id(7),
    graphRevisionId: id(5),
    manifestId: id(8),
    attemptNumber: 1,
    runVersion: 1,
    taskVersionAtStart: 4,
    status: "running",
    route: Object.freeze({
      tier: "standard",
      provider: "openai",
      model: "codex-medium",
      reasoningEffort: "medium",
    }),
    permission: Object.freeze({
      workspaceMode: "workspace_write",
      commandExecution: true,
      networkAccess: false,
      allowedOperationKinds: [
        "modify_workspace",
        "run_workspace_command",
      ] as ExecutionRunRecord["permission"]["allowedOperationKinds"],
    }),
    workspaceBefore: workspace(),
    workspaceAfter: null,
    threadId: null,
    turnId: null,
    commands: Object.freeze([]),
    files: Object.freeze([]),
    finalResult: null,
    terminalReason: null,
    startedAtMs: 5,
    updatedAtMs: 5,
    completedAtMs: null,
  });
}

describe("execution Run repository", () => {
  it("advances the node latest projection only from a terminal prior attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-harness-execution-attempt-"));
    directories.push(directory);
    await chmod(directory, 0o700);
    const taskProbe: ProjectionDefinition = {
      name: "task.current_plan",
      version: 1,
      selectKeys: () => [],
      reduce: () => ({ type: "keep" }),
    };
    const events = await HarnessEventStore.open({
      path: join(directory, "harness.db"),
      projections: [taskProbe, EXECUTION_RUN_PROJECTION],
    });
    stores.push(events);
    const runs = new ExecutionRunRepository(events);
    const first = run();
    runs.start({ run: first, expectedTaskVersion: first.taskVersionAtStart });
    const finished = runs.finish({
      eventId: id(30),
      taskId: first.taskId,
      runId: first.runId,
      expectedRunVersion: 1,
      expectedTaskVersion: first.taskVersionAtStart + 1,
      status: "interrupted",
      terminalReason: "daemon_restarted",
      finalResult: null,
      workspaceAfter: null,
      occurredAtMs: 6,
    }).run;
    const second = Object.freeze({
      ...first,
      runId: id(31),
      activationId: id(32),
      attemptNumber: 2,
      taskVersionAtStart: 6,
      startedAtMs: 7,
      updatedAtMs: 7,
    });
    runs.start({ run: second, expectedTaskVersion: second.taskVersionAtStart });

    expect(finished.status).toBe("interrupted");
    expect(runs.readLatestForNode(first.taskId, first.nodeId)).toMatchObject({
      runId: second.runId,
      attemptNumber: 2,
      status: "running",
    });
    expect(runs.readActive()?.runId).toBe(second.runId);
  });

  it("requires its projection and rejects malformed or stale transition payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-harness-execution-run-missing-"));
    directories.push(directory);
    await chmod(directory, 0o700);
    const incomplete = await HarnessEventStore.open({
      path: join(directory, "harness.db"),
      projections: [TASK_PLAN_PROJECTION],
    });
    stores.push(incomplete);
    expect(() => new ExecutionRunRepository(incomplete)).toThrow(ExecutionRunRepositoryError);

    const { runs } = await context();
    expect(() => runs.start({ run: run(), expectedTaskVersion: 3 })).toThrow(
      ExecutionRunRepositoryError,
    );
    runs.start({ run: run(), expectedTaskVersion: 4 });
    expect(() =>
      runs.bind({
        eventId: id(20),
        taskId: id(1),
        runId: id(10),
        expectedRunVersion: 2,
        threadId: "thread-1",
        turnId: "turn-1",
        occurredAtMs: 6,
      }),
    ).toThrow(ExecutionRunRepositoryError);
    const bound = runs.bind({
      eventId: id(21),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      occurredAtMs: 6,
    }).run;
    const invalidCommand = {
      eventId: id(22),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: bound.runVersion,
      evidence: {
        kind: "command" as const,
        value: {
          sequence: 2,
          sourceItemId: "command-invalid",
          command: "pnpm test",
          status: "completed" as const,
          exitCode: 0,
          durationMs: 1,
          outputBytes: 0,
          outputDigest: "e".repeat(64),
        },
      },
      occurredAtMs: 7,
    };
    expect(() => runs.appendEvidence(invalidCommand)).toThrow(ExecutionRunRepositoryError);
    expect(() =>
      runs.appendEvidence({
        ...invalidCommand,
        eventId: id(23),
        evidence: {
          kind: "file" as const,
          value: {
            sequence: 2,
            sourceItemId: "file-invalid",
            path: "src/index.ts",
            changeKind: "update" as const,
            status: "completed" as const,
            diffDigest: "f".repeat(64),
          },
        },
      }),
    ).toThrow(ExecutionRunRepositoryError);
    expect(() =>
      runs.appendEvidence({
        ...invalidCommand,
        eventId: id(24),
        evidence: { kind: "future", value: {} } as never,
      }),
    ).toThrow(ExecutionRunRepositoryError);
    expect(() =>
      runs.finish({
        eventId: id(25),
        taskId: id(1),
        runId: id(10),
        expectedRunVersion: bound.runVersion,
        expectedTaskVersion: 5,
        status: "blocked",
        terminalReason: "evidence_missing",
        finalResult: {
          outcome: "blocked",
          summary: "invalid",
          validationCommands: "not-an-array",
          changedFiles: [],
          acceptanceCriteria: [],
        } as never,
        workspaceAfter: null,
        occurredAtMs: 7,
      }),
    ).toThrow(ExecutionRunRepositoryError);
  });

  it("atomically moves a node through running and succeeded with auditable evidence", async () => {
    const { runs, tasks } = await context();
    expect(runs.start({ run: run(), expectedTaskVersion: 4 }).run.status).toBe("running");
    expect(tasks.readTask(id(1))).toMatchObject({
      taskVersion: 5,
      activeGraph: { nodes: [{ nodeId: id(6), status: "running" }] },
    });

    const bound = runs.bind({
      eventId: id(11),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      occurredAtMs: 6,
    }).run;
    const command = runs.appendEvidence({
      eventId: id(12),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: bound.runVersion,
      evidence: {
        kind: "command",
        value: {
          sequence: 1,
          sourceItemId: "command-1",
          command: "pnpm test",
          status: "completed",
          exitCode: 0,
          durationMs: 12,
          outputBytes: 6,
          outputDigest: "e".repeat(64),
        },
      },
      occurredAtMs: 7,
    }).run;
    const file = runs.appendEvidence({
      eventId: id(13),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: command.runVersion,
      evidence: {
        kind: "file",
        value: {
          sequence: 2,
          sourceItemId: "file-1",
          path: "src/index.ts",
          changeKind: "update",
          status: "completed",
          diffDigest: "f".repeat(64),
        },
      },
      occurredAtMs: 8,
    }).run;
    const finalResult = {
      outcome: "completed" as const,
      summary: "完成",
      validationCommands: ["pnpm test"],
      changedFiles: [{ path: "src/index.ts", changeKind: "update" as const }],
      acceptanceCriteria: [{ criterion: "测试通过", passed: true, evidence: "pnpm test" }],
    };
    const finished = runs.finish({
      eventId: id(14),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: file.runVersion,
      expectedTaskVersion: 5,
      status: "succeeded",
      terminalReason: "completed",
      finalResult,
      workspaceAfter: workspace(["src/index.ts"]),
      occurredAtMs: 9,
    }).run;

    expect(finished).toMatchObject({
      status: "succeeded",
      runVersion: 5,
      threadId: "thread-1",
      turnId: "turn-1",
      commands: [{ command: "pnpm test", exitCode: 0 }],
      files: [{ path: "src/index.ts", changeKind: "update" }],
      finalResult,
      terminalReason: "completed",
      completedAtMs: 9,
    });
    expect(tasks.readTask(id(1))).toMatchObject({
      taskVersion: 6,
      activeGraph: { nodes: [{ nodeId: id(6), status: "succeeded" }] },
    });
    expect(runs.readActive()).toBeNull();
  });

  it("keeps exact retries idempotent and rejects stale or duplicate evidence", async () => {
    const { runs } = await context();
    const initial = run();
    runs.start({ run: initial, expectedTaskVersion: 4 });
    expect(runs.start({ run: initial, expectedTaskVersion: 4 })).toMatchObject({ duplicate: true });
    const bound = runs.bind({
      eventId: id(11),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      occurredAtMs: 6,
    });
    expect(
      runs.bind({
        eventId: id(11),
        taskId: id(1),
        runId: id(10),
        expectedRunVersion: 1,
        threadId: "thread-1",
        turnId: "turn-1",
        occurredAtMs: 6,
      }),
    ).toMatchObject({ duplicate: true, run: { runVersion: 2 } });
    const evidence = {
      eventId: id(12),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: bound.run.runVersion,
      evidence: {
        kind: "command" as const,
        value: {
          sequence: 1,
          sourceItemId: "same",
          command: "pnpm test",
          status: "completed" as const,
          exitCode: 0,
          durationMs: 1,
          outputBytes: 0,
          outputDigest: "e".repeat(64),
        },
      },
      occurredAtMs: 7,
    };
    runs.appendEvidence(evidence);
    expect(() =>
      runs.appendEvidence({ ...evidence, eventId: id(13), expectedRunVersion: 3 }),
    ).toThrow(ExecutionRunRepositoryError);
  });

  it("persists stopping and conservative interrupted recovery states", async () => {
    const { runs, tasks } = await context();
    runs.start({ run: run(), expectedTaskVersion: 4 });
    const stopping = runs.requestInterrupt({
      eventId: id(11),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: 1,
      occurredAtMs: 6,
    }).run;
    expect(stopping).toMatchObject({ status: "stopping", runVersion: 2 });
    const interrupted = runs.finish({
      eventId: id(12),
      taskId: id(1),
      runId: id(10),
      expectedRunVersion: 2,
      expectedTaskVersion: 5,
      status: "interrupted",
      terminalReason: "daemon_restarted",
      finalResult: null,
      workspaceAfter: null,
      occurredAtMs: 7,
    }).run;
    expect(interrupted).toMatchObject({
      status: "interrupted",
      terminalReason: "daemon_restarted",
    });
    expect(tasks.readTask(id(1)).activeGraph?.nodes[0]?.status).toBe("interrupted");
  });
});
