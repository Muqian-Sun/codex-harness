import { describe, expect, it } from "vitest";

import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  HARNESS_OPERATION_ROUTE_OBSERVER_POLICY_VERSION,
  HarnessOperationRouteObserverError,
  createHarnessOperationRouteObserver,
  decodeHarnessOperationRouteObservation,
  type HarnessRouteOperationKind,
  type ObserveHarnessOperationRouteInput,
} from "./harness-operation-route-observer.js";

const OBSERVER_ID = uuid(1);
const OTHER_OBSERVER_ID = uuid(2);
const TASK_ID = uuid(10);
const REQUIREMENT_ID = uuid(11);
const PLAN_ID = uuid(12);
const GRAPH_ID = uuid(13);
const NODE_ID = uuid(30);

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function requirementsTask(): TaskPlanRecord {
  return {
    taskId: TASK_ID,
    title: "Harness operation route observer",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Observe one closed operation manifest.",
      objective: "Derive deterministic Harness route evidence.",
      constraints: ["The manifest is not a runtime execution gate."],
      acceptanceCriteria: ["Decoded JSON never recovers observer authority."],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
  };
}

function graphTask(): TaskPlanRecord {
  const step = {
    stepId: uuid(20),
    title: "Observe operations",
    description: "Classify a bounded operation plan.",
    acceptanceCriteria: ["Evidence is deterministic."],
  };
  const plan = {
    revisionId: PLAN_ID,
    revisionNumber: 1,
    status: "confirmed" as const,
    basedOnRequirementRevisionId: REQUIREMENT_ID,
    steps: [step],
  };
  return {
    ...requirementsTask(),
    taskVersion: 3,
    updatedAtMs: 300,
    latestPlan: plan,
    confirmedPlan: plan,
    activeGraph: {
      revisionId: GRAPH_ID,
      revisionNumber: 1,
      basedOnPlanRevisionId: PLAN_ID,
      nodes: [
        {
          nodeId: NODE_ID,
          sourcePlanStepId: step.stepId,
          title: step.title,
          description: step.description,
          acceptanceCriteria: step.acceptanceCriteria,
          dependsOnNodeIds: [],
          status: "pending" as const,
        },
      ],
      topologicalOrder: [NODE_ID],
    },
    lastGraphRevisionNumber: 1,
  };
}

function createObserver(observerSessionId = OBSERVER_ID, suffix = "v1") {
  return createHarnessOperationRouteObserver({
    schemaVersion: 1,
    observerSessionId,
    policySet: {
      taskClassifier: `task-classifier.${suffix}`,
      toolPlanner: `tool-planner.${suffix}`,
      operationPlan: `operation-plan.${suffix}`,
    },
  });
}

