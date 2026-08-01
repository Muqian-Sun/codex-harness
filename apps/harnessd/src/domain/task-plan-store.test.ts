import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  TaskPlanError,
  TaskPlanStore,
  type CreateTaskInput,
  type PlanRevisionDraft,
  type RequirementDraft,
} from "./task-plan-store.js";

const temporaryDirectories: string[] = [];
const stores: TaskPlanStore[] = [];

async function privateDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-task-plan-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openStore(path: string): Promise<TaskPlanStore> {
  const store = await TaskPlanStore.open({ path, now: () => 1_750_000_000_000 });
  stores.push(store);
  return store;
}

function requirement(overrides?: Partial<RequirementDraft>): RequirementDraft {
  return {
    revisionId: randomUUID(),
    sourceText: "用户要求持久保存长任务计划。",
    objective: "在上下文压缩后恢复任务目标和未完成计划。",
    constraints: ["Harness 是权威状态所有者", "模型不能直接提交完成状态"],
    acceptanceCriteria: ["重启后目标仍可读取", "计划步骤使用稳定 ID"],
    ...overrides,
  };
}

function plan(
  basedOnRequirementRevisionId: string,
  overrides?: Partial<PlanRevisionDraft>,
): PlanRevisionDraft {
  return {
    revisionId: randomUUID(),
    status: "candidate",
    basedOnRequirementRevisionId,
    steps: [
      {
        stepId: randomUUID(),
        title: "持久化计划",
        description: "把规范化计划保存为带稳定 ID 的修订。",
        acceptanceCriteria: ["关闭并重开后仍可读取"],
      },
    ],
    ...overrides,
  };
}

