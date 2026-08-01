import { describe, expect, it } from "vitest";

import type { PlanRevision, TaskPlanRecord, TaskReconciliation } from "./task-plan-store.js";
import {
  TaskRecoveryContextError,
  buildTaskRecoveryCapsule,
  isTaskRecoveryCapsuleCurrent,
  type TaskRecoveryCapsule,
} from "./task-recovery-context.js";

const TASK_ID = "00000000-0000-4000-8000-000000000001";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000002";
const PLAN_ID = "00000000-0000-4000-8000-000000000003";
const STEP_ID = "00000000-0000-4000-8000-000000000004";
const GRAPH_ID = "00000000-0000-4000-8000-000000000005";
const NODE_ID = "00000000-0000-4000-8000-000000000006";
const TERMINAL_NODE_ID = "00000000-0000-4000-8000-000000000007";
const CANDIDATE_PLAN_ID = "00000000-0000-4000-8000-000000000008";
const CANDIDATE_STEP_ID = "00000000-0000-4000-8000-000000000009";
const OLD_REQUIREMENT_ID = "00000000-0000-4000-8000-000000000010";
const OLD_PLAN_ID = "00000000-0000-4000-8000-000000000011";

function confirmedPlan(overrides?: Partial<PlanRevision>): PlanRevision {
  return {
    revisionId: PLAN_ID,
    revisionNumber: 1,
    status: "confirmed",
    basedOnRequirementRevisionId: REQUIREMENT_ID,
    steps: [
      {
        stepId: STEP_ID,
        title: "恢复未完成工作",
        description: "在新 turn 注入持久任务状态。",
        acceptanceCriteria: ["恢复胶囊可确定性重建"],
      },
    ],
    ...overrides,
  };
}

function candidatePlan(): PlanRevision {
  return {
    revisionId: CANDIDATE_PLAN_ID,
    revisionNumber: 2,
    status: "candidate",
    basedOnRequirementRevisionId: REQUIREMENT_ID,
    steps: [
      {
        stepId: CANDIDATE_STEP_ID,
        title: "候选调整",
        description: "尚未成为可执行 DAG。",
        acceptanceCriteria: ["不得当作权威执行计划"],
      },
    ],
  };
}

function task(overrides?: Partial<TaskPlanRecord>): TaskPlanRecord {
  const plan = confirmedPlan();
  return {
    taskId: TASK_ID,
    title: "上下文压缩恢复",
    taskVersion: 3,
    createdAtMs: 1_750_000_000_000,
    updatedAtMs: 1_750_000_000_003,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "用户要求上下文压缩后继续正确的 TODO。",
      objective: "在下一个安全 turn 恢复目标和未完成节点。",
      constraints: ["Harness 状态优先于旧对话摘要"],
      acceptanceCriteria: ["过期胶囊不能发送"],
    },
    latestPlan: plan,
    confirmedPlan: plan,
    activeGraph: {
      revisionId: GRAPH_ID,
      revisionNumber: 1,
      basedOnPlanRevisionId: PLAN_ID,
      nodes: [
        {
          nodeId: NODE_ID,
          sourcePlanStepId: STEP_ID,
          title: "生成恢复胶囊",
          description: "序列化当前权威状态。",
          acceptanceCriteria: ["包含未完成节点"],
          dependsOnNodeIds: [],
          status: "pending",
        },
        {
          nodeId: TERMINAL_NODE_ID,
          sourcePlanStepId: STEP_ID,
          title: "已完成准备",
          description: "不应再次执行。",
          acceptanceCriteria: ["只保留终态摘要"],
          dependsOnNodeIds: [NODE_ID],
          status: "succeeded",
        },
      ],
      topologicalOrder: [NODE_ID, TERMINAL_NODE_ID],
    },
    activeReconciliation: null,
    lastGraphRevisionNumber: 1,
    ...overrides,
  };
}

function snapshot(capsule: TaskRecoveryCapsule): Record<string, unknown> {
  const jsonStart = capsule.input.text.indexOf("{");
  if (jsonStart < 0) {
    throw new Error("Recovery JSON was missing.");
  }
  return JSON.parse(capsule.input.text.slice(jsonStart)) as Record<string, unknown>;
}

