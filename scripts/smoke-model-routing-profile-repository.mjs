import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function smokeModelRoutingProfileRepository() {
  const directory = await mkdtemp(join(tmpdir(), "ch-routing-profile-smoke-"));
  await chmod(directory, 0o700);
  const path = join(directory, "harness.db");
  let events;
  try {
    const { HarnessEventStore } = await import("../apps/harnessd/dist/persistence/event-store.js");
    const { MODEL_ROUTING_PROFILE_PROJECTION, ModelRoutingProfileRepository } =
      await import("../apps/harnessd/dist/domain/model-routing-profile-repository.js");
    events = await HarnessEventStore.open({
      path,
      projections: [MODEL_ROUTING_PROFILE_PROJECTION],
    });
    let repository = new ModelRoutingProfileRepository(events);
    repository.setConfiguration({
      profileId: "00000000-0000-4000-8000-000000000301",
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      occurredAtMs: 1_750_000_000_001,
      configuration: {
        schemaVersion: 1,
        revisionId: "00000000-0000-4000-8000-000000000311",
        revisionNumber: 1,
        tiers: {
          fast: { provider: "local", model: "cheap", reasoningEffort: "low" },
          standard: { provider: "local", model: "code", reasoningEffort: "medium" },
          deep: { provider: "remote", model: "advanced", reasoningEffort: "high" },
        },
      },
    });
    repository.setConfiguration({
      profileId: "00000000-0000-4000-8000-000000000301",
      expectedProfileVersion: 1,
      previousConfigurationRevisionId: "00000000-0000-4000-8000-000000000311",
      occurredAtMs: 1_750_000_000_002,
      configuration: {
        schemaVersion: 1,
        revisionId: "00000000-0000-4000-8000-000000000312",
        revisionNumber: 2,
        tiers: {
          fast: { provider: "local", model: "cheap-2", reasoningEffort: "low" },
          standard: { provider: "local", model: "code-2", reasoningEffort: "medium" },
          deep: { provider: "remote", model: "advanced-2", reasoningEffort: "high" },
        },
      },
    });
    events.close();
    events = await HarnessEventStore.open({
      path,
      projections: [MODEL_ROUTING_PROFILE_PROJECTION],
    });
    repository = new ModelRoutingProfileRepository(events);
    const profile = repository.readProfile("00000000-0000-4000-8000-000000000301");
    if (
      profile.profileVersion !== 2 ||
      profile.activeConfiguration.revisionId !== "00000000-0000-4000-8000-000000000312" ||
      profile.activeConfiguration.tiers.deep.model !== "advanced-2" ||
      events.inspect().eventCount !== 2
    ) {
      throw new Error("The compiled model routing profile repository smoke result was invalid.");
    }
  } finally {
    events?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
