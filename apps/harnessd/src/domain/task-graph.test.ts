import { describe, expect, it } from "vitest";

import {
  TaskGraphValidationError,
  decodeTaskGraphRevision,
  materializeTaskGraph,
  normalizeTaskGraphDraft,
  type TaskGraphDraft,
  type TaskNodeDraft,
} from "./task-graph.js";

const PLAN_REVISION_ID = "00000000-0000-4000-8000-000000000001";
const GRAPH_REVISION_ID = "00000000-0000-4000-8000-000000000002";
const STEP_ONE_ID = "00000000-0000-4000-8000-000000000003";
const STEP_TWO_ID = "00000000-0000-4000-8000-000000000004";
const NODE_ONE_ID = "00000000-0000-4000-8000-000000000005";
const NODE_TWO_ID = "00000000-0000-4000-8000-000000000006";
const NODE_THREE_ID = "00000000-0000-4000-8000-000000000007";

function node(overrides?: Partial<TaskNodeDraft>): TaskNodeDraft {
  return {
    nodeId: NODE_ONE_ID,
    sourcePlanStepId: STEP_ONE_ID,
    title: "规范化持久任务",
    description: "把计划步骤转换为可调度但尚未就绪的节点。",
    acceptanceCriteria: ["节点和依赖可在重启后恢复"],
    dependsOnNodeIds: [],
    ...overrides,
  };
}

function graph(nodes: readonly TaskNodeDraft[]): TaskGraphDraft {
  return {
    revisionId: GRAPH_REVISION_ID,
    basedOnPlanRevisionId: PLAN_REVISION_ID,
    nodes,
  };
}

describe("task graph normalization", () => {
  it("assigns pending status and computes a deterministic topological order", () => {
    const draft = normalizeTaskGraphDraft(
      graph([
        node({
          nodeId: NODE_THREE_ID,
          sourcePlanStepId: STEP_TWO_ID,
          title: "汇总结果",
          dependsOnNodeIds: [NODE_ONE_ID, NODE_TWO_ID],
        }),
        node({ nodeId: NODE_TWO_ID, title: "并列根节点" }),
        node({ nodeId: NODE_ONE_ID, title: "首个根节点" }),
      ]),
      [STEP_ONE_ID, STEP_TWO_ID],
    );
    const materialized = materializeTaskGraph(draft, 3);

    expect(materialized).toMatchObject({
      revisionId: GRAPH_REVISION_ID,
      revisionNumber: 3,
      basedOnPlanRevisionId: PLAN_REVISION_ID,
      topologicalOrder: [NODE_TWO_ID, NODE_ONE_ID, NODE_THREE_ID],
    });
    expect(materialized.nodes.map((candidate) => candidate.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(Object.isFrozen(materialized.nodes)).toBe(true);
    expect(Object.isFrozen(materialized.nodes[0]?.dependsOnNodeIds)).toBe(true);
  });

  it("rejects cycles, missing references, self dependencies, and duplicate node IDs", () => {
    const cases = [
      graph([
        node({ nodeId: NODE_ONE_ID, dependsOnNodeIds: [NODE_TWO_ID] }),
        node({ nodeId: NODE_TWO_ID, dependsOnNodeIds: [NODE_ONE_ID] }),
      ]),
      graph([node({ dependsOnNodeIds: [NODE_TWO_ID] })]),
      graph([node({ dependsOnNodeIds: [NODE_ONE_ID] })]),
      graph([node(), node()]),
      graph([
        node({ nodeId: NODE_ONE_ID, dependsOnNodeIds: [NODE_TWO_ID, NODE_TWO_ID] }),
        node({ nodeId: NODE_TWO_ID }),
      ]),
    ];

    for (const candidate of cases) {
      expect(() => normalizeTaskGraphDraft(candidate, [STEP_ONE_ID])).toThrowError(
        TaskGraphValidationError,
      );
    }
  });

  it("requires exact coverage of every confirmed plan step", () => {
    expect(() => normalizeTaskGraphDraft(graph([node()]), [STEP_ONE_ID, STEP_TWO_ID])).toThrowError(
      TaskGraphValidationError,
    );
    expect(() =>
      normalizeTaskGraphDraft(graph([node({ sourcePlanStepId: STEP_TWO_ID })]), [STEP_ONE_ID]),
    ).toThrowError(TaskGraphValidationError);

    const covered = normalizeTaskGraphDraft(
      graph([
        node(),
        node({ nodeId: NODE_TWO_ID, sourcePlanStepId: STEP_TWO_ID }),
        node({ nodeId: NODE_THREE_ID, sourcePlanStepId: STEP_TWO_ID }),
      ]),
      [STEP_ONE_ID, STEP_TWO_ID],
    );
    expect(covered.nodes).toHaveLength(3);
  });

  it("rejects non-JSON, accessor, unexpected, and oversized graph input", () => {
    const accessorNode = node();
    Object.defineProperty(accessorNode, "title", {
      enumerable: true,
      get: () => "secret accessor",
    });
    expect(() => normalizeTaskGraphDraft(graph([accessorNode]))).toThrowError(
      TaskGraphValidationError,
    );
    expect(() => normalizeTaskGraphDraft({ ...graph([node()]), unexpected: true })).toThrowError(
      TaskGraphValidationError,
    );
    expect(() =>
      normalizeTaskGraphDraft(graph([node({ description: "x".repeat(8 * 1024 + 1) })])),
    ).toThrowError(TaskGraphValidationError);
    const oversizedNodes = Array.from({ length: 17 }, (_, index) =>
      node({
        nodeId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        description: "x".repeat(8 * 1024),
      }),
    );
    expect(() => normalizeTaskGraphDraft(graph(oversizedNodes))).toThrowError(
      TaskGraphValidationError,
    );
    expect(() => normalizeTaskGraphDraft(graph([node()]), [] as never)).toThrowError(
      TaskGraphValidationError,
    );
  });

  it("decodes only canonical topology and known node states", () => {
    const materialized = materializeTaskGraph(
      normalizeTaskGraphDraft(
        graph([
          node(),
          node({
            nodeId: NODE_TWO_ID,
            sourcePlanStepId: STEP_TWO_ID,
            dependsOnNodeIds: [NODE_ONE_ID],
          }),
        ]),
        [STEP_ONE_ID, STEP_TWO_ID],
      ),
      1,
    );

    expect(decodeTaskGraphRevision(materialized, [STEP_ONE_ID, STEP_TWO_ID])).toEqual(materialized);
    expect(() =>
      decodeTaskGraphRevision(
        { ...materialized, topologicalOrder: [...materialized.topologicalOrder].reverse() },
        [STEP_ONE_ID, STEP_TWO_ID],
      ),
    ).toThrowError(TaskGraphValidationError);
    expect(() =>
      decodeTaskGraphRevision(
        {
          ...materialized,
          nodes: materialized.nodes.map((candidate, index) =>
            index === 0 ? { ...candidate, status: "unknown" } : candidate,
          ),
        },
        [STEP_ONE_ID, STEP_TWO_ID],
      ),
    ).toThrowError(TaskGraphValidationError);
  });
});