function createInput(overrides?: Partial<CreateTaskInput>): CreateTaskInput {
  const initialRequirement = overrides?.requirement ?? requirement();
  return {
    eventId: overrides?.eventId ?? initialRequirement.revisionId,
    taskId: randomUUID(),
    title: "长任务恢复",
    occurredAtMs: 1_750_000_000_001,
    requirement: initialRequirement,
    metadata: { actor: "user.local", correlationId: "request-1" },
    ...overrides,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Test cleanup continues after deliberate failure states.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("persistent task and plan store", () => {
  it("creates, lists, and reopens a task with its initial requirement revision", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    const created = store.createTask(input);

    expect(created).toMatchObject({
      duplicate: false,
      event: { sequence: 1, eventType: "task.created" },
      task: {
        taskId: input.taskId,
        title: input.title,
        taskVersion: 1,
        activeRequirement: {
          revisionId: input.requirement.revisionId,
          revisionNumber: 1,
        },
        latestPlan: null,
        confirmedPlan: null,
      },
    });
    expect(store.listTasks()).toEqual([created.task]);
    expect(Object.isFrozen(created.task.activeRequirement.constraints)).toBe(true);
    store.close();

    const reopened = await openStore(path);
    expect(reopened.readTask(input.taskId)).toEqual(created.task);
    expect(reopened.inspect()).toMatchObject({ eventCount: 1, projectionCount: 1 });
  });

  it("records candidate and confirmed plan revisions with stable step IDs", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    const created = store.createTask(input);
    const candidate = plan(input.requirement.revisionId);
    const candidateResult = store.revisePlan({
      eventId: candidate.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 1,
      expectedTaskVersion: created.task.taskVersion,
      previousPlanRevisionId: null,
      plan: candidate,
    });
    const confirmed = plan(input.requirement.revisionId, {
      status: "confirmed",
      steps: candidate.steps,
    });
    const confirmedResult = store.revisePlan({
      eventId: confirmed.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: candidateResult.task.taskVersion,
      previousPlanRevisionId: candidate.revisionId,
      plan: confirmed,
    });

    expect(candidateResult.task).toMatchObject({
      taskVersion: 2,
      latestPlan: { revisionId: candidate.revisionId, revisionNumber: 1, status: "candidate" },
      confirmedPlan: null,
    });
    expect(confirmedResult.task).toMatchObject({
      taskVersion: 3,
      latestPlan: { revisionId: confirmed.revisionId, revisionNumber: 2, status: "confirmed" },
      confirmedPlan: { revisionId: confirmed.revisionId, revisionNumber: 2 },
    });
    expect(confirmedResult.task.confirmedPlan?.steps[0]?.stepId).toBe(candidate.steps[0]?.stepId);
  });

  it("revises requirements, clears a stale candidate, and preserves the last confirmed plan", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    const created = store.createTask(input);
    const confirmed = plan(input.requirement.revisionId, { status: "confirmed" });
    const planned = store.revisePlan({
      eventId: confirmed.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 1,
      expectedTaskVersion: created.task.taskVersion,
      previousPlanRevisionId: null,
      plan: confirmed,
    });
    const revisedRequirement = requirement({ objective: "恢复目标、约束、决定和证据。" });
    const revised = store.reviseRequirements({
      eventId: revisedRequirement.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: planned.task.taskVersion,
      previousRequirementRevisionId: input.requirement.revisionId,
      requirement: revisedRequirement,
    });

    expect(revised.task).toMatchObject({
      taskVersion: 3,
      activeRequirement: {
        revisionId: revisedRequirement.revisionId,
        revisionNumber: 2,
      },
      latestPlan: null,
      confirmedPlan: { revisionId: confirmed.revisionId },
    });
  });

  it("makes identical command retries idempotent even after later task versions", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    const first = store.createTask(input);
    expect(store.createTask(input)).toMatchObject({ duplicate: true, event: first.event });

    const retriedRequirement = requirement();
    const revisedInput = {
      eventId: retriedRequirement.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 1,
      expectedTaskVersion: 1,
      previousRequirementRevisionId: input.requirement.revisionId,
      requirement: retriedRequirement,
    };
    const revised = store.reviseRequirements(revisedInput);
    const laterPlan = plan(revised.task.activeRequirement.revisionId);
    store.revisePlan({
      eventId: laterPlan.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: revised.task.taskVersion,
      previousPlanRevisionId: null,
      plan: laterPlan,
    });
    const retried = store.reviseRequirements(revisedInput);

    expect(retried.duplicate).toBe(true);
    expect(retried.task.taskVersion).toBe(3);
    expect(store.inspect().eventCount).toBe(3);
  });

  it("rolls back stale versions, wrong predecessors, and plans based on old requirements", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput({ title: "sensitive task title" });
    store.createTask(input);

    const staleRequirement = requirement();
    let captured: unknown;
    try {
      store.reviseRequirements({
        eventId: staleRequirement.revisionId,
        taskId: input.taskId,
        occurredAtMs: input.occurredAtMs + 1,
        expectedTaskVersion: 2,
        previousRequirementRevisionId: input.requirement.revisionId,
        requirement: staleRequirement,
      });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "conflict" });
    expect(String(captured)).not.toContain("sensitive task title");

    const stalePlan = plan(randomUUID());
    expect(() =>
      store.revisePlan({
        eventId: stalePlan.revisionId,
        taskId: input.taskId,
        occurredAtMs: input.occurredAtMs + 1,
        expectedTaskVersion: 1,
        previousPlanRevisionId: null,
        plan: stalePlan,
      }),
    ).toThrowError(TaskPlanError);
    expect(store.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1 });
    expect(store.readTask(input.taskId).taskVersion).toBe(1);
  });

  it("rejects strict, duplicate-step, oversized, and non-monotonic inputs", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    expect(() => store.createTask({ ...input, unexpected: true } as never)).toThrowError(
      TaskPlanError,
    );
    expect(() => store.createTask({ ...input, eventId: randomUUID() })).toThrowError(TaskPlanError);
    expect(() =>
      store.createTask(createInput({ title: "x".repeat(257), taskId: randomUUID() })),
    ).toThrowError(TaskPlanError);
    store.createTask(input);

    const step = plan(input.requirement.revisionId).steps[0];
    const duplicateStepPlan = plan(input.requirement.revisionId, { steps: [step!, step!] });
    expect(() =>
      store.revisePlan({
        eventId: duplicateStepPlan.revisionId,
        taskId: input.taskId,
        occurredAtMs: input.occurredAtMs + 1,
        expectedTaskVersion: 1,
        previousPlanRevisionId: null,
        plan: duplicateStepPlan,
      }),
    ).toThrowError(TaskPlanError);
    const oldTimestampRequirement = requirement();
    expect(() =>
      store.reviseRequirements({
        eventId: oldTimestampRequirement.revisionId,
        taskId: input.taskId,
        occurredAtMs: input.occurredAtMs - 1,
        expectedTaskVersion: 1,
        previousRequirementRevisionId: input.requirement.revisionId,
        requirement: oldTimestampRequirement,
      }),
    ).toThrowError(TaskPlanError);
    const oversizedSteps = Array.from({ length: 40 }, () => ({
      stepId: randomUUID(),
      title: "bounded step",
      description: "x".repeat(8 * 1024),
      acceptanceCriteria: ["bounded total"],
    }));
    const oversizedPlan = plan(input.requirement.revisionId, { steps: oversizedSteps });
    expect(() =>
      store.revisePlan({
        eventId: oversizedPlan.revisionId,
        taskId: input.taskId,
        occurredAtMs: input.occurredAtMs + 1,
        expectedTaskVersion: 1,
        previousPlanRevisionId: null,
        plan: oversizedPlan,
      }),
    ).toThrowError(TaskPlanError);
    expect(store.inspect().eventCount).toBe(1);
  });

  it("paginates tasks by stable task ID and rejects missing or invalid IDs", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    store.createTask(createInput({ taskId: secondId }));
    store.createTask(createInput({ taskId: firstId }));

    expect(store.listTasks("", 1).map((task) => task.taskId)).toEqual([firstId]);
    expect(store.listTasks(firstId, 1).map((task) => task.taskId)).toEqual([secondId]);
    expect(() => store.readTask(randomUUID())).toThrowError(TaskPlanError);
    expect(() => store.readTask("invalid")).toThrowError(TaskPlanError);
  });

  it("closes idempotently and rejects later operations", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    store.close();
    store.close();
    expect(() => store.listTasks()).toThrowError(TaskPlanError);
    expect(() => store.createTask(createInput())).toThrowError(TaskPlanError);
  });
});
