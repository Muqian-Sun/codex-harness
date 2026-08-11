import type { HarnessExecutionAdmissionRejectionReason } from "@codex-harness/protocol";

import type {
  ModelRouteFeatures,
  ModelRouteSafetySignals,
  ModelRouteTaskKind,
  ModelRouteToolBreadth,
} from "./model-route-classifier.js";
import type {
  HarnessRouteOperation,
  HarnessRouteOperationKind,
} from "./harness-route-operation.js";
import type { TaskPlanRecord } from "./task-plan-store.js";

export const NODE_EXECUTION_ADMISSION_POLICY_VERSION =
  "node-execution-admission-policy-v1" as const;
export const NODE_EXECUTION_PERMISSION_POLICY_VERSION =
  "node-execution-permission-policy-v1" as const;

export const EXECUTION_ALLOWED_OPERATION_KINDS = Object.freeze([
  "answer",
  "inspect_workspace",
  "modify_workspace",
  "run_workspace_command",
  "public_api_change",
  "architecture_decision",
  "systemic_diagnosis",
] as const satisfies readonly HarnessRouteOperationKind[]);

export const EXECUTION_DENIED_OPERATION_KINDS = Object.freeze([
  "network_read",
  "credential_access",
  "external_write",
  "database_migration",
  "production_change",
  "irreversible_action",
  "permission_boundary_change",
  "concurrent_change",
  "user_interaction",
] as const satisfies readonly HarnessRouteOperationKind[]);

export type NodeExecutionPermissionEnvelope = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof NODE_EXECUTION_PERMISSION_POLICY_VERSION;
  workspaceMode: "read_only" | "workspace_write";
  commandExecution: boolean;
  networkAccess: false;
  allowedOperationKinds: readonly HarnessRouteOperationKind[];
}>;

export type NodeExecutionAdmissionEvaluation = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof NODE_EXECUTION_ADMISSION_POLICY_VERSION;
  features: ModelRouteFeatures;
  permission: NodeExecutionPermissionEnvelope | null;
  rejectionReason: HarnessExecutionAdmissionRejectionReason | null;
}>;

const ALLOWED = new Set<HarnessRouteOperationKind>(EXECUTION_ALLOWED_OPERATION_KINDS);
const MUTATION_KINDS = new Set<HarnessRouteOperationKind>([
  "modify_workspace",
  "public_api_change",
]);

const TOOL_CLASSES: Readonly<Record<HarnessRouteOperationKind, readonly string[]>> = Object.freeze({
  answer: Object.freeze([]),
  inspect_workspace: Object.freeze(["workspace_read"]),
  modify_workspace: Object.freeze(["workspace_write"]),
  run_workspace_command: Object.freeze(["command_execution"]),
  network_read: Object.freeze(["network_access"]),
  credential_access: Object.freeze(["credential_access"]),
  external_write: Object.freeze(["network_access", "external_write"]),
  database_migration: Object.freeze(["workspace_write", "command_execution"]),
  production_change: Object.freeze(["network_access", "external_write"]),
  irreversible_action: Object.freeze([
    "workspace_write",
    "command_execution",
    "network_access",
    "external_write",
  ]),
  permission_boundary_change: Object.freeze(["workspace_write"]),
  public_api_change: Object.freeze(["workspace_write"]),
  concurrent_change: Object.freeze(["workspace_write"]),
  architecture_decision: Object.freeze(["workspace_read"]),
  systemic_diagnosis: Object.freeze(["workspace_read", "command_execution"]),
  user_interaction: Object.freeze(["user_interaction"]),
});

