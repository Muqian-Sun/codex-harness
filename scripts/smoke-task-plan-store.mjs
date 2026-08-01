import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function smokeTaskPlanStore() {
  const directory = await mkdtemp(join(tmpdir(), "ch-task-plan-smoke-"));
  await chmod(directory, 0o700);
  const path = join(directory, "harness.db");
  let store;
  try {
    const { TaskPlanStore } = await import("../apps/harnessd/dist/domain/task-plan-store.js");
    store = await TaskPlanStore.open({ path, now: () => 1_750_000_000_000 });
    store.createTask({
      eventId: "00000000-0000-4000-8000-000000000003",
      taskId: "00000000-0000-4000-8000-000000000002",
      title: "compiled task plan smoke",
      occurredAtMs: 1_750_000_000_001,
      requirement: {
        revisionId: "00000000-0000-4000-8000-000000000003",
        sourceText: "Persist this task plan.",
        objective: "Recover the task after reopening the compiled store.",
        constraints: ["Keep the store internal."],
        acceptanceCriteria: ["The task is readable after reopen."],
      },
      metadata: { actor: "system.smoke" },
    });
    store.revisePlan({
      eventId: "00000000-0000-4000-8000-000000000004",
      taskId: "00000000-0000-4000-8000-000000000002",
      occurredAtMs: 1_750_000_000_002,
      expectedTaskVersion: 1,
      previousPlanRevisionId: null,
      plan: {
        revisionId: "00000000-0000-4000-8000-000000000004",
        status: "confirmed",
        basedOnRequirementRevisionId: "00000000-0000-4000-8000-000000000003",
        steps: [
          {
            stepId: "00000000-0000-4000-8000-000000000005",
            title: "Persist the task graph",
            description: "Commit a validated graph before reopening the compiled store.",
            acceptanceCriteria: ["The graph remains active after reopen."],
          },
        ],
      },
    });
    const committed = store.commitTaskGraph({
      eventId: "00000000-0000-4000-8000-000000000007",
      taskId: "00000000-0000-4000-8000-000000000002",
      occurredAtMs: 1_750_000_000_003,
      expectedTaskVersion: 2,
      previousGraphRevisionId: null,
      graph: {
        revisionId: "00000000-0000-4000-8000-000000000007",
        basedOnPlanRevisionId: "00000000-0000-4000-8000-000000000004",
        nodes: [
          {
            nodeId: "00000000-0000-4000-8000-000000000006",
            sourcePlanStepId: "00000000-0000-4000-8000-000000000005",
            title: "Persist the task graph",
            description: "Verify compiled DAG persistence.",
            acceptanceCriteria: ["The node remains pending after reopen."],
            dependsOnNodeIds: [],
          },
        ],
      },
    });
    store.reconcileRequirements({
      taskId: "00000000-0000-4000-8000-000000000002",
      occurredAtMs: 1_750_000_000_004,
      expectedTaskVersion: committed.task.taskVersion,
      previousRequirementRevisionId: "00000000-0000-4000-8000-000000000003",
      previousPlanRevisionId: "00000000-0000-4000-8000-000000000004",
      previousGraphRevisionId: "00000000-0000-4000-8000-000000000007",
      requirement: {
        revisionId: "00000000-0000-4000-8000-000000000008",
        sourceText: "Persist this clarified task plan.",
        objective: "Recover the task after reopening the compiled store.",
        constraints: ["Keep the store internal."],
        acceptanceCriteria: ["The task is readable after reopen."],
      },
      plan: {
        revisionId: "00000000-0000-4000-8000-000000000009",
        status: "confirmed",
        basedOnRequirementRevisionId: "00000000-0000-4000-8000-000000000008",
        steps: [
          {
            stepId: "00000000-0000-4000-8000-000000000005",
            title: "Persist the task graph",
            description: "Commit a validated graph before reopening the compiled store.",
            acceptanceCriteria: ["The graph remains active after reopen."],
          },
        ],
      },
      graph: {
        revisionId: "00000000-0000-4000-8000-000000000010",
        basedOnPlanRevisionId: "00000000-0000-4000-8000-000000000009",
        nodes: [
          {
            nodeId: "00000000-0000-4000-8000-000000000006",
            sourcePlanStepId: "00000000-0000-4000-8000-000000000005",
            title: "Persist the task graph",
            description: "Verify compiled DAG persistence.",
            acceptanceCriteria: ["The node remains pending after reopen."],
            dependsOnNodeIds: [],
          },
        ],
      },
      metadata: { actor: "system.smoke" },
    });
    store.close();
    store = await TaskPlanStore.open({ path, now: () => 1_750_000_000_005 });
    const task = store.readTask("00000000-0000-4000-8000-000000000002");
    if (
      task.taskVersion !== 4 ||
      task.activeRequirement.revisionNumber !== 2 ||
      task.activeGraph?.revisionNumber !== 2 ||
      task.activeGraph.nodes[0]?.status !== "pending" ||
      task.activeReconciliation?.impact !== "editorial"
    ) {
      throw new Error("The compiled task plan store smoke result was invalid.");
    }
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
