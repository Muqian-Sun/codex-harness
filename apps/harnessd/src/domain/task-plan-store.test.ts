import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore, type ProjectionDefinition } from "../persistence/event-store.js";
import type { TaskGraphDraft } from "./task-graph.js";
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

function taskGraph(planRevision: PlanRevisionDraft): TaskGraphDraft {
  const nodeIds = planRevision.steps.map(() => randomUUID());
  return {
    revisionId: randomUUID(),
    basedOnPlanRevisionId: planRevision.revisionId,
    nodes: planRevision.steps.map((step, index) => ({
      nodeId: nodeIds[index]!,
      sourcePlanStepId: step.stepId,
      title: step.title,
      description: step.description,
      acceptanceCriteria: step.acceptanceCriteria,
      dependsOnNodeIds: index === 0 ? [] : [nodeIds[index - 1]!],
    })),
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

  it("commits a validated DAG with pending nodes and recovers it after reopening", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    const created = store.createTask(input);
    const confirmed = plan(input.requirement.revisionId, {
      status: "confirmed",
      steps: [
        ...plan(input.requirement.revisionId).steps,
        {
          stepId: randomUUID(),
          title: "恢复节点",
          description: "重启后恢复 DAG。",
          acceptanceCriteria: ["拓扑序保持稳定"],
        },
      ],
    });
    const planned = store.revisePlan({
      eventId: confirmed.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 1,
      expectedTaskVersion: created.task.taskVersion,
      previousPlanRevisionId: null,
      plan: confirmed,
    });
    const graph = taskGraph(confirmed);
    const committed = store.commitTaskGraph({
      eventId: graph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: planned.task.taskVersion,
      previousGraphRevisionId: null,
      graph,
    });

    expect(committed.task).toMatchObject({
      taskVersion: 3,
      lastGraphRevisionNumber: 1,
      activeGraph: {
        revisionId: graph.revisionId,
        revisionNumber: 1,
        basedOnPlanRevisionId: confirmed.revisionId,
      },
    });
    expect(committed.task.activeGraph?.nodes.map((node) => node.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(committed.task.activeGraph?.topologicalOrder).toEqual(
      graph.nodes.map((node) => node.nodeId),
    );
    store.close();

    const reopened = await openStore(path);
    expect(reopened.readTask(input.taskId)).toEqual(committed.task);
  });

  it("keeps a graph for a candidate plan but invalidates it on confirmed plan or requirement changes", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    const created = store.createTask(input);
    const firstConfirmed = plan(input.requirement.revisionId, { status: "confirmed" });
    const firstPlan = store.revisePlan({
      eventId: firstConfirmed.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 1,
      expectedTaskVersion: created.task.taskVersion,
      previousPlanRevisionId: null,
      plan: firstConfirmed,
    });
    const firstGraph = taskGraph(firstConfirmed);
    const firstCommitted = store.commitTaskGraph({
      eventId: firstGraph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: firstPlan.task.taskVersion,
      previousGraphRevisionId: null,
      graph: firstGraph,
    });
    const candidate = plan(input.requirement.revisionId);
    const candidateResult = store.revisePlan({
      eventId: candidate.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 3,
      expectedTaskVersion: firstCommitted.task.taskVersion,
      previousPlanRevisionId: firstConfirmed.revisionId,
      plan: candidate,
    });
    expect(candidateResult.task.activeGraph?.revisionId).toBe(firstGraph.revisionId);

    const secondConfirmed = plan(input.requirement.revisionId, {
      status: "confirmed",
      steps: candidate.steps,
    });
    const secondPlan = store.revisePlan({
      eventId: secondConfirmed.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 4,
      expectedTaskVersion: candidateResult.task.taskVersion,
      previousPlanRevisionId: candidate.revisionId,
      plan: secondConfirmed,
    });
    expect(secondPlan.task).toMatchObject({ activeGraph: null, lastGraphRevisionNumber: 1 });

    const secondGraph = taskGraph(secondConfirmed);
    const secondCommitted = store.commitTaskGraph({
      eventId: secondGraph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 5,
      expectedTaskVersion: secondPlan.task.taskVersion,
      previousGraphRevisionId: null,
      graph: secondGraph,
    });
    expect(secondCommitted.task.activeGraph?.revisionNumber).toBe(2);

    const revisedRequirement = requirement();
    const revised = store.reviseRequirements({
      eventId: revisedRequirement.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 6,
      expectedTaskVersion: secondCommitted.task.taskVersion,
      previousRequirementRevisionId: input.requirement.revisionId,
      requirement: revisedRequirement,
    });
    expect(revised.task).toMatchObject({ activeGraph: null, lastGraphRevisionNumber: 2 });
  });

  it("atomically reconciles requirements, stable TODO IDs, and the active DAG", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    const created = store.createTask(input);
    const preservedStep = plan(input.requirement.revisionId).steps[0]!;
    const removedStep = {
      stepId: randomUUID(),
      title: "删除旧待办",
      description: "该工作不再属于修订后的需求。",
      acceptanceCriteria: ["旧节点被新图移除"],
    };
    const confirmed = plan(input.requirement.revisionId, {
      status: "confirmed",
      steps: [preservedStep, removedStep],
    });
    const planned = store.revisePlan({
      eventId: confirmed.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 1,
      expectedTaskVersion: created.task.taskVersion,
      previousPlanRevisionId: null,
      plan: confirmed,
    });
    const previousGraph = taskGraph(confirmed);
    const committed = store.commitTaskGraph({
      eventId: previousGraph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: planned.task.taskVersion,
      previousGraphRevisionId: null,
      graph: previousGraph,
    });

    const nextRequirement = requirement({
      sourceText: "用户澄清了目标，并删除旧工作、增加新工作。",
      objective: "恢复目标并在需求变化后原子修正 TODO。",
    });
    const addedStep = {
      stepId: randomUUID(),
      title: "调和新待办",
      description: "保存可审阅差异并重新验证节点。",
      acceptanceCriteria: ["新节点以 pending 状态进入 DAG"],
    };
    const nextPlan = plan(nextRequirement.revisionId, {
      status: "confirmed",
      steps: [preservedStep, addedStep],
    });
    const addedNodeId = randomUUID();
    const nextGraph = {
      revisionId: randomUUID(),
      basedOnPlanRevisionId: nextPlan.revisionId,
      nodes: [
        {
          ...previousGraph.nodes[0]!,
          dependsOnNodeIds: [],
        },
        {
          nodeId: addedNodeId,
          sourcePlanStepId: addedStep.stepId,
          title: addedStep.title,
          description: addedStep.description,
          acceptanceCriteria: addedStep.acceptanceCriteria,
          dependsOnNodeIds: [previousGraph.nodes[0]!.nodeId],
        },
      ],
    };
    const command = {
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 3,
      expectedTaskVersion: committed.task.taskVersion,
      previousRequirementRevisionId: input.requirement.revisionId,
      previousPlanRevisionId: confirmed.revisionId,
      previousGraphRevisionId: previousGraph.revisionId,
      requirement: nextRequirement,
      plan: nextPlan,
      graph: nextGraph,
      metadata: { actor: "user.local" },
    } as const;
    const reconciled = store.reconcileRequirements(command);

    expect(reconciled).toMatchObject({
      duplicate: false,
      events: [
        { sequence: 4, eventType: "task.requirements_reconciled" },
        { sequence: 5, eventType: "task.plan_reconciled" },
        { sequence: 6, eventType: "task.graph_reconciled" },
      ],
      task: {
        taskVersion: 4,
        activeRequirement: { revisionId: nextRequirement.revisionId, revisionNumber: 2 },
        confirmedPlan: { revisionId: nextPlan.revisionId, revisionNumber: 2 },
        activeGraph: { revisionId: nextGraph.revisionId, revisionNumber: 2 },
        activeReconciliation: {
          reconciliationId: nextRequirement.revisionId,
          appliedAtTaskVersion: 4,
          impact: "restructuring",
          changes: {
            preservedPlanStepIds: [preservedStep.stepId],
            addedPlanStepIds: [addedStep.stepId],
            removedPlanStepIds: [removedStep.stepId],
            preservedNodeIds: [previousGraph.nodes[0]!.nodeId],
            addedNodeIds: [addedNodeId],
            removedNodeIds: [previousGraph.nodes[1]!.nodeId],
            dependencyChangedNodeIds: [],
            revalidationNodeIds: [],
          },
        },
      },
    });
    expect(reconciled.task.activeGraph?.nodes.map((node) => node.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(store.inspect()).toMatchObject({ eventCount: 6, lastSequence: 6 });

    const additiveRequirement = requirement({
      sourceText: "在已调和目标中补充一个新增待办。",
      objective: nextRequirement.objective,
      constraints: nextRequirement.constraints,
      acceptanceCriteria: nextRequirement.acceptanceCriteria,
    });
    const additiveStep = {
      stepId: randomUUID(),
      title: "新增验证",
      description: "只增加工作，不删除或重排现有工作。",
      acceptanceCriteria: ["影响等级为 additive"],
    };
    const additivePlan = plan(additiveRequirement.revisionId, {
      status: "confirmed",
      steps: [...nextPlan.steps, additiveStep],
    });
    const additiveNodeId = randomUUID();
    const additiveGraph = {
      revisionId: randomUUID(),
      basedOnPlanRevisionId: additivePlan.revisionId,
      nodes: [
        ...nextGraph.nodes,
        {
          nodeId: additiveNodeId,
          sourcePlanStepId: additiveStep.stepId,
          title: additiveStep.title,
          description: additiveStep.description,
          acceptanceCriteria: additiveStep.acceptanceCriteria,
          dependsOnNodeIds: [addedNodeId],
        },
      ],
    };
    const additive = store.reconcileRequirements({
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 4,
      expectedTaskVersion: reconciled.task.taskVersion,
      previousRequirementRevisionId: nextRequirement.revisionId,
      previousPlanRevisionId: nextPlan.revisionId,
      previousGraphRevisionId: nextGraph.revisionId,
      requirement: additiveRequirement,
      plan: additivePlan,
      graph: additiveGraph,
    });
    expect(additive.task).toMatchObject({
      taskVersion: 5,
      activeReconciliation: {
        impact: "additive",
        changes: {
          addedPlanStepIds: [additiveStep.stepId],
          addedNodeIds: [additiveNodeId],
          removedPlanStepIds: [],
          removedNodeIds: [],
          planOrderChanged: false,
          graphOrderChanged: false,
        },
      },
    });
    expect(store.inspect()).toMatchObject({ eventCount: 9, lastSequence: 9 });
    store.close();

    const reopened = await openStore(path);
    expect(reopened.readTask(input.taskId)).toEqual(additive.task);
  });

  it("preserves stable IDs across dependency changes and records their impact", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const input = createInput();
    const created = store.createTask(input);
    const firstStep = plan(input.requirement.revisionId).steps[0]!;
    const secondStep = {
      stepId: randomUUID(),
      title: "第二项工作",
      description: "验证依赖变化。",
      acceptanceCriteria: ["依赖差异被记录"],
    };
    const confirmed = plan(input.requirement.revisionId, {
      status: "confirmed",
      steps: [firstStep, secondStep],
    });
    const planned = store.revisePlan({
      eventId: confirmed.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 1,
      expectedTaskVersion: created.task.taskVersion,
      previousPlanRevisionId: null,
      plan: confirmed,
    });
    const nodeIds = [randomUUID(), randomUUID()];
    const previousGraph = {
      revisionId: randomUUID(),
      basedOnPlanRevisionId: confirmed.revisionId,
      nodes: confirmed.steps.map((step, index) => ({
        nodeId: nodeIds[index]!,
        sourcePlanStepId: step.stepId,
        title: step.title,
        description: step.description,
        acceptanceCriteria: step.acceptanceCriteria,
        dependsOnNodeIds: [],
      })),
    };
    const committed = store.commitTaskGraph({
      eventId: previousGraph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: planned.task.taskVersion,
      previousGraphRevisionId: null,
      graph: previousGraph,
    });
    const nextRequirement = requirement({ sourceText: "仅澄清文字并调整执行依赖。" });
    const nextPlan = plan(nextRequirement.revisionId, {
      status: "confirmed",
      steps: confirmed.steps,
    });
    const nextGraph = {
      revisionId: randomUUID(),
      basedOnPlanRevisionId: nextPlan.revisionId,
      nodes: [...previousGraph.nodes].reverse().map((node) => ({
        ...node,
        dependsOnNodeIds: node.nodeId === nodeIds[1] ? [nodeIds[0]!] : [],
      })),
    };

    const reconciled = store.reconcileRequirements({
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 3,
      expectedTaskVersion: committed.task.taskVersion,
      previousRequirementRevisionId: input.requirement.revisionId,
      previousPlanRevisionId: confirmed.revisionId,
      previousGraphRevisionId: previousGraph.revisionId,
      requirement: nextRequirement,
      plan: nextPlan,
      graph: nextGraph,
    });

    expect(reconciled.task.activeReconciliation).toMatchObject({
      impact: "restructuring",
      changes: {
        preservedPlanStepIds: confirmed.steps.map((step) => step.stepId),
        preservedNodeIds: [nodeIds[1], nodeIds[0]],
        graphOrderChanged: true,
        dependencyChangedNodeIds: [nodeIds[1]],
      },
    });
  });

  it("rejects semantic ID reuse and partial batch collisions without changing the task", async () => {
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
    const previousGraph = taskGraph(confirmed);
    const committed = store.commitTaskGraph({
      eventId: previousGraph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: planned.task.taskVersion,
      previousGraphRevisionId: null,
      graph: previousGraph,
    });
    const nextRequirement = requirement();
    const changedStepPlan = plan(nextRequirement.revisionId, {
      status: "confirmed",
      steps: [
        {
          ...confirmed.steps[0]!,
          acceptanceCriteria: ["改变后的验收条件不能沿用旧 ID"],
        },
      ],
    });
    const changedStepGraph = taskGraph(changedStepPlan);
    const baseCommand = {
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 3,
      expectedTaskVersion: committed.task.taskVersion,
      previousRequirementRevisionId: input.requirement.revisionId,
      previousPlanRevisionId: confirmed.revisionId,
      previousGraphRevisionId: previousGraph.revisionId,
    };
    let captured: unknown;
    try {
      store.reconcileRequirements({
        ...baseCommand,
        requirement: nextRequirement,
        plan: changedStepPlan,
        graph: changedStepGraph,
      });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "conflict" });
    expect(String(captured)).not.toContain("改变后的验收条件");

    const changedNodeRequirement = requirement();
    const unchangedStepPlan = plan(changedNodeRequirement.revisionId, {
      status: "confirmed",
      steps: confirmed.steps,
    });
    const changedNodeGraph = {
      revisionId: randomUUID(),
      basedOnPlanRevisionId: unchangedStepPlan.revisionId,
      nodes: previousGraph.nodes.map((node) => ({
        ...node,
        description: "改变后的节点语义不能沿用旧 ID。",
      })),
    };
    expect(() =>
      store.reconcileRequirements({
        ...baseCommand,
        requirement: changedNodeRequirement,
        plan: unchangedStepPlan,
        graph: changedNodeGraph,
      }),
    ).toThrowError(TaskPlanError);

    const collisionRequirement = requirement();
    const collisionPlan = plan(collisionRequirement.revisionId, {
      status: "confirmed",
      steps: confirmed.steps,
    });
    const collisionGraph = {
      ...taskGraph(collisionPlan),
      revisionId: input.requirement.revisionId,
      nodes: previousGraph.nodes.map((node) => ({ ...node })),
    };
    expect(() =>
      store.reconcileRequirements({
        ...baseCommand,
        requirement: collisionRequirement,
        plan: collisionPlan,
        graph: collisionGraph,
      }),
    ).toThrowError(TaskPlanError);
    const candidateRequirement = requirement();
    const candidatePlan = plan(candidateRequirement.revisionId, { steps: confirmed.steps });
    const candidateGraph = {
      ...taskGraph(candidatePlan),
      nodes: previousGraph.nodes.map((node) => ({ ...node })),
    };
    let invalidCandidate: unknown;
    try {
      store.reconcileRequirements({
        ...baseCommand,
        requirement: candidateRequirement,
        plan: candidatePlan,
        graph: candidateGraph,
      });
    } catch (error: unknown) {
      invalidCandidate = error;
    }
    expect(invalidCandidate).toMatchObject({ code: "invalid_input" });
    expect(store.readTask(input.taskId)).toEqual(committed.task);
    expect(store.inspect()).toMatchObject({ eventCount: 3, lastSequence: 3 });
  });

  it("keeps complete reconciliation retries idempotent after later candidate plans", async () => {
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
    const previousGraph = taskGraph(confirmed);
    const committed = store.commitTaskGraph({
      eventId: previousGraph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: planned.task.taskVersion,
      previousGraphRevisionId: null,
      graph: previousGraph,
    });
    const nextRequirement = requirement({ sourceText: "只调整需求原文的表达。" });
    const nextPlan = plan(nextRequirement.revisionId, {
      status: "confirmed",
      steps: confirmed.steps,
    });
    const nextGraph = {
      revisionId: randomUUID(),
      basedOnPlanRevisionId: nextPlan.revisionId,
      nodes: previousGraph.nodes.map((node) => ({ ...node })),
    };
    const command = {
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 3,
      expectedTaskVersion: committed.task.taskVersion,
      previousRequirementRevisionId: input.requirement.revisionId,
      previousPlanRevisionId: confirmed.revisionId,
      previousGraphRevisionId: previousGraph.revisionId,
      requirement: nextRequirement,
      plan: nextPlan,
      graph: nextGraph,
    } as const;
    const reconciled = store.reconcileRequirements(command);
    expect(reconciled.task.activeReconciliation?.impact).toBe("editorial");
    const candidate = plan(nextRequirement.revisionId);
    const later = store.revisePlan({
      eventId: candidate.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 4,
      expectedTaskVersion: reconciled.task.taskVersion,
      previousPlanRevisionId: nextPlan.revisionId,
      plan: candidate,
    });
    const retried = store.reconcileRequirements(command);

    expect(retried).toMatchObject({
      duplicate: true,
      events: reconciled.events,
      task: { taskVersion: later.task.taskVersion },
    });
    expect(retried.task.activeReconciliation).toEqual(later.task.activeReconciliation);
    expect(store.inspect()).toMatchObject({ eventCount: 7, lastSequence: 7 });
  });

  it("keeps graph retries idempotent and rolls back invalid graph commands", async () => {
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
    const graph = taskGraph(confirmed);
    const command = {
      eventId: graph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: planned.task.taskVersion,
      previousGraphRevisionId: null,
      graph,
    };
    const committed = store.commitTaskGraph(command);
    const candidate = plan(input.requirement.revisionId);
    store.revisePlan({
      eventId: candidate.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 3,
      expectedTaskVersion: committed.task.taskVersion,
      previousPlanRevisionId: confirmed.revisionId,
      plan: candidate,
    });

    expect(store.commitTaskGraph(command)).toMatchObject({
      duplicate: true,
      task: { taskVersion: 4 },
    });
    const invalidGraph = taskGraph(confirmed);
    expect(() =>
      store.commitTaskGraph({
        ...command,
        eventId: invalidGraph.revisionId,
        expectedTaskVersion: 4,
        previousGraphRevisionId: graph.revisionId,
        graph: {
          ...invalidGraph,
          nodes: invalidGraph.nodes.map((node) => ({
            ...node,
            dependsOnNodeIds: [node.nodeId],
          })),
        },
      }),
    ).toThrowError(TaskPlanError);
    const wrongPlanGraph = {
      ...taskGraph(confirmed),
      basedOnPlanRevisionId: randomUUID(),
    };
    expect(() =>
      store.commitTaskGraph({
        eventId: wrongPlanGraph.revisionId,
        taskId: input.taskId,
        occurredAtMs: input.occurredAtMs + 4,
        expectedTaskVersion: 4,
        previousGraphRevisionId: graph.revisionId,
        graph: wrongPlanGraph,
      }),
    ).toThrowError(TaskPlanError);
    expect(store.inspect()).toMatchObject({ eventCount: 4, lastSequence: 4 });
  });

  it("rebuilds a legacy v1 task projection into the v3 reconciliation-aware shape", async () => {
    const path = await privateDatabasePath();
    const input = createInput();
    const legacyProjection: ProjectionDefinition = {
      name: "task.current_plan",
      version: 1,
      selectKeys: (event) =>
        event.streamType === "task.plan" && event.eventType === "task.created"
          ? [event.streamId]
          : [],
      reduce: ({ event }) => ({
        type: "set",
        state: {
          taskId: input.taskId,
          title: input.title,
          taskVersion: 1,
          createdAtMs: event.occurredAtMs,
          updatedAtMs: event.occurredAtMs,
          activeRequirement: {
            ...input.requirement,
            constraints: [...input.requirement.constraints],
            acceptanceCriteria: [...input.requirement.acceptanceCriteria],
            revisionNumber: 1,
          },
          latestPlan: null,
          confirmedPlan: null,
        },
      }),
    };
    const legacy = await HarnessEventStore.open({ path, projections: [legacyProjection] });
    legacy.append({
      eventId: input.eventId,
      streamType: "task.plan",
      streamId: input.taskId,
      eventType: "task.created",
      eventVersion: 1,
      occurredAtMs: input.occurredAtMs,
      payload: {
        taskId: input.taskId,
        title: input.title,
        requirement: {
          ...input.requirement,
          constraints: [...input.requirement.constraints],
          acceptanceCriteria: [...input.requirement.acceptanceCriteria],
        },
      },
    });
    legacy.close();

    const upgraded = await openStore(path);
    expect(upgraded.readTask(input.taskId)).toMatchObject({
      taskVersion: 1,
      activeGraph: null,
      activeReconciliation: null,
      lastGraphRevisionNumber: 0,
    });
  });

  it("keeps a near-limit requirement, confirmed plan, and graph within the projection budget", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    const largeRequirement = requirement({
      sourceText: "s".repeat(64 * 1024),
      objective: "o".repeat(16 * 1024),
      constraints: Array.from({ length: 40 }, () => "c".repeat(4 * 1024)),
      acceptanceCriteria: Array.from({ length: 2 }, () => "a".repeat(4 * 1024)),
    });
    const input = createInput({
      eventId: largeRequirement.revisionId,
      requirement: largeRequirement,
    });
    const created = store.createTask(input);
    const steps = Array.from({ length: 30 }, (_, index) => ({
      stepId: randomUUID(),
      title: `步骤 ${index + 1}`,
      description: "p".repeat(8 * 1024),
      acceptanceCriteria: ["验证容量"],
    }));
    const confirmed = plan(input.requirement.revisionId, { status: "confirmed", steps });
    const planned = store.revisePlan({
      eventId: confirmed.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 1,
      expectedTaskVersion: created.task.taskVersion,
      previousPlanRevisionId: null,
      plan: confirmed,
    });
    const nodeIds = steps.map(() => randomUUID());
    const graph = {
      revisionId: randomUUID(),
      basedOnPlanRevisionId: confirmed.revisionId,
      nodes: steps.map((step, index) => ({
        nodeId: nodeIds[index]!,
        sourcePlanStepId: step.stepId,
        title: step.title,
        description: "g".repeat(2 * 1024),
        acceptanceCriteria: ["验证组合投影容量"],
        dependsOnNodeIds: index === 0 ? [] : [nodeIds[index - 1]!],
      })),
    };

    const committed = store.commitTaskGraph({
      eventId: graph.revisionId,
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 2,
      expectedTaskVersion: planned.task.taskVersion,
      previousGraphRevisionId: null,
      graph,
    });
    expect(committed.task).toMatchObject({
      taskVersion: 3,
      activeGraph: { revisionId: graph.revisionId },
    });
    const nextRequirement = requirement({
      ...largeRequirement,
      revisionId: randomUUID(),
      sourceText: `t${largeRequirement.sourceText.slice(1)}`,
    });
    const nextPlan = plan(nextRequirement.revisionId, {
      status: "confirmed",
      steps: confirmed.steps,
    });
    const nextGraph = {
      revisionId: randomUUID(),
      basedOnPlanRevisionId: nextPlan.revisionId,
      nodes: graph.nodes.map((node) => ({ ...node })),
    };
    const reconciled = store.reconcileRequirements({
      taskId: input.taskId,
      occurredAtMs: input.occurredAtMs + 3,
      expectedTaskVersion: committed.task.taskVersion,
      previousRequirementRevisionId: largeRequirement.revisionId,
      previousPlanRevisionId: confirmed.revisionId,
      previousGraphRevisionId: graph.revisionId,
      requirement: nextRequirement,
      plan: nextPlan,
      graph: nextGraph,
    });
    expect(reconciled.task).toMatchObject({
      taskVersion: 4,
      activeReconciliation: { impact: "editorial" },
    });
    const projectedBytes = Buffer.byteLength(JSON.stringify(reconciled.task), "utf8");
    expect(projectedBytes).toBeGreaterThan(750 * 1024);
    expect(projectedBytes).toBeLessThan(1024 * 1024);
  });

  it("closes idempotently and rejects later operations", async () => {
    const path = await privateDatabasePath();
    const store = await openStore(path);
    store.close();
    store.close();
    expect(() => store.listTasks()).toThrowError(TaskPlanError);
    expect(() => store.createTask(createInput())).toThrowError(TaskPlanError);
    expect(() => store.readTask("bad")).toThrowError(expect.objectContaining({ code: "closed" }));
  });
});
