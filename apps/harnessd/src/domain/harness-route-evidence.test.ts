import { describe, expect, it } from "vitest";

import type { TaskPlanRecord } from "./task-plan-store.js";
import {
  HARNESS_ROUTE_EVIDENCE_POLICY_VERSION,
  HARNESS_ROUTE_SAFETY_OBSERVER_SOURCES,
  HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES,
  HarnessRouteEvidenceError,
  createHarnessRouteEvidenceAuthority,
  decodeHarnessRouteEvidenceSnapshot,
  type HarnessRouteSafetyObserverSource,
  type HarnessRouteSafetyReport,
  type HarnessRouteToolClass,
  type IssueHarnessRouteEvidenceInput,
} from "./harness-route-evidence.js";

const AUTHORITY_ID = uuid(1);
const OTHER_AUTHORITY_ID = uuid(2);
const TASK_ID = uuid(10);
const REQUIREMENT_ID = uuid(11);
const PLAN_ID = uuid(12);
const GRAPH_ID = uuid(13);

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function requirementsTask(): TaskPlanRecord {
  return {
    taskId: TASK_ID,
    title: "Harness route evidence",
    taskVersion: 1,
    createdAtMs: 100,
    updatedAtMs: 100,
    activeRequirement: {
      revisionId: REQUIREMENT_ID,
      revisionNumber: 1,
      sourceText: "Classify a bounded task using Harness-only observations.",
      objective: "Prove routing evidence coverage without authorizing execution.",
      constraints: ["Serialized evidence cannot recover authority."],
      acceptanceCriteria: ["Missing safety observers remain unresolved."],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: null,
    activeReconciliation: null,
    lastGraphRevisionNumber: 0,
  };
}

function graphTask(): TaskPlanRecord {
  const steps = [0, 1].map((index) => ({
    stepId: uuid(20 + index),
    title: `Step ${index + 1}`,
    description: `Execute bounded work ${index + 1}.`,
    acceptanceCriteria: [`Evidence ${index + 1}`],
  }));
  const confirmedPlan = {
    revisionId: PLAN_ID,
    revisionNumber: 1,
    status: "confirmed" as const,
    basedOnRequirementRevisionId: REQUIREMENT_ID,
    steps,
  };
  return {
    ...requirementsTask(),
    taskVersion: 3,
    updatedAtMs: 300,
    latestPlan: confirmedPlan,
    confirmedPlan,
    activeGraph: {
      revisionId: GRAPH_ID,
      revisionNumber: 1,
      basedOnPlanRevisionId: PLAN_ID,
      nodes: steps.map((step, index) => ({
        nodeId: uuid(30 + index),
        sourcePlanStepId: step.stepId,
        title: step.title,
        description: step.description,
        acceptanceCriteria: step.acceptanceCriteria,
        dependsOnNodeIds: index === 0 ? [] : [uuid(30)],
        status: "pending" as const,
      })),
      topologicalOrder: [uuid(30), uuid(31)],
    },
    lastGraphRevisionNumber: 1,
  };
}

function safetyReport(
  source: HarnessRouteSafetyObserverSource,
  presentSignals: readonly string[] = [],
): HarnessRouteSafetyReport {
  return {
    source,
    policyVersion: `${source}.v1`,
    observations: Object.fromEntries(
      HARNESS_ROUTE_SAFETY_SOURCE_SIGNAL_NAMES[source].map((signal) => [
        signal,
        presentSignals.includes(signal) ? "present" : "absent",
      ]),
    ),
  };
}

function fullInput(
  evidenceNumber = 100,
  tools: readonly HarnessRouteToolClass[] = [],
): IssueHarnessRouteEvidenceInput {
  return {
    schemaVersion: 1,
    evidenceId: uuid(evidenceNumber),
    observedAtMs: 300,
    taskClassification: {
      source: "harness_task_classifier",
      policyVersion: "task-classifier.v1",
      taskKind: "simple",
    },
    toolPlan: {
      source: "harness_tool_planner",
      policyVersion: "tool-planner.v1",
      complete: true,
      tools,
    },
    safetyReports: HARNESS_ROUTE_SAFETY_OBSERVER_SOURCES.map((source) => safetyReport(source)),
  };
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

function createAuthority(authoritySessionId = AUTHORITY_ID) {
  return createHarnessRouteEvidenceAuthority({
    schemaVersion: 1,
    authoritySessionId,
    policySet: {
      taskClassifier: "task-classifier.v1",
      toolPlanner: "tool-planner.v1",
      safetyObservers: {
        operation_plan: "operation_plan.v1",
        permission_plan: "permission_plan.v1",
        workspace_analysis: "workspace_analysis.v1",
        runtime_target: "runtime_target.v1",
      },
    },
  });
}

describe("Harness route evidence authority", () => {
  it("issues complete, conservative and non-executable routing evidence", () => {
    const authority = createAuthority();
    const snapshot = authority.issue(graphTask(), null, fullInput());

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      mode: "shadow",
      executionAuthorized: false,
      policyVersion: HARNESS_ROUTE_EVIDENCE_POLICY_VERSION,
      authoritySessionId: AUTHORITY_ID,
      authorityPolicySet: {
        taskClassifier: "task-classifier.v1",
        toolPlanner: "tool-planner.v1",
      },
      evidenceId: uuid(100),
      observedAtMs: 300,
      subject: { taskId: TASK_ID, taskVersion: 3, nodeId: null },
      derived: {
        taskKind: {
          status: "observed",
          value: "simple",
          source: "harness_task_classifier",
        },
        toolBreadth: {
          status: "observed",
          value: "none",
          source: "harness_tool_planner",
          toolCount: 0,
        },
        completeForRouting: true,
      },
    });
    for (const evidence of Object.values(snapshot.derived.safety)) {
      expect(evidence).toMatchObject({
        status: "absent",
        value: false,
        missingSources: [],
      });
    }
    expect(snapshot.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(authority.isVerified(snapshot)).toBe(true);
    expect(authority.isCurrent(graphTask(), snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.observations)).toBe(true);
    expect(Object.isFrozen(snapshot.observations.safetyReports)).toBe(true);
    expect(Object.isFrozen(snapshot.observations.safetyReports[0])).toBe(true);
    expect(Object.isFrozen(snapshot.authorityPolicySet)).toBe(true);
    expect(Object.isFrozen(snapshot.authorityPolicySet.safetyObservers)).toBe(true);
    expect(Object.isFrozen(snapshot.derived)).toBe(true);
    expect(Object.isFrozen(snapshot.derived.safety.securitySensitive)).toBe(true);
  });

  it("keeps missing coverage unresolved while any observed risk wins immediately", () => {
    const authority = createAuthority();
    const input = fullInput();
    const partial = authority.issue(graphTask(), null, {
      ...input,
      safetyReports: [safetyReport("permission_plan"), safetyReport("workspace_analysis")],
    });

    expect(partial.derived.safety.securitySensitive).toMatchObject({
      status: "absent",
      value: false,
      observedSources: ["permission_plan", "workspace_analysis"],
      missingSources: [],
    });
    expect(partial.derived.safety.dataMigration).toMatchObject({
      status: "unresolved",
      value: null,
      observedSources: ["workspace_analysis"],
      missingSources: ["operation_plan"],
    });
    expect(partial.derived.completeForRouting).toBe(false);

    const risk = authority.issue(graphTask(), null, {
      ...input,
      evidenceId: uuid(101),
      safetyReports: [safetyReport("operation_plan", ["productionImpact"])],
    });
    expect(risk.derived.safety.productionImpact).toMatchObject({
      status: "present",
      value: true,
      observedSources: ["operation_plan"],
      missingSources: ["runtime_target"],
    });
  });

  it("does not guess a task kind, tool breadth, or negative safety result", () => {
    const authority = createAuthority();
    const snapshot = authority.issue(graphTask(), null, {
      ...fullInput(),
      taskClassification: null,
      toolPlan: null,
      safetyReports: [],
    });

    expect(snapshot.derived.taskKind).toEqual({
      status: "unresolved",
      value: null,
      source: null,
      policyVersion: null,
    });
    expect(snapshot.derived.toolBreadth).toEqual({
      status: "unresolved",
      value: null,
      source: null,
      policyVersion: null,
      toolCount: null,
    });
    expect(snapshot.derived.completeForRouting).toBe(false);
    for (const evidence of Object.values(snapshot.derived.safety)) {
      expect(evidence.status).toBe("unresolved");
      expect(evidence.value).toBeNull();
      expect(evidence.observedSources).toEqual([]);
      expect(evidence.missingSources).toHaveLength(2);
    }
  });

  it("derives every tool breadth boundary and normalizes tool order", () => {
    const authority = createAuthority();
    const cases = [
      [[], "none"],
      [["workspace_read"], "single"],
      [["command_execution", "workspace_read"], "multiple"],
      [["network_access", "command_execution", "workspace_read"], "multiple"],
      [["external_write", "workspace_write", "command_execution", "workspace_read"], "extensive"],
    ] as const;

    for (const [index, [tools, breadth]] of cases.entries()) {
      const mutableTools = [...tools] as HarnessRouteToolClass[];
      const snapshot = authority.issue(graphTask(), null, fullInput(110 + index, mutableTools));
      mutableTools.reverse();
      expect(snapshot.derived.toolBreadth.value).toBe(breadth);
      expect(snapshot.observations.toolPlan?.tools).toEqual(
        tools.length === 4
          ? ["workspace_read", "workspace_write", "command_execution", "external_write"]
          : [...tools].sort(
              (left, right) =>
                [
                  "workspace_read",
                  "workspace_write",
                  "command_execution",
                  "network_access",
                  "credential_access",
                  "external_write",
                  "user_interaction",
                ].indexOf(left) -
                [
                  "workspace_read",
                  "workspace_write",
                  "command_execution",
                  "network_access",
                  "credential_access",
                  "external_write",
                  "user_interaction",
                ].indexOf(right),
            ),
      );
    }
  });

  it("requires exact source coverage, unique reports, and a complete unique tool plan", () => {
    const authority = createAuthority();
    const input = fullInput();
    const operation = clone(safetyReport("operation_plan")) as unknown as {
      source: HarnessRouteSafetyObserverSource;
      policyVersion: string;
      observations: Record<string, string>;
    };
    delete operation.observations.publicApiChange;
    const extra = clone(safetyReport("runtime_target")) as unknown as {
      source: HarnessRouteSafetyObserverSource;
      policyVersion: string;
      observations: Record<string, string>;
    };
    extra.observations.securitySensitive = "absent";
    const invalid = [
      { ...input, safetyReports: [operation] },
      { ...input, safetyReports: [extra] },
      {
        ...input,
        safetyReports: [safetyReport("runtime_target"), safetyReport("runtime_target")],
      },
      {
        ...input,
        toolPlan: { ...input.toolPlan!, tools: ["workspace_read", "workspace_read"] },
      },
      { ...input, toolPlan: { ...input.toolPlan!, complete: false } },
      {
        ...input,
        taskClassification: { ...input.taskClassification!, source: "model" },
      },
      {
        ...input,
        safetyReports: [{ ...safetyReport("runtime_target"), policyVersion: "runtime_target.v2" }],
      },
    ];

    for (const candidate of invalid) {
      expect(() => authority.issue(graphTask(), null, candidate as never)).toThrowError(
        expect.objectContaining({ code: "invalid_observation" }),
      );
    }
  });

  it("keeps authority local to one session and never rebrands decoded JSON", () => {
    const authority = createAuthority();
    const other = createAuthority(OTHER_AUTHORITY_ID);
    const snapshot = authority.issue(graphTask(), null, fullInput());
    const cloned = clone(snapshot);
    const decoded = decodeHarnessRouteEvidenceSnapshot(cloned);

    expect(decoded).toEqual(snapshot);
    expect(authority.isVerified(cloned)).toBe(false);
    expect(authority.isVerified(decoded)).toBe(false);
    expect(authority.isVerified({ ...snapshot })).toBe(false);
    expect(other.isVerified(snapshot)).toBe(false);
    expect(authority.isCurrent(graphTask(), decoded)).toBe(false);
    expect(other.isCurrent(graphTask(), snapshot)).toBe(false);
  });

  it("binds observations to Task content, time and an optional current graph node", () => {
    const authority = createAuthority();
    const task = graphTask();
    const snapshot = authority.issue(task, uuid(31), fullInput());

    expect(snapshot.subject.nodeId).toBe(uuid(31));
    expect(authority.isCurrent(task, snapshot)).toBe(true);
    expect(
      authority.isCurrent(
        {
          ...task,
          activeRequirement: {
            ...task.activeRequirement,
            sourceText: `${task.activeRequirement.sourceText} Changed without a version bump.`,
          },
        },
        snapshot,
      ),
    ).toBe(false);
    expect(() => authority.issue(task, uuid(99), fullInput())).toThrowError(
      expect.objectContaining({ code: "node_not_found" }),
    );
    expect(() =>
      authority.issue(task, null, { ...fullInput(), observedAtMs: task.updatedAtMs - 1 }),
    ).toThrowError(expect.objectContaining({ code: "stale_observation" }));
  });

  it("is deterministic and rejects every serialized derived-field mutation", () => {
    const authority = createAuthority();
    const first = authority.issue(graphTask(), null, fullInput());
    const second = authority.issue(graphTask(), null, fullInput());
    expect(first).toEqual(second);

    const invalid = [
      { ...clone(first), extra: true },
      { ...clone(first), mode: "active" },
      { ...clone(first), executionAuthorized: true },
      { ...clone(first), authoritySessionId: OTHER_AUTHORITY_ID },
      {
        ...clone(first),
        authorityPolicySet: {
          ...first.authorityPolicySet,
          taskClassifier: "task-classifier.v2",
        },
      },
      { ...clone(first), evidenceDigest: "0".repeat(64) },
      {
        ...clone(first),
        derived: { ...first.derived, completeForRouting: false },
      },
      {
        ...clone(first),
        subject: { ...first.subject, taskVersion: first.subject.taskVersion + 1 },
      },
      {
        ...clone(first),
        observations: { ...first.observations, safetyReports: [] },
      },
    ];
    for (const candidate of invalid) {
      expect(() => decodeHarnessRouteEvidenceSnapshot(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
    }
  });

  it("rejects malformed authorities, observations, accessors and invalid Task sources", () => {
    expect(() => createHarnessRouteEvidenceAuthority("bad")).toThrowError(
      expect.objectContaining({ code: "invalid_authority" }),
    );
    expect(() =>
      createHarnessRouteEvidenceAuthority({
        schemaVersion: 1,
        authoritySessionId: AUTHORITY_ID,
        policySet: {
          taskClassifier: "INVALID",
          toolPlanner: "tool-planner.v1",
          safetyObservers: {},
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_authority" }));
    const authority = createAuthority();
    const accessor = { ...fullInput() } as Record<string, unknown>;
    Object.defineProperty(accessor, "evidenceId", {
      enumerable: true,
      get: () => uuid(900),
    });
    const invalidInputs = [
      accessor,
      { ...fullInput(), unexpected: true },
      { ...fullInput(), evidenceId: "bad" },
      { ...fullInput(), observedAtMs: -1 },
      {
        ...fullInput(),
        taskClassification: { ...fullInput().taskClassification!, policyVersion: "INVALID" },
      },
    ];
    for (const input of invalidInputs) {
      expect(() => authority.issue(graphTask(), null, input as never)).toThrowError(
        expect.objectContaining({ code: "invalid_observation" }),
      );
    }
    expect(() =>
      authority.issue(
        {
          ...graphTask(),
          activeRequirement: { ...graphTask().activeRequirement, revisionId: "bad" },
        },
        null,
        fullInput(),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_task" }));
    expect(() => decodeHarnessRouteEvidenceSnapshot(null)).toThrowError(HarnessRouteEvidenceError);
  });
});
