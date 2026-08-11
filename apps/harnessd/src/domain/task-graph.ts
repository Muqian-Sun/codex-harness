import { validateJsonValue } from "@codex-harness/protocol";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_GRAPH_NODES = 200;
const MAX_DEPENDENCIES = 2_000;
const MAX_NODE_TITLE_BYTES = 512;
const MAX_NODE_DESCRIPTION_BYTES = 8 * 1024;
const MAX_ACCEPTANCE_ITEM_BYTES = 4 * 1024;
const MAX_ACCEPTANCE_ITEMS = 100;
const MAX_GRAPH_TEXT_BYTES = 128 * 1024;
const MAX_GRAPH_DRAFT_JSON_BYTES = 192 * 1024;
const MAX_GRAPH_REVISION_JSON_BYTES = 224 * 1024;

export type TaskNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export type TaskNodeDraft = Readonly<{
  nodeId: string;
  sourcePlanStepId: string;
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
  dependsOnNodeIds: readonly string[];
}>;

export type TaskGraphDraft = Readonly<{
  revisionId: string;
  basedOnPlanRevisionId: string;
  nodes: readonly TaskNodeDraft[];
}>;

export type TaskNode = TaskNodeDraft & Readonly<{ status: TaskNodeStatus }>;

export type TaskGraphRevision = Readonly<{
  revisionId: string;
  revisionNumber: number;
  basedOnPlanRevisionId: string;
  nodes: readonly TaskNode[];
  topologicalOrder: readonly string[];
}>;

export class TaskGraphValidationError extends Error {
  constructor() {
    super("The Harness task graph is invalid.");
    this.name = "TaskGraphValidationError";
  }
}

export function normalizeTaskGraphDraft(
  input: unknown,
  allowedPlanStepIds?: readonly string[],
): TaskGraphDraft {
  assertJsonValue(input);
  const allowedSteps =
    allowedPlanStepIds === undefined ? undefined : normalizeAllowedPlanStepIds(allowedPlanStepIds);
  const record = requireRecord(input, ["basedOnPlanRevisionId", "nodes", "revisionId"]);
  const nodes = normalizeNodes(record.nodes, allowedSteps, false).map(({ node }) => node);
  const normalized = freezeDraft({
    revisionId: requireUuid(record.revisionId),
    basedOnPlanRevisionId: requireUuid(record.basedOnPlanRevisionId),
    nodes: Object.freeze(nodes),
  });
  validateGraph(normalized.nodes, allowedSteps);
  requireGraphBudget(normalized, MAX_GRAPH_DRAFT_JSON_BYTES);
  return normalized;
}

export function materializeTaskGraph(
  draft: TaskGraphDraft,
  revisionNumber: number,
): TaskGraphRevision {
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
    throw new TaskGraphValidationError();
  }
  const normalized = normalizeTaskGraphDraft(draft);
  const nodes = Object.freeze(
    normalized.nodes.map((node) => Object.freeze({ ...node, status: "pending" as const })),
  );
  const materialized = Object.freeze({
    revisionId: normalized.revisionId,
    revisionNumber,
    basedOnPlanRevisionId: normalized.basedOnPlanRevisionId,
    nodes,
    topologicalOrder: computeTopologicalOrder(nodes),
  });
  requireGraphBudget(materialized, MAX_GRAPH_REVISION_JSON_BYTES);
  return materialized;
}

export function decodeTaskGraphRevision(
  input: unknown,
  allowedPlanStepIds: readonly string[],
): TaskGraphRevision {
  assertJsonValue(input);
  const allowedSteps = normalizeAllowedPlanStepIds(allowedPlanStepIds);
  const record = requireRecord(input, [
    "basedOnPlanRevisionId",
    "nodes",
    "revisionId",
    "revisionNumber",
    "topologicalOrder",
  ]);
  const normalizedNodes = normalizeNodes(record.nodes, allowedSteps, true);
  const nodes = Object.freeze(
    normalizedNodes.map(({ node, status }) => {
      if (status === undefined) {
        throw new TaskGraphValidationError();
      }
      return Object.freeze({ ...node, status });
    }),
  );
  validateGraph(nodes, allowedSteps);
  const expectedOrder = computeTopologicalOrder(nodes);
  const topologicalOrder = requireUuidArray(record.topologicalOrder, MAX_GRAPH_NODES);
  if (
    topologicalOrder.length !== expectedOrder.length ||
    topologicalOrder.some((nodeId, index) => nodeId !== expectedOrder[index])
  ) {
    throw new TaskGraphValidationError();
  }
  const decoded = Object.freeze({
    revisionId: requireUuid(record.revisionId),
    revisionNumber: requirePositiveInteger(record.revisionNumber),
    basedOnPlanRevisionId: requireUuid(record.basedOnPlanRevisionId),
    nodes,
    topologicalOrder,
  });
  requireGraphBudget(decoded, MAX_GRAPH_REVISION_JSON_BYTES);
  return decoded;
}