export function evaluateNodeExecutionAdmission(
  task: TaskPlanRecord,
  nodeId: string,
  operations: readonly HarnessRouteOperation[],
  userConfirmed: boolean,
): NodeExecutionAdmissionEvaluation {
  const features = buildActiveRouteFeatures(task, nodeId, operations);
  const kinds = new Set(operations.map((operation) => operation.kind));
  let rejectionReason: HarnessExecutionAdmissionRejectionReason | null = null;
  if (!userConfirmed) {
    rejectionReason = "user_confirmation_required";
  } else if ([...kinds].some((kind) => !ALLOWED.has(kind))) {
    rejectionReason = "operation_not_allowed";
  } else if (
    [...kinds].some((kind) => MUTATION_KINDS.has(kind)) &&
    !kinds.has("run_workspace_command")
  ) {
    rejectionReason = "validation_command_required";
  }

  return Object.freeze({
    schemaVersion: 1,
    policyVersion: NODE_EXECUTION_ADMISSION_POLICY_VERSION,
    features,
    permission:
      rejectionReason === null
        ? Object.freeze({
            schemaVersion: 1,
            policyVersion: NODE_EXECUTION_PERMISSION_POLICY_VERSION,
            workspaceMode: [...kinds].some((kind) => MUTATION_KINDS.has(kind))
              ? "workspace_write"
              : "read_only",
            commandExecution: kinds.has("run_workspace_command") || kinds.has("systemic_diagnosis"),
            networkAccess: false,
            allowedOperationKinds: Object.freeze([...kinds].sort()),
          })
        : null,
    rejectionReason,
  });
}

export function buildActiveRouteFeatures(
  task: TaskPlanRecord,
  nodeId: string,
  operations: readonly HarnessRouteOperation[],
): ModelRouteFeatures {
  const kinds = new Set(operations.map((operation) => operation.kind));
  const graphSize = task.activeGraph?.nodes.length ?? 0;
  const dependencyCount =
    task.activeGraph?.nodes.reduce((total, node) => total + node.dependsOnNodeIds.length, 0) ?? 0;
  const dependencyClosureSize = countDependencyClosure(task, nodeId);
  const requirementSize =
    task.activeRequirement.constraints.length + task.activeRequirement.acceptanceCriteria.length;
  const structuralSize = Math.max(
    graphSize,
    dependencyCount,
    dependencyClosureSize,
    requirementSize,
  );
  const complexity = structuralSize >= 9 ? "high" : structuralSize >= 3 ? "medium" : "low";
  const tools = new Set([...kinds].flatMap((kind) => TOOL_CLASSES[kind]));
  const toolBreadth: ModelRouteToolBreadth =
    tools.size === 0
      ? "none"
      : tools.size === 1
        ? "single"
        : tools.size >= 4
          ? "extensive"
          : "multiple";
  const safety: ModelRouteSafetySignals = Object.freeze({
    securitySensitive: kinds.has("credential_access") || kinds.has("permission_boundary_change"),
    dataMigration: kinds.has("database_migration"),
    concurrencySensitive: kinds.has("concurrent_change"),
    publicApiChange: kinds.has("public_api_change"),
    productionImpact: kinds.has("production_change"),
    irreversibleOperation: kinds.has("irreversible_action"),
    permissionBoundaryChange: kinds.has("permission_boundary_change"),
  });
  return Object.freeze({
    schemaVersion: 1,
    taskKind: deriveTaskKind(kinds),
    complexity,
    scope:
      graphSize <= 1 && dependencyCount === 0
        ? "isolated"
        : complexity === "high"
          ? "cross_system"
          : "module",
    ambiguity: "low",
    estimatedSteps: Math.max(1, graphSize, dependencyClosureSize + 1),
    toolBreadth,
    safety,
  });
}

function countDependencyClosure(task: TaskPlanRecord, nodeId: string): number {
  const graph = task.activeGraph;
  if (graph === null) return 0;
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const visited = new Set<string>();
  const pending = [...(nodes.get(nodeId)?.dependsOnNodeIds ?? [])];
  while (pending.length > 0) {
    const dependencyId = pending.pop()!;
    if (visited.has(dependencyId)) continue;
    visited.add(dependencyId);
    pending.push(...(nodes.get(dependencyId)?.dependsOnNodeIds ?? []));
  }
  return visited.size;
}

function deriveTaskKind(kinds: ReadonlySet<HarnessRouteOperationKind>): ModelRouteTaskKind {
  if (kinds.has("systemic_diagnosis")) return "systemic_diagnosis";
  if (kinds.has("architecture_decision")) return "architecture";
  if ([...kinds].some((kind) => MUTATION_KINDS.has(kind))) return "code_change";
  if (kinds.size === 1 && kinds.has("answer")) return "simple";
  return "analysis";
}
