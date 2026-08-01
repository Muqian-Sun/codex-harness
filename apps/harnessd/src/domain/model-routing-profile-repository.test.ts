import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore } from "../persistence/event-store.js";
import {
  MODEL_ROUTING_PROFILE_PROJECTION,
  ModelRoutingProfileError,
  ModelRoutingProfileRepository,
  type SetModelRoutingConfigurationInput,
} from "./model-routing-profile-repository.js";
import type { ModelRoutingConfiguration } from "./model-routing-config.js";

const PROFILE_1 = "00000000-0000-4000-8000-000000000301";
const PROFILE_2 = "00000000-0000-4000-8000-000000000302";
const REVISION_1 = "00000000-0000-4000-8000-000000000311";
const REVISION_2 = "00000000-0000-4000-8000-000000000312";
const REVISION_3 = "00000000-0000-4000-8000-000000000313";
const temporaryDirectories: string[] = [];
const stores: HarnessEventStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-routing-profile-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openRepository(path: string): Promise<{
  events: HarnessEventStore;
  repository: ModelRoutingProfileRepository;
}> {
  const events = await HarnessEventStore.open({
    path,
    now: () => 1_750_000_000_000,
    projections: [MODEL_ROUTING_PROFILE_PROJECTION],
  });
  stores.push(events);
  return { events, repository: new ModelRoutingProfileRepository(events) };
}