function normalizeAllowedPlanStepIds(input: readonly string[]): ReadonlySet<string> {
  assertJsonValue(input);
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_GRAPH_NODES) {
    throw new TaskGraphValidationError();
  }
  const ids = input.map((value) => requireUuid(value));
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new TaskGraphValidationError();
  }
  return unique;
}

function normalizeNodes(
  input: unknown,
  allowedPlanStepIds: ReadonlySet<string> | undefined,
  includeStatus: boolean,
): readonly Readonly<{ node: TaskNodeDraft; status?: TaskNodeStatus }>[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_GRAPH_NODES) {
    throw new TaskGraphValidationError();
  }
  let dependencyCount = 0;
  let textBytes = 0;
  const normalized = [] as Readonly<{ node: TaskNodeDraft; status?: TaskNodeStatus }>[];
  for (const value of input) {
    const record = requireRecord(value, [
      "acceptanceCriteria",
      "dependsOnNodeIds",
      "description",
      "nodeId",
      "sourcePlanStepId",
      "title",
      ...(includeStatus ? ["status"] : []),
    ]);
    const sourcePlanStepId = requireUuid(record.sourcePlanStepId);
    if (allowedPlanStepIds !== undefined && !allowedPlanStepIds.has(sourcePlanStepId)) {
      throw new TaskGraphValidationError();
    }
    const title = requireText(record.title, MAX_NODE_TITLE_BYTES);
    const description = requireText(record.description, MAX_NODE_DESCRIPTION_BYTES);
    const acceptanceCriteria = requireTextArray(
      record.acceptanceCriteria,
      MAX_ACCEPTANCE_ITEMS,
      MAX_ACCEPTANCE_ITEM_BYTES,
    );
    const dependsOnNodeIds = requireUuidArray(record.dependsOnNodeIds, MAX_GRAPH_NODES);
    dependencyCount += dependsOnNodeIds.length;
    textBytes += [title, description, ...acceptanceCriteria].reduce(
      (total, text) => total + Buffer.byteLength(text, "utf8"),
      0,
    );
    if (dependencyCount > MAX_DEPENDENCIES || textBytes > MAX_GRAPH_TEXT_BYTES) {
      throw new TaskGraphValidationError();
    }
    const node = Object.freeze({
      nodeId: requireUuid(record.nodeId),
      sourcePlanStepId,
      title,
      description,
      acceptanceCriteria,
      dependsOnNodeIds,
    });
    normalized.push(
      Object.freeze({
        node,
        ...(includeStatus ? { status: requireNodeStatus(record.status) } : {}),
      }),
    );
  }
  return Object.freeze(normalized);
}

function validateGraph(
  nodes: readonly TaskNodeDraft[],
  allowedPlanStepIds: ReadonlySet<string> | undefined,
): void {
  const nodeIds = new Set<string>();
  const coveredPlanStepIds = new Set<string>();
  let dependencyCount = 0;
  for (const node of nodes) {
    if (nodeIds.has(node.nodeId)) {
      throw new TaskGraphValidationError();
    }
    nodeIds.add(node.nodeId);
    coveredPlanStepIds.add(node.sourcePlanStepId);
    dependencyCount += node.dependsOnNodeIds.length;
    if (
      dependencyCount > MAX_DEPENDENCIES ||
      new Set(node.dependsOnNodeIds).size !== node.dependsOnNodeIds.length ||
      node.dependsOnNodeIds.includes(node.nodeId)
    ) {
      throw new TaskGraphValidationError();
    }
  }
  if (
    (allowedPlanStepIds !== undefined &&
      (coveredPlanStepIds.size !== allowedPlanStepIds.size ||
        [...allowedPlanStepIds].some((stepId) => !coveredPlanStepIds.has(stepId)))) ||
    nodes.some((node) => node.dependsOnNodeIds.some((dependencyId) => !nodeIds.has(dependencyId)))
  ) {
    throw new TaskGraphValidationError();
  }
  computeTopologicalOrder(nodes);
}

