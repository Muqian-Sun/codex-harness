import { describe, expect, it } from "vitest";

import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  HARNESS_PERMISSION_ROUTE_OBSERVER_POLICY_VERSION,
  HarnessPermissionRouteObserverError,
  createHarnessPermissionRouteObserver,
  decodeHarnessPermissionRouteObservation,
  type HarnessPermissionCapability,
  type ObserveHarnessPermissionRouteInput,
} from "./harness-permission-route-observer.js";

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
    title: "Harness permission route observer",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Observe one complete permission request plan.",
      objective: "Derive deterministic permission-plan route evidence.",
      constraints: ["The permission plan is not an approval or runtime gate."],
      acceptanceCriteria: ["Risk is derived from fixed capabilities."],
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
    title: "Observe permission requests",
    description: "Classify a bounded permission plan.",
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
  return createHarnessPermissionRouteObserver({
    schemaVersion: 1,
    observerSessionId,
    policySet: { permissionPlan: `permission-plan.${suffix}` },
  });
}

function permissionPlan(
  capabilities: readonly HarnessPermissionCapability[],
  planNumber = 100,
  observedAtMs = 300,
): ObserveHarnessPermissionRouteInput {
  return {
    schemaVersion: 1,
    permissionPlanId: uuid(planNumber),
    observedAtMs,
    complete: true,
    requests: capabilities.map((capability, index) => ({
      permissionRequestId: uuid(planNumber * 100 + index),
      capability,
    })),
  };
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

describe("Harness complete permission route observer", () => {
  it("issues a verified non-executable report for a complete empty plan", () => {
    const observer = createObserver();
    const task = graphTask();
    const observation = observer.observe(task, NODE_ID, permissionPlan([]));

    expect(observation).toMatchObject({
      schemaVersion: 1,
      mode: "shadow",
      executionAuthorized: false,
      policyVersion: HARNESS_PERMISSION_ROUTE_OBSERVER_POLICY_VERSION,
      observerSessionId: OBSERVER_ID,
      observerPolicySet: { permissionPlan: "permission-plan.v1" },
      permissionPlanId: uuid(100),
      observedAtMs: 300,
      complete: true,
      subject: { taskId: TASK_ID, taskVersion: 3, nodeId: NODE_ID },
      requests: [],
      permissionPlanSafetyReport: {
        source: "permission_plan",
        policyVersion: "permission-plan.v1",
        observations: {
          irreversibleOperation: "absent",
          permissionBoundaryChange: "absent",
          securitySensitive: "absent",
        },
      },
    });
    expect(observation.observationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(observer.isVerified(observation)).toBe(true);
    expect(observer.isCurrent(task, observation)).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.observerPolicySet)).toBe(true);
    expect(Object.isFrozen(observation.requests)).toBe(true);
    expect(Object.isFrozen(observation.permissionPlanSafetyReport)).toBe(true);
    expect(Object.isFrozen(observation.permissionPlanSafetyReport.observations)).toBe(true);
  });

  it("derives security sensitivity from every fixed sensitive capability", () => {
    const observer = createObserver();
    const capabilities = [
      "credential_access",
      "privileged_command_execution",
      "permission_boundary_change",
      "production_access",
    ] as const;

    for (const [index, capability] of capabilities.entries()) {
      const observation = observer.observe(
        graphTask(),
        null,
        permissionPlan([capability], 110 + index),
      );
      expect(observation.permissionPlanSafetyReport.observations.securitySensitive).toBe("present");
    }
  });

  it("derives irreversibility from both irreversible capability classes", () => {
    const observer = createObserver();
    const capabilities = ["irreversible_workspace_change", "irreversible_external_write"] as const;

    for (const [index, capability] of capabilities.entries()) {
      const observation = observer.observe(
        graphTask(),
        null,
        permissionPlan([capability], 120 + index),
      );
      expect(observation.permissionPlanSafetyReport.observations).toEqual({
        irreversibleOperation: "present",
        permissionBoundaryChange: "absent",
        securitySensitive: "absent",
      });
    }
  });

  it("treats a permission-boundary change as both boundary and security sensitive", () => {
    const observation = createObserver().observe(
      graphTask(),
      null,
      permissionPlan(["permission_boundary_change"]),
    );

    expect(observation.permissionPlanSafetyReport.observations).toEqual({
      irreversibleOperation: "absent",
      permissionBoundaryChange: "present",
      securitySensitive: "present",
    });
  });

  it("keeps ordinary capabilities absent and derives a stable mixed report", () => {
    const observer = createObserver();
    const ordinary = observer.observe(
      graphTask(),
      null,
      permissionPlan([
        "workspace_read",
        "workspace_write",
        "command_execution",
        "network_access",
        "external_write",
        "user_interaction",
      ]),
    );
    expect(Object.values(ordinary.permissionPlanSafetyReport.observations)).toEqual(
      Array(3).fill("absent"),
    );

    const mixed = observer.observe(
      graphTask(),
      null,
      permissionPlan(
        [
          "workspace_read",
          "irreversible_external_write",
          "production_access",
          "permission_boundary_change",
        ],
        130,
      ),
    );
    expect(mixed.permissionPlanSafetyReport.observations).toEqual({
      irreversibleOperation: "present",
      permissionBoundaryChange: "present",
      securitySensitive: "present",
    });
  });

  it("rejects incomplete, duplicate, oversized, and non-exact permission plans", () => {
    const observer = createObserver();
    const valid = permissionPlan(["workspace_read"]);
    const duplicate = {
      ...clone(valid),
      requests: [...valid.requests, clone(valid.requests[0]!)],
    };
    const oversized = permissionPlan(
      Array.from({ length: 257 }, () => "workspace_read" as const),
      200,
    );
    const extraRequest = clone(valid) as unknown as {
      requests: Array<Record<string, unknown>>;
    };
    extraRequest.requests[0]!.scope = "untrusted";
    const missingComplete = clone(valid) as unknown as Record<string, unknown>;
    delete missingComplete.complete;
    const invalid = [
      { ...valid, complete: false },
      missingComplete,
      duplicate,
      oversized,
      {
        ...valid,
        requests: [{ permissionRequestId: uuid(500), capability: "unknown" }],
      },
      extraRequest,
      { ...valid, extra: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, observedAtMs: -1 },
    ];

    for (const candidate of invalid) {
      expect(() => observer.observe(graphTask(), null, candidate as never)).toThrowError(
        expect.objectContaining({ code: "invalid_permission_plan" }),
      );
    }
  });

  it("binds observations to current Task, DAG node, and observation time", () => {
    const observer = createObserver();
    const task = graphTask();
    const observation = observer.observe(task, NODE_ID, permissionPlan([]));

    expect(() => observer.observe(task, uuid(999), permissionPlan([]))).toThrowError(
      expect.objectContaining({ code: "node_not_found" }),
    );
    expect(() => observer.observe(task, NODE_ID, permissionPlan([], 100, 299))).toThrowError(
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
      observer.observe({ ...task, updatedAtMs: Number.NaN }, NODE_ID, permissionPlan([])),
    ).toThrowError(expect.objectContaining({ code: "invalid_task" }));
  });

  it("keeps observer authority process-local and policy-bound", () => {
    const observer = createObserver();
    const otherSession = createObserver(OTHER_OBSERVER_ID);
    const otherPolicy = createObserver(OBSERVER_ID, "v2");
    const task = graphTask();
    const observation = observer.observe(task, null, permissionPlan(["credential_access"]));
    const decoded = decodeHarnessPermissionRouteObservation(clone(observation));

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
    const input = permissionPlan(["workspace_read", "credential_access"]);
    const first = observer.observe(task, null, input);
    const second = observer.observe(task, null, clone(input));
    (
      input.requests as Array<{
        permissionRequestId: string;
        capability: HarnessPermissionCapability;
      }>
    )[0]!.capability = "production_access";

    expect(first).toEqual(second);
    expect(first.observationDigest).toBe(second.observationDigest);
    expect(first.requests[0]?.capability).toBe("workspace_read");

    const tampered = clone(first) as unknown as {
      permissionPlanSafetyReport: { observations: { securitySensitive: string } };
    };
    tampered.permissionPlanSafetyReport.observations.securitySensitive = "absent";
    expect(() => decodeHarnessPermissionRouteObservation(tampered)).toThrowError(
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
        policySet: { permissionPlan: "permission-plan.v1" },
      },
      {
        schemaVersion: 1,
        observerSessionId: "invalid",
        policySet: { permissionPlan: "permission-plan.v1" },
      },
      {
        schemaVersion: 1,
        observerSessionId: OBSERVER_ID,
        policySet: { permissionPlan: "INVALID POLICY" },
      },
      {
        schemaVersion: 1,
        observerSessionId: OBSERVER_ID,
        policySet: { permissionPlan: "permission-plan.v1", extra: true },
      },
    ];

    for (const candidate of invalidConfigs) {
      expect(() => createHarnessPermissionRouteObserver(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_observer" }),
      );
    }

    const observation = createObserver().observe(
      graphTask(),
      null,
      permissionPlan(["credential_access"]),
    );
    const invalidSnapshots = [
      null,
      { ...clone(observation), extra: true },
      { ...clone(observation), executionAuthorized: true },
      { ...clone(observation), complete: false },
      { ...clone(observation), observerSessionId: "invalid" },
      { ...clone(observation), observationDigest: "0".repeat(64) },
      {
        ...clone(observation),
        observerPolicySet: { permissionPlan: "permission-plan.v2" },
      },
    ];

    for (const candidate of invalidSnapshots) {
      expect(() => decodeHarnessPermissionRouteObservation(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
    }
  });

  it("exposes stable typed errors", () => {
    const error = new HarnessPermissionRouteObserverError("invalid_permission_plan");
    expect(error.name).toBe("HarnessPermissionRouteObserverError");
    expect(error.code).toBe("invalid_permission_plan");
    expect(error.message).toBe("The complete Harness permission plan is invalid.");
  });
});
