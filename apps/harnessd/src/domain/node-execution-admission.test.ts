import { describe, expect, it } from "vitest";

import type { HarnessRouteOperationKind } from "./harness-route-operation.js";
import {
  buildActiveRouteFeatures,
  evaluateNodeExecutionAdmission,
} from "./node-execution-admission.js";
import type { TaskPlanRecord } from "./task-plan-store.js";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

function task(graphSize = 1, requirementSize = 0): TaskPlanRecord {
  const nodes = Array.from({ length: graphSize }, (_, index) => ({
    nodeId: id(100 + index),
    sourcePlanStepId: id(200 + index),
    title: `node-${index}`,
    description: "description",
    acceptanceCriteria: [],
    dependsOnNodeIds: index === 0 ? [] : [id(99 + index)],
    status: "pending" as const,
  }));
  return {
    taskId: id(1),
    title: "task",
    taskVersion: 3,
    createdAtMs: 1,
    updatedAtMs: 3,
    activeRequirement: {
      revisionId: id(2),
      revisionNumber: 1,
      sourceText: "source",
      objective: "objective",
      constraints: Array.from({ length: requirementSize }, (_, index) => `c-${index}`),
      acceptanceCriteria: [],
    },
    latestPlan: null,
    confirmedPlan: null,
    activeGraph: {
      revisionId: id(3),
      revisionNumber: 1,
      basedOnPlanRevisionId: id(4),
      nodes,
      topologicalOrder: nodes.map((node) => node.nodeId),
    },
    activeReconciliation: null,
    lastGraphRevisionNumber: 1,
  };
}

function operations(...kinds: readonly HarnessRouteOperationKind[]) {
  return kinds.map((kind, index) => Object.freeze({ operationId: id(300 + index), kind }));
}

describe("node execution admission policy", () => {
  it("routes a confirmed answer to fast and grants a read-only envelope", () => {
    const result = evaluateNodeExecutionAdmission(task(), id(100), operations("answer"), true);

    expect(result).toMatchObject({
      rejectionReason: null,
      features: {
        taskKind: "simple",
        complexity: "low",
        scope: "isolated",
        estimatedSteps: 1,
        toolBreadth: "none",
      },
      permission: {
        workspaceMode: "read_only",
        commandExecution: false,
        networkAccess: false,
        allowedOperationKinds: ["answer"],
      },
    });
  });

  it("routes ordinary code work to standard and requires command-backed validation", () => {
    expect(
      evaluateNodeExecutionAdmission(task(), id(100), operations("modify_workspace"), true),
    ).toMatchObject({ rejectionReason: "validation_command_required", permission: null });

    expect(
      evaluateNodeExecutionAdmission(
        task(),
        id(100),
        operations("modify_workspace", "run_workspace_command"),
        true,
      ),
    ).toMatchObject({
      rejectionReason: null,
      features: { taskKind: "code_change", toolBreadth: "multiple" },
      permission: { workspaceMode: "workspace_write", commandExecution: true },
    });
  });

  it("rejects missing confirmation and every operation outside the MVP envelope", () => {
    expect(
      evaluateNodeExecutionAdmission(task(), id(100), operations("answer"), false),
    ).toMatchObject({
      rejectionReason: "user_confirmation_required",
      permission: null,
    });

    for (const kind of [
      "network_read",
      "credential_access",
      "external_write",
      "database_migration",
      "production_change",
      "irreversible_action",
      "permission_boundary_change",
      "concurrent_change",
      "user_interaction",
    ] as const) {
      expect(evaluateNodeExecutionAdmission(task(), id(100), operations(kind), true)).toMatchObject(
        {
          rejectionReason: "operation_not_allowed",
          permission: null,
        },
      );
    }
  });

  it("raises architecture, systemic, structural, tool and safety signals deterministically", () => {
    expect(
      buildActiveRouteFeatures(task(3), id(100), operations("architecture_decision")),
    ).toMatchObject({
      taskKind: "architecture",
      complexity: "medium",
      scope: "module",
    });
    expect(
      buildActiveRouteFeatures(task(9), id(100), operations("systemic_diagnosis")),
    ).toMatchObject({
      taskKind: "systemic_diagnosis",
      complexity: "high",
      scope: "cross_system",
      toolBreadth: "multiple",
    });
    expect(
      buildActiveRouteFeatures(
        task(1, 9),
        id(100),
        operations("irreversible_action", "public_api_change", "permission_boundary_change"),
      ),
    ).toMatchObject({
      complexity: "high",
      toolBreadth: "extensive",
      safety: {
        securitySensitive: true,
        publicApiChange: true,
        irreversibleOperation: true,
        permissionBoundaryChange: true,
      },
    });
    expect(
      buildActiveRouteFeatures(
        task(),
        id(100),
        operations("database_migration", "concurrent_change", "production_change"),
      ),
    ).toMatchObject({
      safety: { dataMigration: true, concurrencySensitive: true, productionImpact: true },
    });
  });
});
