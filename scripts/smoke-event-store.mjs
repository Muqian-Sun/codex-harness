import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function smokeEventStore() {
  const directory = await mkdtemp(join(tmpdir(), "ch-event-smoke-"));
  await chmod(directory, 0o700);
  const path = join(directory, "harness.db");
  let store;
  try {
    const { HarnessEventStore } = await import("../apps/harnessd/dist/persistence/event-store.js");
    const projection = {
      name: "system.smoke_projection",
      version: 1,
      selectKeys: () => ["summary"],
      reduce: ({ current }) => ({
        type: "set",
        state: {
          count:
            typeof current === "object" && current !== null && typeof current.count === "number"
              ? current.count + 1
              : 1,
        },
      }),
    };
    store = await HarnessEventStore.open({
      path,
      now: () => 1_750_000_000_000,
      projections: [projection],
    });
    const batch = Array.from({ length: 3 }, (_, index) => ({
      eventId: randomUUID(),
      streamType: "system",
      streamId: "build-smoke",
      eventType: "system.smoke_recorded",
      eventVersion: 1,
      occurredAtMs: 1_750_000_000_001 + index,
      payload: { index, source: "compiled.build" },
      metadata: { actor: "system.smoke" },
    }));
    const appended = store.appendBatch(batch);
    const duplicate = store.appendBatch(batch);
    const inspection = store.inspect();
    const projected = store.readProjectionState(projection.name, "summary");
    const exact = store.readByEventId(batch[1].eventId);
    if (
      appended.duplicate ||
      !duplicate.duplicate ||
      inspection.schemaVersion !== 2 ||
      inspection.eventCount !== 3 ||
      inspection.lastSequence !== 3 ||
      inspection.projectionCount !== 1 ||
      projected?.state.count !== 3 ||
      exact?.eventId !== batch[1].eventId ||
      exact.payload.index !== 1
    ) {
      throw new Error("The compiled SQLite event store smoke result was invalid.");
    }
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