function manifest(
  kinds: readonly HarnessRouteOperationKind[],
  manifestNumber = 100,
  observedAtMs = 300,
): ObserveHarnessOperationRouteInput {
  return {
    schemaVersion: 1,
    manifestId: uuid(manifestNumber),
    observedAtMs,
    operations: kinds.map((kind, index) => ({
      operationId: uuid(manifestNumber * 100 + index),
      kind,
    })),
  };
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

describe("Harness closed operation route observer", () => {
  it("derives a complete non-executable simple route observation", () => {
    const observer = createObserver();
    const task = graphTask();
    const observation = observer.observe(task, NODE_ID, manifest(["answer"]));

    expect(observation).toMatchObject({
      schemaVersion: 1,
      mode: "shadow",
      executionAuthorized: false,
      policyVersion: HARNESS_OPERATION_ROUTE_OBSERVER_POLICY_VERSION,
      observerSessionId: OBSERVER_ID,
      observerPolicySet: {
        taskClassifier: "task-classifier.v1",
        toolPlanner: "tool-planner.v1",
        operationPlan: "operation-plan.v1",
      },
      manifestId: uuid(100),
      observedAtMs: 300,
      subject: { taskId: TASK_ID, taskVersion: 3, nodeId: NODE_ID },
      routeEvidence: {
        taskClassification: {
          source: "harness_task_classifier",
          policyVersion: "task-classifier.v1",
          taskKind: "simple",
        },
        toolPlan: {
          source: "harness_tool_planner",
          policyVersion: "tool-planner.v1",
          complete: true,
          tools: [],
        },
        operationPlanSafetyReport: {
          source: "operation_plan",
          policyVersion: "operation-plan.v1",
        },
      },
    });
    expect(Object.values(observation.routeEvidence.operationPlanSafetyReport.observations)).toEqual(
      Array(6).fill("absent"),
    );
    expect(observation.observationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(observer.isVerified(observation)).toBe(true);
    expect(observer.isCurrent(task, observation)).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.observerPolicySet)).toBe(true);
    expect(Object.isFrozen(observation.operations)).toBe(true);
    expect(Object.isFrozen(observation.operations[0])).toBe(true);
    expect(Object.isFrozen(observation.routeEvidence)).toBe(true);
    expect(Object.isFrozen(observation.routeEvidence.toolPlan.tools)).toBe(true);
    expect(Object.isFrozen(observation.routeEvidence.operationPlanSafetyReport.observations)).toBe(
      true,
    );
  });

  it("applies the fixed task-kind priority", () => {
    const observer = createObserver();
    const cases: readonly [readonly HarnessRouteOperationKind[], string][] = [
      [["answer", "user_interaction"], "simple"],
      [["inspect_workspace", "external_write"], "analysis"],
      [["network_read", "modify_workspace"], "code_change"],
      [["modify_workspace", "architecture_decision"], "architecture"],
      [["architecture_decision", "systemic_diagnosis"], "systemic_diagnosis"],
    ];

    for (const [index, [kinds, expected]] of cases.entries()) {
      const observation = observer.observe(graphTask(), null, manifest(kinds, 110 + index));
      expect(observation.routeEvidence.taskClassification.taskKind).toBe(expected);
    }
  });

  it("maps every operation to a conservative, normalized tool union", () => {
    const observer = createObserver();
    const cases: readonly [HarnessRouteOperationKind, readonly string[]][] = [
      ["answer", []],
      ["inspect_workspace", ["workspace_read"]],
      ["modify_workspace", ["workspace_write"]],
      ["run_workspace_command", ["command_execution"]],
      ["network_read", ["network_access"]],
      ["credential_access", ["credential_access"]],
      ["external_write", ["network_access", "external_write"]],
      ["database_migration", ["workspace_write", "command_execution"]],
      ["production_change", ["network_access", "external_write"]],
      [
        "irreversible_action",
        ["workspace_write", "command_execution", "network_access", "external_write"],
      ],
      ["permission_boundary_change", ["workspace_write"]],
      ["public_api_change", ["workspace_write"]],
      ["concurrent_change", ["workspace_write"]],
      ["architecture_decision", ["workspace_read"]],
      ["systemic_diagnosis", ["workspace_read", "command_execution"]],
      ["user_interaction", ["user_interaction"]],
    ];

    for (const [index, [kind, tools]] of cases.entries()) {
      const observation = observer.observe(graphTask(), null, manifest([kind], 130 + index));
      expect(observation.routeEvidence.toolPlan.tools).toEqual(tools);
    }

    const union = observer.observe(
      graphTask(),
      null,
      manifest(
        [
          "user_interaction",
          "external_write",
          "credential_access",
          "systemic_diagnosis",
          "irreversible_action",
        ],
        150,
      ),
    );
    expect(union.routeEvidence.toolPlan.tools).toEqual([
      "workspace_read",
      "workspace_write",
      "command_execution",
      "network_access",
      "credential_access",
      "external_write",
      "user_interaction",
    ]);
  });

  it("maps all six operation-plan safety signals independently", () => {
    const observer = createObserver();
    const cases = [
      ["concurrent_change", "concurrencySensitive"],
      ["database_migration", "dataMigration"],
      ["irreversible_action", "irreversibleOperation"],
      ["permission_boundary_change", "permissionBoundaryChange"],
      ["production_change", "productionImpact"],
      ["public_api_change", "publicApiChange"],
    ] as const;

    for (const [index, [kind, signal]] of cases.entries()) {
      const observation = observer.observe(graphTask(), null, manifest([kind], 160 + index));
      const values = observation.routeEvidence.operationPlanSafetyReport.observations;
      expect(values[signal]).toBe("present");
      expect(Object.entries(values).filter(([, value]) => value === "present")).toEqual([
        [signal, "present"],
      ]);
    }
  });

  it("rejects non-closed, duplicate, oversized, and non-exact manifests", () => {
    const observer = createObserver();
    const valid = manifest(["answer"]);
    const duplicate = {
      ...clone(valid),
      operations: [...valid.operations, clone(valid.operations[0]!)],
    };
    const oversized = manifest(
      Array.from({ length: 257 }, () => "answer" as const),
      200,
    );
    const extraOperation = clone(valid) as unknown as {
      operations: Array<Record<string, unknown>>;
    };
    extraOperation.operations[0]!.description = "untrusted";
    const invalid = [
      { ...valid, operations: [] },
      duplicate,
      oversized,
      { ...valid, operations: [{ operationId: uuid(500), kind: "unknown" }] },
      extraOperation,
      { ...valid, extra: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, observedAtMs: -1 },
    ];

    for (const candidate of invalid) {
      expect(() => observer.observe(graphTask(), null, candidate as never)).toThrowError(
        expect.objectContaining({ code: "invalid_manifest" }),
      );
    }
  });

  it("binds observations to current Task, DAG node, and observation time", () => {
    const observer = createObserver();
    const task = graphTask();
    const observation = observer.observe(task, NODE_ID, manifest(["answer"]));

    expect(() => observer.observe(task, uuid(999), manifest(["answer"]))).toThrowError(
      expect.objectContaining({ code: "node_not_found" }),
    );
    expect(() => observer.observe(task, NODE_ID, manifest(["answer"], 100, 299))).toThrowError(
      expect.objectContaining({ code: "stale_observation" }),
    );
    expect(observer.isCurrent({ ...task, taskVersion: 4 }, observation)).toBe(false);
    expect(
      observer.isCurrent(
        {
          ...task,
          activeRequirement: { ...task.activeRequirement, objective: "Changed objective." },
        },
        observation,
      ),
    ).toBe(false);
    expect(observer.isCurrent({ ...task, updatedAtMs: 301 }, observation)).toBe(false);
    expect(() =>
      observer.observe({ ...task, updatedAtMs: Number.NaN }, NODE_ID, manifest(["answer"])),
    ).toThrowError(expect.objectContaining({ code: "invalid_task" }));
  });

  it("keeps observer authority process-local and policy-bound", () => {
    const observer = createObserver();
    const otherSession = createObserver(OTHER_OBSERVER_ID);
    const otherPolicy = createObserver(OBSERVER_ID, "v2");
    const task = graphTask();
    const observation = observer.observe(task, null, manifest(["answer"]));
    const decoded = decodeHarnessOperationRouteObservation(clone(observation));

    expect(otherSession.isVerified(observation)).toBe(false);
    expect(otherPolicy.isVerified(observation)).toBe(false);
    expect(otherSession.isCurrent(task, observation)).toBe(false);
    expect(otherPolicy.isCurrent(task, observation)).toBe(false);
    expect(observer.isVerified(decoded)).toBe(false);
    expect(observer.isCurrent(task, decoded)).toBe(false);
    expect(decoded).toEqual(observation);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it("defensively copies inputs and produces deterministic, tamper-evident snapshots", () => {
    const observer = createObserver();
    const task = graphTask();
    const input = manifest(["network_read", "modify_workspace"]);
    const first = observer.observe(task, null, input);
    const second = observer.observe(task, null, clone(input));
    (input.operations as Array<{ operationId: string; kind: HarnessRouteOperationKind }>)[0]!.kind =
      "answer";

    expect(first).toEqual(second);
    expect(first.observationDigest).toBe(second.observationDigest);
    expect(first.operations[0]?.kind).toBe("network_read");

    const tampered = clone(first) as unknown as {
      routeEvidence: { taskClassification: { taskKind: string } };
    };
    tampered.routeEvidence.taskClassification.taskKind = "simple";
    expect(() => decodeHarnessOperationRouteObservation(tampered)).toThrowError(
      expect.objectContaining({ code: "invalid_snapshot" }),
    );
  });

  it("strictly validates observer configuration and serialized snapshots", () => {
    const invalidConfigs = [
      null,
      {},
      {
        schemaVersion: 2,
        observerSessionId: OBSERVER_ID,
        policySet: {
          taskClassifier: "task-classifier.v1",
          toolPlanner: "tool-planner.v1",
          operationPlan: "operation-plan.v1",
        },
      },
      {
        schemaVersion: 1,
        observerSessionId: "invalid",
        policySet: {
          taskClassifier: "task-classifier.v1",
          toolPlanner: "tool-planner.v1",
          operationPlan: "operation-plan.v1",
        },
      },
      {
        schemaVersion: 1,
        observerSessionId: OBSERVER_ID,
        policySet: {
          taskClassifier: "INVALID POLICY",
          toolPlanner: "tool-planner.v1",
          operationPlan: "operation-plan.v1",
        },
      },
    ];

    for (const candidate of invalidConfigs) {
      expect(() => createHarnessOperationRouteObserver(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_observer" }),
      );
    }

    const observation = createObserver().observe(graphTask(), null, manifest(["answer"]));
    const invalidSnapshots = [
      null,
      { ...clone(observation), extra: true },
      { ...clone(observation), executionAuthorized: true },
      { ...clone(observation), observerSessionId: "invalid" },
      { ...clone(observation), observationDigest: "0".repeat(64) },
      {
        ...clone(observation),
        observerPolicySet: { ...observation.observerPolicySet, operationPlan: "operation-plan.v2" },
      },
    ];

    for (const candidate of invalidSnapshots) {
      expect(() => decodeHarnessOperationRouteObservation(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
    }
  });

  it("exposes stable typed errors", () => {
    const error = new HarnessOperationRouteObserverError("invalid_manifest");
    expect(error.name).toBe("HarnessOperationRouteObserverError");
    expect(error.code).toBe("invalid_manifest");
    expect(error.message).toBe("The closed Harness operation manifest is invalid.");
  });
});
