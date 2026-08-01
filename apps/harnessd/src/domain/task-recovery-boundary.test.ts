import { describe, expect, it } from "vitest";

import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  TaskRecoveryBoundaryError,
  applyTaskRecoveryLifecycleSignal,
  createTaskRecoveryBoundary,
  prepareNextTurnRecovery,
  type TaskRecoveryBoundaryState,
  type TaskRecoveryLifecycleSignal,
} from "./task-recovery-boundary.js";
import { buildTaskRecoveryCapsule } from "./task-recovery-context.js";

const TASK_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_TASK_ID = "00000000-0000-4000-8000-000000000002";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000003";
const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

function task(overrides?: Partial<TaskPlanRecord>): TaskPlanRecord {
  return {
    taskId: TASK_ID,
    title: "安全轮次恢复",
    taskVersion: 1,
    createdAtMs: 1_750_000_000_000,
    updatedAtMs: 1_750_000_000_000,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "在下一安全 turn 恢复权威 TODO。",
      objective: "只有终止边界与新鲜胶囊同时成立时才准备恢复。",
      constraints: ["不能把 turn completed 当作节点验证完成"],
      acceptanceCriteria: ["过期胶囊被阻止"],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
    ...overrides,
  };
}

function boundary(): TaskRecoveryBoundaryState {
  return createTaskRecoveryBoundary({ taskId: TASK_ID, threadId: THREAD_ID, turnId: TURN_ID });
}

const TURN_STARTED = Object.freeze({
  type: "turn_started" as const,
  threadId: THREAD_ID,
  turnId: TURN_ID,
});
const COMPACTION_STARTED = Object.freeze({
  type: "context_compaction_started" as const,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  itemId: "compact-1",
});
const COMPACTION_COMPLETED = Object.freeze({
  type: "context_compaction_completed" as const,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  itemId: "compact-1",
});
const TURN_COMPLETED = Object.freeze({
  type: "turn_completed" as const,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  status: "completed" as const,
  contextCompactionItemIds: Object.freeze(["compact-1"]),
});