describe("task recovery context", () => {
  it("builds a deterministic next-turn capsule with unfinished and terminal node separation", () => {
    const current = task();
    const first = buildTaskRecoveryCapsule(current);
    const second = buildTaskRecoveryCapsule(current);
    const content = snapshot(first) as {
      phase: string;
      authoritativePlan: { revisionId: string };
      pendingCandidatePlan: unknown;
      graph: {
        unfinishedNodes: Array<{ nodeId: string; status: string }>;
        terminalNodes: Array<{ nodeId: string; status: string }>;
      };
    };

    expect(first).toEqual(second);
    expect(first.input).toMatchObject({ type: "text", text_elements: [] });
    expect(first.input.text).toContain("CODEX_HARNESS_RECOVERY_V1");
    expect(first.input.text).toContain('\n{"authoritativePlan":{');
    expect(first.input.text.indexOf('"authoritativePlan"')).toBeLessThan(
      first.input.text.indexOf('"authority"'),
    );
    expect(first.fence.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(content).toMatchObject({
      phase: "active_graph",
      authoritativePlan: { revisionId: PLAN_ID },
      pendingCandidatePlan: null,
      graph: {
        unfinishedNodes: [{ nodeId: NODE_ID, status: "pending" }],
        terminalNodes: [{ nodeId: TERMINAL_NODE_ID, status: "succeeded" }],
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.fence)).toBe(true);
    expect(Object.isFrozen(first.input.text_elements)).toBe(true);
    expect(isTaskRecoveryCapsuleCurrent(current, first)).toBe(true);
  });

  it("keeps an active graph authoritative while retaining a non-executable candidate", () => {
    const capsule = buildTaskRecoveryCapsule(task({ latestPlan: candidatePlan() }));
    const content = snapshot(capsule) as {
      phase: string;
      authoritativePlan: { revisionId: string };
      pendingCandidatePlan: { revisionId: string };
    };

    expect(content).toMatchObject({
      phase: "active_graph_with_candidate",
      authoritativePlan: { revisionId: PLAN_ID },
      pendingCandidatePlan: { revisionId: CANDIDATE_PLAN_ID },
    });
  });

  it("distinguishes requirement-only, candidate, and confirmed-plan phases", () => {
    const staleConfirmed = confirmedPlan({
      revisionId: OLD_PLAN_ID,
      basedOnRequirementRevisionId: OLD_REQUIREMENT_ID,
    });
    const cases = [
      {
        expected: "requirements_only",
        source: task({ latestPlan: null, confirmedPlan: staleConfirmed, activeGraph: null }),
      },
      {
        expected: "candidate_plan",
        source: task({
          latestPlan: candidatePlan(),
          confirmedPlan: staleConfirmed,
          activeGraph: null,
        }),
      },
      {
        expected: "confirmed_plan_pending_graph",
        source: task({ activeGraph: null }),
      },
    ];

    for (const candidate of cases) {
      expect(snapshot(buildTaskRecoveryCapsule(candidate.source))).toMatchObject({
        phase: candidate.expected,
      });
    }
    expect(snapshot(buildTaskRecoveryCapsule(cases[1]!.source))).toMatchObject({
      authoritativePlan: null,
      historicalConfirmedPlanRevisionId: OLD_PLAN_ID,
    });
    expect(
      snapshot(buildTaskRecoveryCapsule(task({ latestPlan: candidatePlan(), activeGraph: null }))),
    ).toMatchObject({
      phase: "candidate_plan",
      authoritativePlan: { revisionId: PLAN_ID },
      pendingCandidatePlan: { revisionId: CANDIDATE_PLAN_ID },
      historicalConfirmedPlanRevisionId: null,
    });
  });

  it("invalidates a capsule after any task state or capsule content change", () => {
    const current = task();
    const capsule = buildTaskRecoveryCapsule(current);
    expect(
      isTaskRecoveryCapsuleCurrent(task({ taskVersion: current.taskVersion + 1 }), capsule),
    ).toBe(false);
    expect(
      isTaskRecoveryCapsuleCurrent(
        task({
          activeRequirement: {
            ...current.activeRequirement,
            sourceText: "状态内容变化但调用方错误地保留了 task version。",
          },
        }),
        capsule,
      ),
    ).toBe(false);
    expect(
      isTaskRecoveryCapsuleCurrent(current, {
        ...capsule,
        fence: { ...capsule.fence, digest: "0".repeat(64) },
      }),
    ).toBe(false);
    expect(
      isTaskRecoveryCapsuleCurrent(current, {
        ...capsule,
        input: { ...capsule.input, unexpected: true },
      }),
    ).toBe(false);
    expect(isTaskRecoveryCapsuleCurrent(current, {})).toBe(false);
  });

  it("rejects inconsistent graph and reconciliation sources with fixed public errors", () => {
    const current = task();
    const wrongGraph = {
      ...current.activeGraph!,
      basedOnPlanRevisionId: CANDIDATE_PLAN_ID,
    };
    let captured: unknown;
    try {
      buildTaskRecoveryCapsule(task({ activeGraph: wrongGraph }));
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "invalid_task" });
    expect(String(captured)).not.toContain(CANDIDATE_PLAN_ID);

    const reconciliation = {
      reconciliationId: REQUIREMENT_ID,
      appliedAtTaskVersion: 3,
      previousRequirementRevisionId: OLD_REQUIREMENT_ID,
      requirementRevisionId: REQUIREMENT_ID,
      previousPlanRevisionId: OLD_PLAN_ID,
      planRevisionId: CANDIDATE_PLAN_ID,
      previousGraphRevisionId: "00000000-0000-4000-8000-000000000012",
      graphRevisionId: GRAPH_ID,
      impact: "editorial",
      changes: {
        preservedPlanStepIds: [STEP_ID],
        addedPlanStepIds: [],
        removedPlanStepIds: [],
        planOrderChanged: false,
        preservedNodeIds: [NODE_ID, TERMINAL_NODE_ID],
        addedNodeIds: [],
        removedNodeIds: [],
        graphOrderChanged: false,
        dependencyChangedNodeIds: [],
        revalidationNodeIds: [],
      },
    } as const satisfies TaskReconciliation;
    expect(() =>
      buildTaskRecoveryCapsule(task({ activeReconciliation: reconciliation })),
    ).toThrowError(TaskRecoveryContextError);
  });

  it("rejects malformed and oversized recovery sources before they reach App Server", () => {
    expect(() => buildTaskRecoveryCapsule({} as never)).toThrowError(TaskRecoveryContextError);
    const current = task();
    let captured: unknown;
    try {
      buildTaskRecoveryCapsule(
        task({
          activeRequirement: {
            ...current.activeRequirement,
            sourceText: "x".repeat(1024 * 1024),
          },
        }),
      );
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "context_too_large" });
  });
});
