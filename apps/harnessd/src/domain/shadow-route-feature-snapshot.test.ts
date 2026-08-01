import { describe, expect, it } from "vitest";

import type { ModelRouteFeatures } from "./model-route-classifier.js";
import type { PlanRevision, TaskPlanRecord } from "./task-plan-store.js";
import {
  MODEL_ROUTE_SAFETY_SIGNAL_NAMES,
  SHADOW_ROUTE_FEATURE_POLICY_VERSION,
  ShadowRouteFeatureSnapshotError,
  buildShadowRouteFeatureSnapshot,
  decodeShadowRouteFeatureSnapshot,
  isShadowRouteFeatureSnapshotCurrent,
  type ShadowRouteFeatureCandidate,
} from "./shadow-route-feature-snapshot.js";

const TASK_ID = uuid(1);
const REQUIREMENT_ID = uuid(2);
const CONFIRMED_PLAN_ID = uuid(3);
const CANDIDATE_PLAN_ID = uuid(4);
const GRAPH_ID = uuid(5);

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function plan(
  status: "candidate" | "confirmed",
  count: number,
  revisionId = status === "confirmed" ? CONFIRMED_PLAN_ID : CANDIDATE_PLAN_ID,
): PlanRevision {
  return {
    revisionId,
    revisionNumber: status === "confirmed" ? 1 : 2,
    status,
    basedOnRequirementRevisionId: REQUIREMENT_ID,
    steps: Array.from({ length: count }, (_, index) => ({
      stepId: uuid(100 + index),
      title: `Step ${index + 1}`,
      description: `Execute bounded work unit ${index + 1}.`,
      acceptanceCriteria: [`Evidence ${index + 1}`],
    })),
  };
}

function requirementsTask(overrides: Partial<TaskPlanRecord> = {}): TaskPlanRecord {
  return {
    taskId: TASK_ID,
    title: "Authoritative route feature snapshot",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Build route features without trusting low-risk self reports.",
      objective: "Bind route features to current Harness task state.",
      constraints: ["Unknown safety remains conservative."],
      acceptanceCriteria: ["A stale snapshot is rejected."],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
    ...overrides,
  };
}

function confirmedTask(stepCount = 2, withGraph = false): TaskPlanRecord {
  const confirmed = plan("confirmed", stepCount);
  return requirementsTask({
    taskVersion: withGraph ? 3 : 2,
    updatedAtMs: withGraph ? 103 : 102,
    latestPlan: confirmed,
    confirmedPlan: confirmed,
    activeGraph: withGraph
      ? {
          revisionId: GRAPH_ID,
          revisionNumber: 1,
          basedOnPlanRevisionId: confirmed.revisionId,
          nodes: confirmed.steps.map((step, index) => ({
            nodeId: uuid(200 + index),
            sourcePlanStepId: step.stepId,
            title: step.title,
            description: step.description,
            acceptanceCriteria: step.acceptanceCriteria,
            dependsOnNodeIds: index === 0 ? [] : [uuid(200 + index - 1)],
            status: "pending" as const,
          })),
          topologicalOrder: confirmed.steps.map((_, index) => uuid(200 + index)),
        }
      : null,
    lastGraphRevisionNumber: withGraph ? 1 : 0,
  });
}

function candidateTask(stepCount = 2): TaskPlanRecord {
  const candidate = plan("candidate", stepCount);
  return requirementsTask({
    taskVersion: 2,
    updatedAtMs: 102,
    latestPlan: candidate,
  });
}

function activeGraphWithCandidate(): TaskPlanRecord {
  const active = confirmedTask(2, true);
  return { ...active, taskVersion: 4, updatedAtMs: 104, latestPlan: plan("candidate", 3) };
}

function confirmedPlanWithCandidate(): TaskPlanRecord {
  const active = confirmedTask(2, false);
  return { ...active, taskVersion: 3, updatedAtMs: 103, latestPlan: plan("candidate", 3) };
}