function computeTopologicalOrder(nodes: readonly TaskNodeDraft[]): readonly string[] {
  const sourceIndex = new Map(nodes.map((node, index) => [node.nodeId, index]));
  const indegrees = new Map(nodes.map((node) => [node.nodeId, node.dependsOnNodeIds.length]));
  const dependents = new Map(nodes.map((node) => [node.nodeId, [] as string[]]));
  for (const node of nodes) {
    for (const dependencyId of node.dependsOnNodeIds) {
      dependents.get(dependencyId)?.push(node.nodeId);
    }
  }
  const available = nodes
    .filter((node) => node.dependsOnNodeIds.length === 0)
    .map((node) => node.nodeId);
  const ordered: string[] = [];
  while (available.length > 0) {
    available.sort((left, right) => {
      const leftIndex = sourceIndex.get(left);
      const rightIndex = sourceIndex.get(right);
      if (leftIndex === undefined || rightIndex === undefined) {
        throw new TaskGraphValidationError();
      }
      return leftIndex - rightIndex;
    });
    const nodeId = available.shift();
    if (nodeId === undefined) {
      break;
    }
    ordered.push(nodeId);
    for (const dependentId of dependents.get(nodeId) ?? []) {
      const nextIndegree = (indegrees.get(dependentId) ?? 0) - 1;
      indegrees.set(dependentId, nextIndegree);
      if (nextIndegree === 0) {
        available.push(dependentId);
      }
    }
  }
  if (ordered.length !== nodes.length) {
    throw new TaskGraphValidationError();
  }
  return Object.freeze(ordered);
}

function freezeDraft(input: TaskGraphDraft): TaskGraphDraft {
  return Object.freeze(input);
}

function requireRecord(input: unknown, required: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TaskGraphValidationError();
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TaskGraphValidationError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set(required);
  const keys = Reflect.ownKeys(descriptors);
  if (
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    keys.some((key) => {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new TaskGraphValidationError();
  }
  return input as Record<string, unknown>;
}

function requireText(input: unknown, maxBytes: number): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    Buffer.byteLength(input, "utf8") > maxBytes
  ) {
    throw new TaskGraphValidationError();
  }
  return input;
}

function requireTextArray(input: unknown, maxItems: number, maxBytes: number): readonly string[] {
  if (!Array.isArray(input) || input.length > maxItems) {
    throw new TaskGraphValidationError();
  }
  return Object.freeze(input.map((value) => requireText(value, maxBytes)));
}

function requireUuidArray(input: unknown, maxItems: number): readonly string[] {
  if (!Array.isArray(input) || input.length > maxItems) {
    throw new TaskGraphValidationError();
  }
  return Object.freeze(input.map((value) => requireUuid(value)));
}

function requireUuid(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new TaskGraphValidationError();
  }
  return input;
}

function requirePositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new TaskGraphValidationError();
  }
  return input as number;
}

function requireNodeStatus(input: unknown): TaskNodeStatus {
  if (
    input !== "pending" &&
    input !== "ready" &&
    input !== "running" &&
    input !== "blocked" &&
    input !== "succeeded" &&
    input !== "failed" &&
    input !== "interrupted" &&
    input !== "cancelled"
  ) {
    throw new TaskGraphValidationError();
  }
  return input;
}

function requireGraphBudget(input: unknown, maxBytes: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new TaskGraphValidationError();
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new TaskGraphValidationError();
  }
}

function assertJsonValue(input: unknown): void {
  if (!validateJsonValue(input).ok) {
    throw new TaskGraphValidationError();
  }
}
