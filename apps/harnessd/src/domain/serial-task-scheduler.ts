import type { TaskGraphRevision, TaskNode } from "./task-graph.js";

export type SerialSchedulePreview =
  | Readonly<{ state: "dependency_eligible"; nodeId: string }>
  | Readonly<{ state: "awaiting_claim"; nodeId: string }>
  | Readonly<{ state: "busy"; nodeId: string }>
  | Readonly<{ state: "blocked"; blockerNodeIds: readonly string[] }>
  | Readonly<{ state: "complete" }>;

export class SerialTaskSchedulerError extends Error {
  constructor() {
    super("The Harness serial task schedule is invalid.");
    this.name = "SerialTaskSchedulerError";
  }
}

const BLOCKING_STATUSES = new Set<TaskNode["status"]>([
  "blocked",
  "cancelled",
  "failed",
  "interrupted",
]);

export function previewSerialTaskSchedule(graph: TaskGraphRevision): SerialSchedulePreview {
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const orderedNodes = graph.topologicalOrder.map((nodeId) => nodesById.get(nodeId));
  if (
    orderedNodes.length !== graph.nodes.length ||
    orderedNodes.some((node) => node === undefined) ||
    new Set(graph.topologicalOrder).size !== graph.nodes.length
  ) {
    throw new SerialTaskSchedulerError();
  }

  const nodes = orderedNodes as readonly TaskNode[];
  const ready = nodes.filter((node) => node.status === "ready");
  const running = nodes.filter((node) => node.status === "running");
  if (ready.length > 1 || running.length > 1 || (ready.length > 0 && running.length > 0)) {
    throw new SerialTaskSchedulerError();
  }
  for (const node of [...ready, ...running]) {
    if (!dependenciesSucceeded(node, nodesById)) {
      throw new SerialTaskSchedulerError();
    }
  }

  const runningNode = running[0];
  if (runningNode !== undefined) {
    return Object.freeze({ state: "busy", nodeId: runningNode.nodeId });
  }
  const readyNode = ready[0];
  if (readyNode !== undefined) {
    return Object.freeze({ state: "awaiting_claim", nodeId: readyNode.nodeId });
  }

  const dependencyEligible = nodes.find(
    (node) => node.status === "pending" && dependenciesSucceeded(node, nodesById),
  );
  if (dependencyEligible !== undefined) {
    return Object.freeze({ state: "dependency_eligible", nodeId: dependencyEligible.nodeId });
  }
  if (nodes.every((node) => node.status === "succeeded")) {
    return Object.freeze({ state: "complete" });
  }

  const blockerNodeIds = nodes
    .filter((node) => BLOCKING_STATUSES.has(node.status))
    .map((node) => node.nodeId);
  if (blockerNodeIds.length === 0) {
    throw new SerialTaskSchedulerError();
  }
  return Object.freeze({ state: "blocked", blockerNodeIds: Object.freeze(blockerNodeIds) });
}

function dependenciesSucceeded(node: TaskNode, nodesById: ReadonlyMap<string, TaskNode>): boolean {
  return node.dependsOnNodeIds.every(
    (dependencyId) => nodesById.get(dependencyId)?.status === "succeeded",
  );
}
