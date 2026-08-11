import { describe, expect, it } from "vitest";

import type { TaskGraphRevision, TaskNodeStatus } from "./task-graph.js";
import { SerialTaskSchedulerError, previewSerialTaskSchedule } from "./serial-task-scheduler.js";

const NODE_A = "00000000-0000-4000-8000-000000000101";
const NODE_B = "00000000-0000-4000-8000-000000000102";
const NODE_C = "00000000-0000-4000-8000-000000000103";

describe("previewSerialTaskSchedule", () => {
  it("selects the first dependency-eligible pending node in topological order", () => {
    const preview = previewSerialTaskSchedule(graph({ a: "pending", b: "pending", c: "pending" }));

    expect(preview).toEqual({ state: "dependency_eligible", nodeId: NODE_A });
    expect(Object.isFrozen(preview)).toBe(true);
  });

  it("moves deterministically to the next node after its dependency succeeds", () => {
    expect(
      previewSerialTaskSchedule(graph({ a: "succeeded", b: "pending", c: "pending" })),
    ).toEqual({ state: "dependency_eligible", nodeId: NODE_B });
  });

  it("reports a persisted ready node as awaiting claim", () => {
    expect(previewSerialTaskSchedule(graph({ a: "succeeded", b: "ready", c: "pending" }))).toEqual({
      state: "awaiting_claim",
      nodeId: NODE_B,
    });
  });

  it("reports the single running node as busy", () => {
    expect(
      previewSerialTaskSchedule(graph({ a: "succeeded", b: "running", c: "pending" })),
    ).toEqual({
      state: "busy",
      nodeId: NODE_B,
    });
  });

  it("reports terminal blockers in topological order when no node can advance", () => {
    const preview = previewSerialTaskSchedule(
      graph({ a: "failed", b: "pending", c: "interrupted" }),
    );

    expect(preview).toEqual({ state: "blocked", blockerNodeIds: [NODE_A, NODE_C] });
    if (preview.state !== "blocked") {
      throw new Error("Expected a blocked preview.");
    }
    expect(Object.isFrozen(preview.blockerNodeIds)).toBe(true);
  });

  it("continues an independent eligible branch before reporting unrelated blockers", () => {
    const input = graph(
      { a: "failed", b: "pending", c: "pending" },
      { bDependsOnA: false, cDependsOnB: true },
    );

    expect(previewSerialTaskSchedule(input)).toEqual({
      state: "dependency_eligible",
      nodeId: NODE_B,
    });
  });

  it("reports complete only when every node succeeded", () => {
    expect(
      previewSerialTaskSchedule(graph({ a: "succeeded", b: "succeeded", c: "succeeded" })),
    ).toEqual({ state: "complete" });
  });

  it.each([
    { a: "ready", b: "ready", c: "pending" },
    { a: "running", b: "running", c: "pending" },
    { a: "ready", b: "running", c: "pending" },
    { a: "pending", b: "ready", c: "pending" },
  ] satisfies readonly Record<"a" | "b" | "c", TaskNodeStatus>[])(
    "fails closed for an inconsistent serial state: %j",
    (statuses) => {
      expect(() => previewSerialTaskSchedule(graph(statuses))).toThrow(SerialTaskSchedulerError);
    },
  );

  it("fails closed when the topological order is not a unique total node order", () => {
    const input = graph({ a: "pending", b: "pending", c: "pending" });
    const malformed = { ...input, topologicalOrder: [NODE_A, NODE_A, NODE_C] };

    expect(() => previewSerialTaskSchedule(malformed)).toThrow(SerialTaskSchedulerError);
  });

  it("fails closed when a dependency does not exist in the graph", () => {
    const input = graph({ a: "pending", b: "pending", c: "pending" });
    const malformed = {
      ...input,
      nodes: [
        input.nodes[0]!,
        { ...input.nodes[1]!, dependsOnNodeIds: ["00000000-0000-4000-8000-000000000199"] },
        input.nodes[2]!,
      ],
    };

    expect(() => previewSerialTaskSchedule(malformed)).toThrow(SerialTaskSchedulerError);
  });
});

function graph(
  statuses: Readonly<Record<"a" | "b" | "c", TaskNodeStatus>>,
  dependencies: Readonly<{ bDependsOnA: boolean; cDependsOnB: boolean }> = {
    bDependsOnA: true,
    cDependsOnB: true,
  },
): TaskGraphRevision {
  return Object.freeze({
    revisionId: "00000000-0000-4000-8000-000000000100",
    revisionNumber: 1,
    basedOnPlanRevisionId: "00000000-0000-4000-8000-000000000090",
    nodes: Object.freeze([
      node(NODE_C, statuses.c, dependencies.cDependsOnB ? [NODE_B] : []),
      node(NODE_A, statuses.a, []),
      node(NODE_B, statuses.b, dependencies.bDependsOnA ? [NODE_A] : []),
    ]),
    topologicalOrder: Object.freeze([NODE_A, NODE_B, NODE_C]),
  });
}

function node(nodeId: string, status: TaskNodeStatus, dependsOnNodeIds: readonly string[]) {
  return Object.freeze({
    nodeId,
    sourcePlanStepId: nodeId,
    title: nodeId,
    description: nodeId,
    acceptanceCriteria: Object.freeze([]),
    dependsOnNodeIds: Object.freeze([...dependsOnNodeIds]),
    status,
  });
}