function configuration(
  revisionId = REVISION_1,
  revisionNumber = 1,
  suffix = "1",
): ModelRoutingConfiguration {
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

function createCommand(profileId = PROFILE_1): SetModelRoutingConfigurationInput {
  return {
    profileId,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs: 1_750_000_000_001,
    configuration: configuration(),
    metadata: { actor: "user.local" },
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("model routing profile repository", () => {
  it("persists a first configuration as an immutable profile projection", async () => {
    const { events, repository } = await openRepository(await databasePath());
    const command = createCommand();
    const result = repository.setConfiguration(command);
    (command.configuration.tiers.fast as { model: string }).model = "caller-mutated";

    expect(result).toMatchObject({
      duplicate: false,
      event: {
        eventId: REVISION_1,
        streamType: "routing.profile",
        streamId: PROFILE_1,
        eventType: "routing.configuration_set",
      },
      profile: {
        schemaVersion: 1,
        profileId: PROFILE_1,
        profileVersion: 1,
        activeConfiguration: { revisionId: REVISION_1, revisionNumber: 1 },
        createdAtMs: 1_750_000_000_001,
        updatedAtMs: 1_750_000_000_001,
      },
    });
    expect(events.inspect()).toMatchObject({ eventCount: 1, projectionCount: 1 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.profile)).toBe(true);
    expect(Object.isFrozen(result.profile.activeConfiguration)).toBe(true);
    expect(Object.isFrozen(result.profile.activeConfiguration.tiers.deep)).toBe(true);
    expect(result.profile.activeConfiguration.tiers.fast.model).toBe("cheap-1");
    expect(repository.readProfile(PROFILE_1).activeConfiguration.tiers.fast.model).toBe("cheap-1");
  });

  it("updates monotonically and restores the current profile after reopening", async () => {
    const path = await databasePath();
    const first = await openRepository(path);
    first.repository.setConfiguration(createCommand());
    first.repository.setConfiguration({
      profileId: PROFILE_1,
      expectedProfileVersion: 1,
      previousConfigurationRevisionId: REVISION_1,
      occurredAtMs: 1_750_000_000_002,
      configuration: configuration(REVISION_2, 2, "2"),
    });
    first.events.close();

    const reopened = await openRepository(path);
    expect(reopened.repository.readProfile(PROFILE_1)).toMatchObject({
      profileVersion: 2,
      activeConfiguration: {
        revisionId: REVISION_2,
        revisionNumber: 2,
        tiers: { deep: { model: "advanced-2" } },
      },
      createdAtMs: 1_750_000_000_001,
      updatedAtMs: 1_750_000_000_002,
    });
    expect(reopened.events.inspect()).toMatchObject({ eventCount: 2, lastSequence: 2 });
  });

  it("makes complete retries idempotent and rejects changed content under the same revision", async () => {
    const { events, repository } = await openRepository(await databasePath());
    const command = createCommand();
    const first = repository.setConfiguration(command);
    const duplicate = repository.setConfiguration(command);

    expect(duplicate).toEqual({ duplicate: true, event: first.event, profile: first.profile });
    expect(() =>
      repository.setConfiguration({
        ...command,
        configuration: configuration(REVISION_1, 1, "changed"),
      }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(events.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1 });
  });

  it("rejects stale fences, revision gaps, wrong predecessors, and timestamp regression", async () => {
    const { events, repository } = await openRepository(await databasePath());
    repository.setConfiguration(createCommand());
    const staleOrConflicting: SetModelRoutingConfigurationInput[] = [
      {
        profileId: PROFILE_1,
        expectedProfileVersion: 0,
        previousConfigurationRevisionId: null,
        occurredAtMs: 1_750_000_000_002,
        configuration: configuration(REVISION_2, 1, "2"),
      },
      {
        profileId: PROFILE_1,
        expectedProfileVersion: 1,
        previousConfigurationRevisionId: REVISION_3,
        occurredAtMs: 1_750_000_000_002,
        configuration: configuration(REVISION_2, 2, "2"),
      },
      {
        profileId: PROFILE_1,
        expectedProfileVersion: 1,
        previousConfigurationRevisionId: REVISION_1,
        occurredAtMs: 1_750_000_000_000,
        configuration: configuration(REVISION_2, 2, "2"),
      },
    ];
    for (const command of staleOrConflicting) {
      expect(() => repository.setConfiguration(command)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
    expect(() =>
      repository.setConfiguration({
        profileId: PROFILE_1,
        expectedProfileVersion: 1,
        previousConfigurationRevisionId: REVISION_1,
        occurredAtMs: 1_750_000_000_002,
        configuration: configuration(REVISION_3, 3, "3"),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(events.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1 });
  });

  it("lists profiles in stable identifier order with pagination", async () => {
    const { repository } = await openRepository(await databasePath());
    repository.setConfiguration(createCommand(PROFILE_2));
    repository.setConfiguration({
      ...createCommand(PROFILE_1),
      configuration: configuration(REVISION_2, 1, "profile-1"),
    });

    expect(repository.listProfiles().map((profile) => profile.profileId)).toEqual([
      PROFILE_1,
      PROFILE_2,
    ]);
    expect(repository.listProfiles(PROFILE_1, 1).map((profile) => profile.profileId)).toEqual([
      PROFILE_2,
    ]);
  });

  it("rejects malformed commands and keeps public errors free of model contents", async () => {
    const { repository } = await openRepository(await databasePath());
    const secretModel = " secret-model ";
    const invalid = [
      { ...createCommand(), unexpected: true },
      { ...createCommand(), profileId: "bad" },
      { ...createCommand(), expectedProfileVersion: -1 },
      { ...createCommand(), previousConfigurationRevisionId: REVISION_1 },
      { ...createCommand(), occurredAtMs: -1 },
      {
        ...createCommand(),
        configuration: {
          ...configuration(),
          tiers: {
            ...configuration().tiers,
            fast: { ...configuration().tiers.fast, model: secretModel },
          },
        },
      },
      { ...createCommand(), metadata: { actor: "not namespaced" } },
    ];
    for (const command of invalid) {
      let captured: unknown;
      try {
        repository.setConfiguration(command as never);
      } catch (error: unknown) {
        captured = error;
      }
      expect(captured).toMatchObject({ code: "invalid_input" });
      expect(String(captured)).not.toContain(secretModel);
    }
    expect(() => repository.readProfile("bad")).toThrowError(ModelRoutingProfileError);
    expect(() => repository.listProfiles("", 0)).toThrowError(ModelRoutingProfileError);
  });

  it("requires its projection before appending and leaves store ownership with the caller", async () => {
    const path = await databasePath();
    const eventsWithoutProjection = await HarnessEventStore.open({ path });
    stores.push(eventsWithoutProjection);
    expect(() => new ModelRoutingProfileRepository(eventsWithoutProjection)).toThrowError(
      expect.objectContaining({ code: "storage_failure" }),
    );
    expect(eventsWithoutProjection.inspect()).toMatchObject({ eventCount: 0 });

    eventsWithoutProjection.close();
    const { events, repository } = await openRepository(path);
    repository.setConfiguration(createCommand());
    expect(events.inspect()).toMatchObject({ eventCount: 1 });
    events.close();
    expect(() => repository.readProfile(PROFILE_1)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });

  it("returns not_found without creating profile state", async () => {
    const { events, repository } = await openRepository(await databasePath());
    expect(() => repository.readProfile(PROFILE_1)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(events.inspect()).toMatchObject({ eventCount: 0 });
  });
});