function features(overrides: Partial<ModelRouteFeatures> = {}): ModelRouteFeatures {
  return {
    schemaVersion: 1,
    taskKind: "simple",
    complexity: "low",
    scope: "isolated",
    ambiguity: "low",
    estimatedSteps: 1,
    toolBreadth: "none",
    safety: {
      securitySensitive: false,
      dataMigration: false,
      concurrencySensitive: false,
      publicApiChange: false,
      productionImpact: false,
      irreversibleOperation: false,
      permissionBoundaryChange: false,
    },
    ...overrides,
  };
}

function advisory(
  featureOverrides: Partial<ModelRouteFeatures> = {},
  source: "user" | "model" = "model",
): ShadowRouteFeatureCandidate {
  return { source, features: features(featureOverrides) };
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

describe("shadow route feature snapshot", () => {
  it("builds a conservative requirement-only baseline from the authoritative task fence", () => {
    const snapshot = buildShadowRouteFeatureSnapshot(requirementsTask());

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      mode: "shadow",
      executionAuthorized: false,
      policyVersion: SHADOW_ROUTE_FEATURE_POLICY_VERSION,
      subject: { taskId: TASK_ID, taskVersion: 1, nodeId: null },
      structure: {
        phase: "requirements_only",
        requirementItemCount: 2,
        authoritativePlanStepCount: 0,
        candidatePlanStepCount: 0,
        graphNodeCount: 0,
        dependencyCount: 0,
        subjectDependencyClosureCount: null,
      },
      candidate: null,
      effectiveFeatures: {
        taskKind: "analysis",
        complexity: "low",
        scope: "isolated",
        ambiguity: "high",
        estimatedSteps: 1,
        toolBreadth: "multiple",
      },
      provenance: {
        taskKind: "policy_standard_floor",
        complexity: "task_structure",
        scope: "task_structure",
        ambiguity: "task_structure",
        estimatedSteps: "task_structure",
        toolBreadth: "policy_standard_floor",
      },
      unresolvedSafetySignals: MODEL_ROUTE_SAFETY_SIGNAL_NAMES,
      routingFloorTier: "deep",
    });
    expect(snapshot.featureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.taskFence.taskId).toBe(TASK_ID);
  });

  it("derives every supported Task phase without treating a candidate as authoritative", () => {
    const cases = [
      [requirementsTask(), "requirements_only"],
      [candidateTask(), "candidate_plan"],
      [confirmedPlanWithCandidate(), "candidate_plan"],
      [confirmedTask(), "confirmed_plan_pending_graph"],
      [confirmedTask(2, true), "active_graph"],
      [activeGraphWithCandidate(), "active_graph_with_candidate"],
    ] as const;

    for (const [task, phase] of cases) {
      expect(buildShadowRouteFeatureSnapshot(task).structure.phase).toBe(phase);
    }
    expect(
      buildShadowRouteFeatureSnapshot(activeGraphWithCandidate()).effectiveFeatures,
    ).toMatchObject({
      ambiguity: "medium",
      estimatedSteps: 3,
    });
    const pendingCandidate = buildShadowRouteFeatureSnapshot(confirmedPlanWithCandidate());
    expect(pendingCandidate.structure).toMatchObject({
      phase: "candidate_plan",
      authoritativePlanStepCount: 2,
      candidatePlanStepCount: 3,
    });
    expect(decodeShadowRouteFeatureSnapshot(clone(pendingCandidate))).toEqual(pendingCandidate);
  });

  it("prevents a low advisory candidate from lowering structural and policy floors", () => {
    const snapshot = buildShadowRouteFeatureSnapshot(candidateTask(9), null, advisory());

    expect(snapshot.effectiveFeatures).toMatchObject({
      taskKind: "analysis",
      complexity: "high",
      scope: "module",
      ambiguity: "high",
      estimatedSteps: 9,
      toolBreadth: "multiple",
    });
    expect(snapshot.provenance).toMatchObject({
      taskKind: "policy_standard_floor",
      complexity: "task_structure",
      scope: "task_structure",
      ambiguity: "task_structure",
      estimatedSteps: "task_structure",
      toolBreadth: "policy_standard_floor",
    });
  });

  it("accepts only non-lowering advisory raises and keeps source labels permission-neutral", () => {
    const candidateFeatures = features({
      taskKind: "architecture",
      complexity: "high",
      scope: "cross_system",
      ambiguity: "high",
      estimatedSteps: 12,
      toolBreadth: "extensive",
      safety: { ...features().safety, permissionBoundaryChange: true },
    });
    const fromModel = buildShadowRouteFeatureSnapshot(confirmedTask(2, true), null, {
      source: "model",
      features: candidateFeatures,
    });
    const fromUser = buildShadowRouteFeatureSnapshot(confirmedTask(2, true), null, {
      source: "user",
      features: candidateFeatures,
    });

    expect(fromModel.effectiveFeatures).toMatchObject({
      taskKind: "architecture",
      complexity: "high",
      scope: "cross_system",
      ambiguity: "high",
      estimatedSteps: 12,
      toolBreadth: "extensive",
      safety: { permissionBoundaryChange: true },
    });
    expect(fromModel.provenance).toMatchObject({
      taskKind: "candidate_non_lowering",
      complexity: "candidate_non_lowering",
      scope: "candidate_non_lowering",
      ambiguity: "candidate_non_lowering",
      estimatedSteps: "candidate_non_lowering",
      toolBreadth: "candidate_non_lowering",
      safety: { permissionBoundaryChange: "candidate_risk_floor" },
    });
    expect(fromModel.unresolvedSafetySignals).not.toContain("permissionBoundaryChange");
    expect(fromModel.unresolvedSafetySignals).toHaveLength(6);
    expect(fromUser.effectiveFeatures).toEqual(fromModel.effectiveFeatures);
    expect(fromUser.routingFloorTier).toBe("deep");
    expect(fromUser.executionAuthorized).toBe(false);
  });

  it("binds a node subject to the current graph and records its dependency closure", () => {
    const task = confirmedTask(3, true);
    const subjectNodeId = uuid(202);
    const snapshot = buildShadowRouteFeatureSnapshot(task, subjectNodeId);

    expect(snapshot.subject.nodeId).toBe(subjectNodeId);
    expect(snapshot.structure.subjectDependencyClosureCount).toBe(3);
    expect(snapshot.effectiveFeatures.estimatedSteps).toBe(1);
    expect(() => buildShadowRouteFeatureSnapshot(task, uuid(999))).toThrowError(
      expect.objectContaining({ code: "node_not_found" }),
    );
    expect(() => buildShadowRouteFeatureSnapshot(requirementsTask(), uuid(200))).toThrowError(
      expect.objectContaining({ code: "node_not_found" }),
    );
  });

  it("rejects graph counts that bypass the authoritative Task domain budget", () => {
    const task = confirmedTask(200, true);
    const denseGraph = {
      ...task.activeGraph!,
      nodes: task.activeGraph!.nodes.map((node, index, nodes) => ({
        ...node,
        dependsOnNodeIds: nodes.slice(0, index).map((dependency) => dependency.nodeId),
      })),
    };
    const denseTask = { ...task, activeGraph: denseGraph };

    expect(() => buildShadowRouteFeatureSnapshot(denseTask, uuid(399))).toThrowError(
      expect.objectContaining({ code: "invalid_task" }),
    );
  });

  it("is deterministic, deeply frozen, strictly decodable, and current only for the same task", () => {
    const task = confirmedTask(2, true);
    const candidate = advisory({ taskKind: "code_change" }, "user");
    const first = buildShadowRouteFeatureSnapshot(task, uuid(201), candidate);
    const second = buildShadowRouteFeatureSnapshot(task, uuid(201), candidate);
    (candidate.features as { taskKind: string }).taskKind = "architecture";

    expect(first).toEqual(second);
    expect(first.candidate?.features.taskKind).toBe("code_change");
    expect(decodeShadowRouteFeatureSnapshot(clone(first))).toEqual(first);
    expect(isShadowRouteFeatureSnapshotCurrent(task, clone(first))).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.subject)).toBe(true);
    expect(Object.isFrozen(first.taskFence)).toBe(true);
    expect(Object.isFrozen(first.structure)).toBe(true);
    expect(Object.isFrozen(first.candidate)).toBe(true);
    expect(Object.isFrozen(first.candidate?.features)).toBe(true);
    expect(Object.isFrozen(first.effectiveFeatures.safety)).toBe(true);
    expect(Object.isFrozen(first.provenance.safety)).toBe(true);
    expect(Object.isFrozen(first.unresolvedSafetySignals)).toBe(true);

    const revised = {
      ...task,
      taskVersion: task.taskVersion + 1,
      updatedAtMs: task.updatedAtMs + 1,
      activeRequirement: {
        ...task.activeRequirement,
        sourceText: `${task.activeRequirement.sourceText} Revised.`,
      },
    };
    expect(isShadowRouteFeatureSnapshotCurrent(revised, first)).toBe(false);
    const contentChangedWithoutVersion = {
      ...task,
      activeRequirement: {
        ...task.activeRequirement,
        sourceText: `${task.activeRequirement.sourceText} Digest-only change.`,
      },
    };
    expect(isShadowRouteFeatureSnapshotCurrent(contentChangedWithoutVersion, first)).toBe(false);
  });

  it("rejects any serialized mutation even when the attacker keeps the old digest", () => {
    const valid = buildShadowRouteFeatureSnapshot(confirmedTask(2, true), null, advisory());
    const invalid = [
      { ...clone(valid), extra: true },
      { ...clone(valid), mode: "active" },
      { ...clone(valid), executionAuthorized: true },
      { ...clone(valid), routingFloorTier: "fast" },
      { ...clone(valid), featureDigest: "0".repeat(64) },
      {
        ...clone(valid),
        subject: { ...valid.subject, taskVersion: valid.subject.taskVersion + 1 },
      },
      {
        ...clone(valid),
        structure: { ...valid.structure, graphNodeCount: 0 },
      },
      {
        ...clone(valid),
        effectiveFeatures: { ...valid.effectiveFeatures, taskKind: "simple" },
      },
      {
        ...clone(valid),
        provenance: { ...valid.provenance, taskKind: "task_structure" },
      },
      {
        ...clone(valid),
        unresolvedSafetySignals: [],
      },
    ];
    for (const snapshot of invalid) {
      expect(() => decodeShadowRouteFeatureSnapshot(snapshot)).toThrowError(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
    }
  });

  it("rejects malformed advisory candidates and invalid task sources with fixed errors", () => {
    const invalidCandidates = [
      {},
      { source: "system", features: features() },
      { source: "model", features: { ...features(), taskKind: "unknown" } },
      { source: "model", features: features(), extra: true },
    ];
    const accessorCandidate = { features: features() } as Record<string, unknown>;
    Object.defineProperty(accessorCandidate, "source", {
      enumerable: true,
      get: () => "model",
    });
    invalidCandidates.push(accessorCandidate);
    for (const candidate of invalidCandidates) {
      expect(() =>
        buildShadowRouteFeatureSnapshot(requirementsTask(), null, candidate as never),
      ).toThrowError(expect.objectContaining({ code: "invalid_candidate" }));
    }

    expect(() =>
      buildShadowRouteFeatureSnapshot({
        ...requirementsTask(),
        activeRequirement: { ...requirementsTask().activeRequirement, revisionId: "invalid" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_task" }));
    expect(() => decodeShadowRouteFeatureSnapshot(null)).toThrowError(
      ShadowRouteFeatureSnapshotError,
    );
    expect(isShadowRouteFeatureSnapshotCurrent(requirementsTask(), {})).toBe(false);
  });
});
