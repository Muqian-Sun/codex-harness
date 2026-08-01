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
    store.close();
    store = await TaskPlanStore.open({ path, now: () => 1_750_000_000_002 });
    const task = store.readTask("00000000-0000-4000-8000-000000000002");
    if (task.taskVersion !== 1 || task.activeRequirement.revisionNumber !== 1) {
      throw new Error("The compiled task plan store smoke result was invalid.");
    }
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
