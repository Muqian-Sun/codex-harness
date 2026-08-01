import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function smokeProjectRoutingProfileBinding() {
  const directory = await mkdtemp(join(tmpdir(), "ch-project-routing-binding-smoke-"));
  await chmod(directory, 0o700);
  const path = join(directory, "harness.db");
  let events;
  try {
    const { HarnessEventStore } = await import("../apps/harnessd/dist/persistence/event-store.js");
    const { MODEL_ROUTING_PROFILE_PROJECTION, ModelRoutingProfileRepository } =
      await import("../apps/harnessd/dist/domain/model-routing-profile-repository.js");
    const { PROJECT_ROUTING_PROFILE_BINDING_PROJECTION, ProjectRoutingProfileBindingRepository } =
      await import("../apps/harnessd/dist/domain/project-routing-profile-binding-repository.js");
    const projections = [
      MODEL_ROUTING_PROFILE_PROJECTION,
      PROJECT_ROUTING_PROFILE_BINDING_PROJECTION,
    ];
    events = await HarnessEventStore.open({ path, projections });
    let profiles = new ModelRoutingProfileRepository(events);
    let bindings = new ProjectRoutingProfileBindingRepository(events);
    profiles.setConfiguration(profileCommand(PROFILE_1, CONFIGURATION_1, 100));
    profiles.setConfiguration(profileCommand(PROFILE_2, CONFIGURATION_2, 105));
    const firstCommand = bindingCommand();
    const first = bindings.bindProfile(firstCommand);
    profiles.setConfiguration({
      profileId: PROFILE_1,
      expectedProfileVersion: 1,
      previousConfigurationRevisionId: CONFIGURATION_1,
      occurredAtMs: 120,
      configuration: routingConfiguration(CONFIGURATION_1_UPDATED, 2, "1-updated"),
    });
    bindings.bindProfile({
      eventId: BINDING_EVENT_2,
      projectId: PROJECT_ID,
      expectedBindingVersion: 1,
      previousProfileId: PROFILE_1,
      profileId: PROFILE_2,
      expectedProfileVersion: 1,
      expectedConfigurationRevisionId: CONFIGURATION_2,
      occurredAtMs: 130,
    });
    const duplicate = bindings.bindProfile(firstCommand);
    events.close();

    events = await HarnessEventStore.open({ path, projections });
    profiles = new ModelRoutingProfileRepository(events);
    bindings = new ProjectRoutingProfileBindingRepository(events);
    const current = bindings.readBinding(PROJECT_ID);
    if (
      first.duplicate ||
      !duplicate.duplicate ||
      duplicate.binding.profileId !== PROFILE_1 ||
      current.bindingVersion !== 2 ||
      current.profileId !== PROFILE_2 ||
      profiles.readProfile(PROFILE_1).profileVersion !== 2 ||
      events.inspect().eventCount !== 5
    ) {
      throw new Error("The compiled project routing profile binding smoke result was invalid.");
    }
  } finally {
    events?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const PROJECT_ID = "00000000-0000-4000-8000-000000000601";
const PROFILE_1 = "00000000-0000-4000-8000-000000000611";
const PROFILE_2 = "00000000-0000-4000-8000-000000000612";
const CONFIGURATION_1 = "00000000-0000-4000-8000-000000000621";
const CONFIGURATION_1_UPDATED = "00000000-0000-4000-8000-000000000622";
const CONFIGURATION_2 = "00000000-0000-4000-8000-000000000623";
const BINDING_EVENT_1 = "00000000-0000-4000-8000-000000000631";
const BINDING_EVENT_2 = "00000000-0000-4000-8000-000000000632";

function profileCommand(profileId, revisionId, occurredAtMs) {
  return {
    profileId,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs,
    configuration: routingConfiguration(revisionId, 1, profileId.endsWith("611") ? "1" : "2"),
  };
}

function routingConfiguration(revisionId, revisionNumber, suffix) {
  return {
    schemaVersion: 1,
    revisionId,
    revisionNumber,
    tiers: {
      fast: { provider: "provider", model: `cheap-${suffix}`, reasoningEffort: "low" },
      standard: { provider: "provider", model: `code-${suffix}`, reasoningEffort: "medium" },
      deep: { provider: "provider", model: `advanced-${suffix}`, reasoningEffort: "high" },
    },
  };
}

function bindingCommand() {
  return {
    eventId: BINDING_EVENT_1,
    projectId: PROJECT_ID,
    expectedBindingVersion: 0,
    previousProfileId: null,
    profileId: PROFILE_1,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_1,
    occurredAtMs: 110,
  };
}
