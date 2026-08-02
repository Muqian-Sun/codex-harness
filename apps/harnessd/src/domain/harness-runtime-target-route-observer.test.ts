import { describe, expect, it } from "vitest";

import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  HARNESS_RUNTIME_TARGET_ROUTE_OBSERVER_POLICY_VERSION,
  HarnessRuntimeTargetRouteObserverError,
  createHarnessRuntimeTargetRouteObserver,
  decodeHarnessRuntimeTargetRouteObservation,
  type HarnessRuntimeEnvironmentClass,
  type ObserveHarnessRuntimeTargetRouteInput,
} from "./harness-runtime-target-route-observer.js";

const OBSERVER_ID = uuid(1);
const OTHER_OBSERVER_ID = uuid(2);
const TASK_ID = uuid(10);
const REQUIREMENT_ID = uuid(11);
const PLAN_ID = uuid(12);
const GRAPH_ID = uuid(13);
const NODE_ID = uuid(30);
const INVENTORY_DIGEST = "c".repeat(64);

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function requirementsTask(): TaskPlanRecord {
  return {
    taskId: TASK_ID,
    title: "Harness runtime target route observer",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Observe one complete runtime target plan.",
      objective: "Derive deterministic runtime-target route evidence.",
      constraints: ["The observer cannot prove that the runtime inventory is still current."],
      acceptanceCriteria: ["Production impact is derived from fixed environment classes."],
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
    title: "Observe runtime targets",
    description: "Classify a bounded complete runtime target plan.",
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
  return createHarnessRuntimeTargetRouteObserver({
    schemaVersion: 1,
    observerSessionId,
    policySet: { runtimeTarget: `runtime-target.${suffix}` },
  });
}

function runtimeTargetPlan(
  environmentClasses: readonly HarnessRuntimeEnvironmentClass[],
  planNumber = 100,
  observedAtMs = 300,
  runtimeInventoryDigest = INVENTORY_DIGEST,
): ObserveHarnessRuntimeTargetRouteInput {
  return {
    schemaVersion: 1,
    runtimeTargetPlanId: uuid(planNumber),
    runtimeInventorySnapshotId: uuid(planNumber + 1_000),
    runtimeInventoryDigest,
    observedAtMs,
    complete: true,
    targets: environmentClasses.map((environmentClass, index) => ({
      runtimeTargetId: uuid(planNumber * 1_000 + index),
      environmentClass,
    })),
  };
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

describe("Harness complete runtime target route observer", () => {
  it("issues a verified non-executable report for a complete empty target plan", () => {
    const observer = createObserver();
    const task = graphTask();
    const observation = observer.observe(task, NODE_ID, runtimeTargetPlan([]));

    expect(observation).toMatchObject({
      schemaVersion: 1,
      mode: "shadow",
      executionAuthorized: false,
      policyVersion: HARNESS_RUNTIME_TARGET_ROUTE_OBSERVER_POLICY_VERSION,
      observerSessionId: OBSERVER_ID,
      observerPolicySet: { runtimeTarget: "runtime-target.v1" },
      runtimeTargetPlanId: uuid(100),
      runtimeInventorySnapshotId: uuid(1_100),
      runtimeInventoryDigest: INVENTORY_DIGEST,
      observedAtMs: 300,
      complete: true,
      subject: { taskId: TASK_ID, taskVersion: 3, nodeId: NODE_ID },
      targets: [],
      runtimeTargetSafetyReport: {
        source: "runtime_target",
        policyVersion: "runtime-target.v1",
        observations: { productionImpact: "absent" },
      },
    });
    expect(observation.observationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(observer.isVerified(observation)).toBe(true);
    expect(observer.isCurrent(task, observation)).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.observerPolicySet)).toBe(true);
    expect(Object.isFrozen(observation.targets)).toBe(true);
    expect(Object.isFrozen(observation.runtimeTargetSafetyReport)).toBe(true);
    expect(Object.isFrozen(observation.runtimeTargetSafetyReport.observations)).toBe(true);
  });

  it("keeps all fixed non-production environment classes absent", () => {
    const environmentClasses = ["local", "ephemeral", "development", "test", "staging"] as const;

    for (const [index, environmentClass] of environmentClasses.entries()) {
      const observation = createObserver().observe(
        graphTask(),
        null,
        runtimeTargetPlan([environmentClass], 110 + index),
      );
      expect(observation.runtimeTargetSafetyReport.observations.productionImpact).toBe("absent");
    }
  });

  it("derives production impact from every fixed production environment class", () => {
    const environmentClasses = [
      "production",
      "production_control_plane",
      "customer_production",
    ] as const;

    for (const [index, environmentClass] of environmentClasses.entries()) {
      const observation = createObserver().observe(
        graphTask(),
        null,
        runtimeTargetPlan([environmentClass], 120 + index),
      );
      expect(observation.runtimeTargetSafetyReport.observations.productionImpact).toBe("present");
    }
  });

  it("derives a stable mixed report without caller-supplied booleans", () => {
    const input = runtimeTargetPlan(["local", "staging", "production_control_plane", "test"], 130);
    const observer = createObserver();
    const first = observer.observe(graphTask(), null, input);
    const second = observer.observe(graphTask(), null, clone(input));

    expect(first.runtimeTargetSafetyReport.observations).toEqual({
      productionImpact: "present",
    });
    expect(first).toEqual(second);
    expect(first.observationDigest).toBe(second.observationDigest);
  });

  it("accepts exactly 128 unique targets and rejects the 129th", () => {
    const observer = createObserver();
    const accepted = observer.observe(
      graphTask(),
      null,
      runtimeTargetPlan(
        Array.from({ length: 128 }, () => "local" as const),
        140,
      ),
    );
    const oversized = runtimeTargetPlan(
      Array.from({ length: 129 }, () => "local" as const),
      141,
    );

    expect(accepted.targets).toHaveLength(128);
    expect(Object.isFrozen(accepted.targets[127])).toBe(true);
    expect(() => observer.observe(graphTask(), null, oversized)).toThrowError(
      expect.objectContaining({ code: "invalid_runtime_target_plan" }),
    );
  });

  it("rejects incomplete, duplicate, unknown, and non-exact runtime target plans", () => {
    const observer = createObserver();
    const valid = runtimeTargetPlan(["staging"]);
    const duplicate = {
      ...clone(valid),
      targets: [...valid.targets, clone(valid.targets[0]!)],
    };
    const extraTarget = clone(valid) as unknown as {
      targets: Array<Record<string, unknown>>;
    };
    extraTarget.targets[0]!.hostname = "sensitive.example";
    const missingComplete = clone(valid) as unknown as Record<string, unknown>;
    delete missingComplete.complete;
    const invalid = [
      { ...valid, complete: false },
      missingComplete,
      duplicate,
      { ...valid, runtimeInventoryDigest: INVENTORY_DIGEST.toUpperCase() },
      { ...valid, runtimeInventorySnapshotId: "invalid" },
      {
        ...valid,
        targets: [{ runtimeTargetId: uuid(500), environmentClass: "unknown" }],
      },
      extraTarget,
      { ...valid, extra: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, observedAtMs: -1 },
    ];

    for (const candidate of invalid) {
      expect(() => observer.observe(graphTask(), null, candidate as never)).toThrowError(
        expect.objectContaining({ code: "invalid_runtime_target_plan" }),
      );
    }
  });

  it("binds observations to current Task, DAG node, and observation time", () => {
    const observer = createObserver();
    const task = graphTask();
    const observation = observer.observe(task, NODE_ID, runtimeTargetPlan([]));

    expect(() => observer.observe(task, uuid(999), runtimeTargetPlan([]))).toThrowError(
      expect.objectContaining({ code: "node_not_found" }),
    );
    expect(() => observer.observe(task, NODE_ID, runtimeTargetPlan([], 100, 299))).toThrowError(
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
      observer.observe({ ...task, updatedAtMs: Number.NaN }, NODE_ID, runtimeTargetPlan([])),
    ).toThrowError(expect.objectContaining({ code: "invalid_task" }));
  });

  it("keeps observer authority process-local and policy-bound", () => {
    const observer = createObserver();
    const otherSession = createObserver(OTHER_OBSERVER_ID);
    const otherPolicy = createObserver(OBSERVER_ID, "v2");
    const task = graphTask();
    const observation = observer.observe(task, null, runtimeTargetPlan(["production"]));
    const decoded = decodeHarnessRuntimeTargetRouteObservation(clone(observation));

    expect(otherSession.isVerified(observation)).toBe(false);
    expect(otherPolicy.isVerified(observation)).toBe(false);
    expect(otherSession.isCurrent(task, observation)).toBe(false);
    expect(otherPolicy.isCurrent(task, observation)).toBe(false);
    expect(observer.isVerified(decoded)).toBe(false);
    expect(observer.isCurrent(task, decoded)).toBe(false);
    expect(decoded).toEqual(observation);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.targets[0])).toBe(true);
  });

  it("defensively copies targets and rejects tampered derived snapshots", () => {
    const observer = createObserver();
    const input = runtimeTargetPlan(["staging", "production"]);
    const observation = observer.observe(graphTask(), null, input);
    (
      input.targets as Array<{
        runtimeTargetId: string;
        environmentClass: HarnessRuntimeEnvironmentClass;
      }>
    )[0]!.environmentClass = "customer_production";

    expect(observation.targets[0]?.environmentClass).toBe("staging");

    const tampered = clone(observation) as unknown as {
      runtimeTargetSafetyReport: { observations: { productionImpact: string } };
    };
    tampered.runtimeTargetSafetyReport.observations.productionImpact = "absent";
    expect(() => decodeHarnessRuntimeTargetRouteObservation(tampered)).toThrowError(
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
        policySet: { runtimeTarget: "runtime-target.v1" },
      },
      {
        schemaVersion: 1,
        observerSessionId: "invalid",
        policySet: { runtimeTarget: "runtime-target.v1" },
      },
      {
        schemaVersion: 1,
        observerSessionId: OBSERVER_ID,
        policySet: { runtimeTarget: "INVALID POLICY" },
      },
      {
        schemaVersion: 1,
        observerSessionId: OBSERVER_ID,
        policySet: { runtimeTarget: "runtime-target.v1", extra: true },
      },
    ];

    for (const candidate of invalidConfigs) {
      expect(() => createHarnessRuntimeTargetRouteObserver(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_observer" }),
      );
    }

    const observation = createObserver().observe(
      graphTask(),
      null,
      runtimeTargetPlan(["production_control_plane"]),
    );
    const invalidSnapshots = [
      null,
      { ...clone(observation), extra: true },
      { ...clone(observation), executionAuthorized: true },
      { ...clone(observation), complete: false },
      { ...clone(observation), observerSessionId: "invalid" },
      { ...clone(observation), runtimeInventoryDigest: "d".repeat(64) },
      { ...clone(observation), observationDigest: "0".repeat(64) },
      {
        ...clone(observation),
        observerPolicySet: { runtimeTarget: "runtime-target.v2" },
      },
    ];

    for (const candidate of invalidSnapshots) {
      expect(() => decodeHarnessRuntimeTargetRouteObservation(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
    }
  });

  it("exposes stable typed errors", () => {
    const error = new HarnessRuntimeTargetRouteObserverError("invalid_runtime_target_plan");
    expect(error.name).toBe("HarnessRuntimeTargetRouteObserverError");
    expect(error.code).toBe("invalid_runtime_target_plan");
    expect(error.message).toBe("The complete Harness runtime target plan is invalid.");
  });
});