describe("task recovery boundary", () => {
  it("creates a frozen active boundary that blocks next-turn recovery", () => {
    const state = boundary();
    expect(state).toEqual({
      schemaVersion: 1,
      taskId: TASK_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      turnStartedObserved: false,
      terminalStatus: null,
      compactions: [],
      phase: "active",
      resultTrust: "normal",
      nextTurnRecovery: "blocked",
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.compactions)).toBe(true);
    expect(prepareNextTurnRecovery(state, task(), buildTaskRecoveryCapsule(task()))).toEqual({
      kind: "blocked",
      reason: "turn_active",
    });
  });

  it("accumulates duplicate and out-of-order compaction facts without state regression", () => {
    let state = boundary();
    state = applyTaskRecoveryLifecycleSignal(state, COMPACTION_COMPLETED);
    state = applyTaskRecoveryLifecycleSignal(state, TURN_COMPLETED);
    state = applyTaskRecoveryLifecycleSignal(state, TURN_STARTED);
    state = applyTaskRecoveryLifecycleSignal(state, COMPACTION_STARTED);
    const duplicate = applyTaskRecoveryLifecycleSignal(state, COMPACTION_STARTED);

    expect(duplicate).toEqual(state);
    expect(duplicate).toMatchObject({
      turnStartedObserved: true,
      terminalStatus: "completed",
      phase: "terminal",
      resultTrust: "revalidation_required",
      nextTurnRecovery: "required",
      compactions: [
        {
          itemId: "compact-1",
          startedObserved: true,
          completedObserved: true,
          turnSummaryObserved: true,
        },
      ],
    });
  });

  it("produces the same canonical state for different valid signal orders", () => {
    const secondCompactionStarted = {
      ...COMPACTION_STARTED,
      itemId: "compact-2",
    };
    const firstOrder = [
      TURN_STARTED,
      secondCompactionStarted,
      COMPACTION_STARTED,
      COMPACTION_COMPLETED,
      { ...TURN_COMPLETED, contextCompactionItemIds: ["compact-2", "compact-1"] },
    ];
    const secondOrder = [
      { ...TURN_COMPLETED, contextCompactionItemIds: ["compact-1", "compact-2"] },
      COMPACTION_COMPLETED,
      COMPACTION_STARTED,
      secondCompactionStarted,
      TURN_STARTED,
    ];
    const first = replay(firstOrder);
    expect(first).toEqual(replay(secondOrder));
    expect(first.compactions.map((item) => item.itemId)).toEqual(["compact-1", "compact-2"]);
  });

  it("requires a fresh capsule after every terminal turn and carries compaction trust", () => {
    const currentTask = task();
    const capsule = buildTaskRecoveryCapsule(currentTask);
    const cleanTerminal = applyTaskRecoveryLifecycleSignal(boundary(), {
      ...TURN_COMPLETED,
      contextCompactionItemIds: [],
    });
    expect(cleanTerminal).toMatchObject({
      phase: "terminal",
      resultTrust: "normal",
      nextTurnRecovery: "required",
    });
    expect(prepareNextTurnRecovery(cleanTerminal, currentTask, capsule)).toMatchObject({
      kind: "ready",
      taskId: TASK_ID,
      threadId: THREAD_ID,
      previousTurnId: TURN_ID,
      terminalStatus: "completed",
      resultTrust: "normal",
      fence: capsule.fence,
      input: capsule.input,
    });
    const mutableCandidate = {
      fence: { ...capsule.fence },
      input: { ...capsule.input, text_elements: [] },
    };
    const prepared = prepareNextTurnRecovery(cleanTerminal, currentTask, mutableCandidate);
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") {
      throw new Error("Fresh mutable recovery candidate was not accepted.");
    }
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.fence)).toBe(true);
    expect(Object.isFrozen(prepared.input)).toBe(true);
    expect(prepared.fence).not.toBe(mutableCandidate.fence);
    expect(prepared.input).not.toBe(mutableCandidate.input);

    const compactedTerminal = replay([COMPACTION_STARTED, TURN_COMPLETED]);
    expect(prepareNextTurnRecovery(compactedTerminal, currentTask, capsule)).toMatchObject({
      kind: "ready",
      resultTrust: "revalidation_required",
    });
  });

  it("treats every App Server terminal status as a next-turn recovery boundary", () => {
    const currentTask = task();
    const capsule = buildTaskRecoveryCapsule(currentTask);
    for (const status of ["completed", "interrupted", "failed"] as const) {
      const terminal = applyTaskRecoveryLifecycleSignal(boundary(), {
        ...TURN_COMPLETED,
        status,
        contextCompactionItemIds: [],
      });
      expect(terminal).toMatchObject({
        terminalStatus: status,
        phase: "terminal",
        nextTurnRecovery: "required",
      });
      expect(prepareNextTurnRecovery(terminal, currentTask, capsule)).toMatchObject({
        kind: "ready",
        terminalStatus: status,
      });
    }
  });

  it("blocks task mismatches and stale or modified capsules", () => {
    const currentTask = task();
    const terminal = applyTaskRecoveryLifecycleSignal(boundary(), TURN_COMPLETED);
    const capsule = buildTaskRecoveryCapsule(currentTask);
    expect(prepareNextTurnRecovery(terminal, task({ taskId: OTHER_TASK_ID }), capsule)).toEqual({
      kind: "blocked",
      reason: "task_mismatch",
    });
    expect(
      prepareNextTurnRecovery(
        terminal,
        task({ taskVersion: currentTask.taskVersion + 1 }),
        capsule,
      ),
    ).toEqual({ kind: "blocked", reason: "stale_context" });
    expect(
      prepareNextTurnRecovery(terminal, currentTask, {
        ...capsule,
        fence: { ...capsule.fence, digest: "0".repeat(64) },
      }),
    ).toEqual({ kind: "blocked", reason: "stale_context" });
  });

  it("rejects wrong bindings and conflicting terminal facts with fixed errors", () => {
    let captured: unknown;
    try {
      applyTaskRecoveryLifecycleSignal(boundary(), {
        ...TURN_STARTED,
        threadId: "private-wrong-thread",
      });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "binding_mismatch" });
    expect(String(captured)).not.toContain("private-wrong-thread");

    const terminal = applyTaskRecoveryLifecycleSignal(boundary(), TURN_COMPLETED);
    expect(() =>
      applyTaskRecoveryLifecycleSignal(terminal, {
        ...TURN_COMPLETED,
        status: "failed",
      }),
    ).toThrowError(TaskRecoveryBoundaryError);
  });

  it("rejects malformed state and signal objects before they influence the gate", () => {
    expect(() => createTaskRecoveryBoundary({} as never)).toThrowError(TaskRecoveryBoundaryError);
    expect(() =>
      applyTaskRecoveryLifecycleSignal(
        { ...boundary(), phase: "terminal" } as TaskRecoveryBoundaryState,
        TURN_STARTED,
      ),
    ).toThrowError(TaskRecoveryBoundaryError);
    expect(() =>
      applyTaskRecoveryLifecycleSignal(boundary(), {
        ...TURN_COMPLETED,
        contextCompactionItemIds: ["compact-1", "compact-1"],
      }),
    ).toThrowError(TaskRecoveryBoundaryError);
    let captured: unknown;
    try {
      applyTaskRecoveryLifecycleSignal(boundary(), {
        ...TURN_COMPLETED,
        contextCompactionItemIds: Array.from(
          { length: 1025 },
          (_, index) => `compact-${String(index)}`,
        ),
      });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "capacity_exceeded" });
  });
});

function replay(signals: readonly TaskRecoveryLifecycleSignal[]): TaskRecoveryBoundaryState {
  return signals.reduce(
    (state, signal) => applyTaskRecoveryLifecycleSignal(state, signal),
    boundary(),
  );
}
