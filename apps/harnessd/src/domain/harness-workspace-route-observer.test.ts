import { describe, expect, it } from "vitest";

import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  HARNESS_WORKSPACE_ROUTE_OBSERVER_POLICY_VERSION,
  HarnessWorkspaceRouteObserverError,
  createHarnessWorkspaceRouteObserver,
  decodeHarnessWorkspaceRouteObservation,
  type HarnessWorkspaceFindingKind,
  type ObserveHarnessWorkspaceRouteInput,
} from "./harness-workspace-route-observer.js";

const OBSERVER_ID = uuid(1);
const OTHER_OBSERVER_ID = uuid(2);
const TASK_ID = uuid(10);
const REQUIREMENT_ID = uuid(11);
const PLAN_ID = uuid(12);
const GRAPH_ID = uuid(13);
const NODE_ID = uuid(30);
const WORKSPACE_DIGEST = "a".repeat(64);

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function requirementsTask(): TaskPlanRecord {
  return {
    taskId: TASK_ID,
    title: "Harness workspace route observer",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Observe one complete workspace analysis.",
      objective: "Derive deterministic workspace-analysis route evidence.",
      constraints: ["The observer cannot prove that the workspace snapshot is still current."],
      acceptanceCriteria: ["Risk is derived from fixed finding kinds."],
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
    title: "Observe workspace findings",
    description: "Classify a bounded complete workspace analysis.",
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
  return createHarnessWorkspaceRouteObserver({
    schemaVersion: 1,
    observerSessionId,
    policySet: { workspaceAnalysis: `workspace-analysis.${suffix}` },
  });
}

function workspaceAnalysis(
  kinds: readonly HarnessWorkspaceFindingKind[],
  analysisNumber = 100,
  observedAtMs = 300,
  workspaceDigest = WORKSPACE_DIGEST,
): ObserveHarnessWorkspaceRouteInput {
  return {
    schemaVersion: 1,
    analysisId: uuid(analysisNumber),
    workspaceSnapshotId: uuid(analysisNumber + 1_000),
    workspaceDigest,
    observedAtMs,
    complete: true,
    findings: kinds.map((kind, index) => ({
      findingId: uuid(analysisNumber * 1_000 + index),
      kind,
    })),
  };
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

describe("Harness complete workspace route observer", () => {
  it("issues a verified non-executable report for a complete empty analysis", () => {
    const observer = createObserver();
    const task = graphTask();
    const observation = observer.observe(task, NODE_ID, workspaceAnalysis([]));

    expect(observation).toMatchObject({
      schemaVersion: 1,
      mode: "shadow",
      executionAuthorized: false,
      policyVersion: HARNESS_WORKSPACE_ROUTE_OBSERVER_POLICY_VERSION,
      observerSessionId: OBSERVER_ID,
      observerPolicySet: { workspaceAnalysis: "workspace-analysis.v1" },
      analysisId: uuid(100),
      workspaceSnapshotId: uuid(1_100),
      workspaceDigest: WORKSPACE_DIGEST,
      observedAtMs: 300,
      complete: true,
      subject: { taskId: TASK_ID, taskVersion: 3, nodeId: NODE_ID },
      findings: [],
      workspaceAnalysisSafetyReport: {
        source: "workspace_analysis",
        policyVersion: "workspace-analysis.v1",
        observations: {
          concurrencySensitive: "absent",
          dataMigration: "absent",
          publicApiChange: "absent",
          securitySensitive: "absent",
        },
      },
    });
    expect(observation.observationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(observer.isVerified(observation)).toBe(true);
    expect(observer.isCurrent(task, observation)).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.observerPolicySet)).toBe(true);
    expect(Object.isFrozen(observation.findings)).toBe(true);
    expect(Object.isFrozen(observation.workspaceAnalysisSafetyReport)).toBe(true);
    expect(Object.isFrozen(observation.workspaceAnalysisSafetyReport.observations)).toBe(true);
  });

  it("derives concurrency sensitivity from both fixed concurrency finding kinds", () => {
    const kinds = ["shared_mutable_state_change", "concurrent_resource_access_change"] as const;

    for (const [index, kind] of kinds.entries()) {
      const observation = createObserver().observe(
        graphTask(),
        null,
        workspaceAnalysis([kind], 110 + index),
      );
      expect(observation.workspaceAnalysisSafetyReport.observations).toEqual({
        concurrencySensitive: "present",
        dataMigration: "absent",
        publicApiChange: "absent",
        securitySensitive: "absent",
      });
    }
  });

  it("derives data migration from both fixed migration finding kinds", () => {
    const kinds = ["database_schema_change", "persistent_data_rewrite"] as const;

    for (const [index, kind] of kinds.entries()) {
      const observation = createObserver().observe(
        graphTask(),
        null,
        workspaceAnalysis([kind], 120 + index),
      );
      expect(observation.workspaceAnalysisSafetyReport.observations.dataMigration).toBe("present");
    }
  });

  it("derives public API change from both fixed API finding kinds", () => {
    const kinds = ["exported_api_change", "protocol_contract_change"] as const;

    for (const [index, kind] of kinds.entries()) {
      const observation = createObserver().observe(
        graphTask(),
        null,
        workspaceAnalysis([kind], 130 + index),
      );
      expect(observation.workspaceAnalysisSafetyReport.observations.publicApiChange).toBe(
        "present",
      );
    }
  });

  it("derives security sensitivity from every fixed security finding kind", () => {
    const kinds = [
      "authentication_authorization_change",
      "credential_handling_change",
      "cryptographic_change",
      "security_boundary_change",
    ] as const;

    for (const [index, kind] of kinds.entries()) {
      const observation = createObserver().observe(
        graphTask(),
        null,
        workspaceAnalysis([kind], 140 + index),
      );
      expect(observation.workspaceAnalysisSafetyReport.observations.securitySensitive).toBe(
        "present",
      );
    }
  });

  it("derives a stable combined report without caller-supplied booleans", () => {
    const input = workspaceAnalysis(
      [
        "concurrent_resource_access_change",
        "persistent_data_rewrite",
        "protocol_contract_change",
        "cryptographic_change",
      ],
      150,
    );
    const observer = createObserver();
    const first = observer.observe(graphTask(), null, input);
    const second = observer.observe(graphTask(), null, clone(input));

    expect(first.workspaceAnalysisSafetyReport.observations).toEqual({
      concurrencySensitive: "present",
      dataMigration: "present",
      publicApiChange: "present",
      securitySensitive: "present",
    });
    expect(first).toEqual(second);
    expect(first.observationDigest).toBe(second.observationDigest);
  });

  it("rejects incomplete, duplicate, oversized, and non-exact workspace analyses", () => {
    const observer = createObserver();
    const valid = workspaceAnalysis(["exported_api_change"]);
    const duplicate = {
      ...clone(valid),
      findings: [...valid.findings, clone(valid.findings[0]!)],
    };
    const oversized = workspaceAnalysis(
      Array.from({ length: 513 }, () => "shared_mutable_state_change" as const),
      200,
    );
    const extraFinding = clone(valid) as unknown as {
      findings: Array<Record<string, unknown>>;
    };
    extraFinding.findings[0]!.path = "secret.ts";
    const missingComplete = clone(valid) as unknown as Record<string, unknown>;
    delete missingComplete.complete;
    const invalid = [
      { ...valid, complete: false },
      missingComplete,
      duplicate,
      oversized,
      { ...valid, workspaceDigest: WORKSPACE_DIGEST.toUpperCase() },
      { ...valid, workspaceSnapshotId: "invalid" },
      { ...valid, findings: [{ findingId: uuid(500), kind: "unknown" }] },
      extraFinding,
      { ...valid, extra: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, observedAtMs: -1 },
    ];

    for (const candidate of invalid) {
      expect(() => observer.observe(graphTask(), null, candidate as never)).toThrowError(
        expect.objectContaining({ code: "invalid_workspace_analysis" }),
      );
    }
  });

  it("binds observations to current Task, DAG node, and observation time", () => {
    const observer = createObserver();
    const task = graphTask();
    const observation = observer.observe(task, NODE_ID, workspaceAnalysis([]));

    expect(() => observer.observe(task, uuid(999), workspaceAnalysis([]))).toThrowError(
      expect.objectContaining({ code: "node_not_found" }),
    );
    expect(() => observer.observe(task, NODE_ID, workspaceAnalysis([], 100, 299))).toThrowError(
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
      observer.observe({ ...task, updatedAtMs: Number.NaN }, NODE_ID, workspaceAnalysis([])),
    ).toThrowError(expect.objectContaining({ code: "invalid_task" }));
  });

  it("keeps observer authority process-local and policy-bound", () => {
    const observer = createObserver();
    const otherSession = createObserver(OTHER_OBSERVER_ID);
    const otherPolicy = createObserver(OBSERVER_ID, "v2");
    const task = graphTask();
    const observation = observer.observe(
      task,
      null,
      workspaceAnalysis(["security_boundary_change"]),
    );
    const decoded = decodeHarnessWorkspaceRouteObservation(clone(observation));

    expect(otherSession.isVerified(observation)).toBe(false);
    expect(otherPolicy.isVerified(observation)).toBe(false);
    expect(otherSession.isCurrent(task, observation)).toBe(false);
    expect(otherPolicy.isCurrent(task, observation)).toBe(false);
    expect(observer.isVerified(decoded)).toBe(false);
    expect(observer.isCurrent(task, decoded)).toBe(false);
    expect(decoded).toEqual(observation);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.findings[0])).toBe(true);
  });

  it("defensively copies input findings and rejects tampered snapshots", () => {
    const observer = createObserver();
    const input = workspaceAnalysis(["shared_mutable_state_change", "credential_handling_change"]);
    const observation = observer.observe(graphTask(), null, input);
    (
      input.findings as Array<{
        findingId: string;
        kind: HarnessWorkspaceFindingKind;
      }>
    )[0]!.kind = "database_schema_change";

    expect(observation.findings[0]?.kind).toBe("shared_mutable_state_change");

    const tampered = clone(observation) as unknown as {
      workspaceAnalysisSafetyReport: { observations: { securitySensitive: string } };
    };
    tampered.workspaceAnalysisSafetyReport.observations.securitySensitive = "absent";
    expect(() => decodeHarnessWorkspaceRouteObservation(tampered)).toThrowError(
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
        policySet: { workspaceAnalysis: "workspace-analysis.v1" },
      },
      {
        schemaVersion: 1,
        observerSessionId: "invalid",
        policySet: { workspaceAnalysis: "workspace-analysis.v1" },
      },
      {
        schemaVersion: 1,
        observerSessionId: OBSERVER_ID,
        policySet: { workspaceAnalysis: "INVALID POLICY" },
      },
      {
        schemaVersion: 1,
        observerSessionId: OBSERVER_ID,
        policySet: { workspaceAnalysis: "workspace-analysis.v1", extra: true },
      },
    ];

    for (const candidate of invalidConfigs) {
      expect(() => createHarnessWorkspaceRouteObserver(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_observer" }),
      );
    }

    const observation = createObserver().observe(
      graphTask(),
      null,
      workspaceAnalysis(["security_boundary_change"]),
    );
    const invalidSnapshots = [
      null,
      { ...clone(observation), extra: true },
      { ...clone(observation), executionAuthorized: true },
      { ...clone(observation), complete: false },
      { ...clone(observation), observerSessionId: "invalid" },
      { ...clone(observation), workspaceDigest: "b".repeat(64) },
      { ...clone(observation), observationDigest: "0".repeat(64) },
      {
        ...clone(observation),
        observerPolicySet: { workspaceAnalysis: "workspace-analysis.v2" },
      },
    ];

    for (const candidate of invalidSnapshots) {
      expect(() => decodeHarnessWorkspaceRouteObservation(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
    }
  });

  it("exposes stable typed errors", () => {
    const error = new HarnessWorkspaceRouteObserverError("invalid_workspace_analysis");
    expect(error.name).toBe("HarnessWorkspaceRouteObserverError");
    expect(error.code).toBe("invalid_workspace_analysis");
    expect(error.message).toBe("The complete Harness workspace analysis is invalid.");
  });
});
