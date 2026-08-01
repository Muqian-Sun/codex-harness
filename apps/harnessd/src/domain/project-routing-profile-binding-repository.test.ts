import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore } from "../persistence/event-store.js";
import {
  MODEL_ROUTING_PROFILE_PROJECTION,
  ModelRoutingProfileRepository,
} from "./model-routing-profile-repository.js";
import type { ModelRoutingConfiguration } from "./model-routing-config.js";
import {
  PROJECT_ROUTING_PROFILE_BINDING_PROJECTION,
  ProjectRoutingProfileBindingError,
  ProjectRoutingProfileBindingRepository,
  type BindProjectRoutingProfileInput,
} from "./project-routing-profile-binding-repository.js";

const PROJECT_1 = "00000000-0000-4000-8000-000000000601";
const PROJECT_2 = "00000000-0000-4000-8000-000000000602";
const PROFILE_1 = "00000000-0000-4000-8000-000000000611";
const PROFILE_2 = "00000000-0000-4000-8000-000000000612";
const CONFIGURATION_1 = "00000000-0000-4000-8000-000000000621";
const CONFIGURATION_1_UPDATED = "00000000-0000-4000-8000-000000000622";
const CONFIGURATION_2 = "00000000-0000-4000-8000-000000000623";
const BINDING_EVENT_1 = "00000000-0000-4000-8000-000000000631";
const BINDING_EVENT_2 = "00000000-0000-4000-8000-000000000632";
const BINDING_EVENT_3 = "00000000-0000-4000-8000-000000000633";
const temporaryDirectories: string[] = [];
const stores: HarnessEventStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-project-routing-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openRepositories(path: string) {
  const events = await HarnessEventStore.open({
    path,
    now: () => 1_750_000_000_000,
    projections: [MODEL_ROUTING_PROFILE_PROJECTION, PROJECT_ROUTING_PROFILE_BINDING_PROJECTION],
  });
  stores.push(events);
  return {
    events,
    profiles: new ModelRoutingProfileRepository(events),
    bindings: new ProjectRoutingProfileBindingRepository(events),
  };
}

function configuration(
  revisionId: string,
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

function createProfile(
  repository: ModelRoutingProfileRepository,
  profileId = PROFILE_1,
  revisionId = CONFIGURATION_1,
  occurredAtMs = 1_750_000_000_100,
): void {
  repository.setConfiguration({
    profileId,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs,
    configuration: configuration(revisionId),
  });
}

function updateProfile(repository: ModelRoutingProfileRepository): void {
  repository.setConfiguration({
    profileId: PROFILE_1,
    expectedProfileVersion: 1,
    previousConfigurationRevisionId: CONFIGURATION_1,
    occurredAtMs: 1_750_000_000_120,
    configuration: configuration(CONFIGURATION_1_UPDATED, 2, "2"),
  });
}

function bindCommand(
  eventId = BINDING_EVENT_1,
  projectId = PROJECT_1,
): BindProjectRoutingProfileInput {
  return {
    eventId,
    projectId,
    expectedBindingVersion: 0,
    previousProfileId: null,
    profileId: PROFILE_1,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_1,
    occurredAtMs: 1_750_000_000_110,
    metadata: { actor: "system.project_policy" },
  };
}

function rebindCommand(): BindProjectRoutingProfileInput {
  return {
    eventId: BINDING_EVENT_2,
    projectId: PROJECT_1,
    expectedBindingVersion: 1,
    previousProfileId: PROFILE_1,
    profileId: PROFILE_2,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_2,
    occurredAtMs: 1_750_000_000_130,
    metadata: { actor: "system.project_policy" },
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("project routing profile binding repository", () => {
  it("creates an authoritative binding from the current profile fence", async () => {
    const { events, profiles, bindings } = await openRepositories(await databasePath());
    createProfile(profiles);
    const result = bindings.bindProfile(bindCommand());

    expect(result).toMatchObject({
      duplicate: false,
      event: {
        eventId: BINDING_EVENT_1,
        streamType: "project.model_routing",
        streamId: PROJECT_1,
        eventType: "project.model_routing_profile_bound",
      },
      binding: {
        schemaVersion: 1,
        projectId: PROJECT_1,
        bindingVersion: 1,
        profileId: PROFILE_1,
        profileVersionAtBinding: 1,
        configurationRevisionIdAtBinding: CONFIGURATION_1,
        createdAtMs: 1_750_000_000_110,
        updatedAtMs: 1_750_000_000_110,
      },
    });
    expect(bindings.readBinding(PROJECT_1)).toEqual(result.binding);
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(events.inspect()).toMatchObject({ eventCount: 2, projectionCount: 2 });
  });

  it("rebinds with a strict binding fence and restores project-sorted state", async () => {
    const path = await databasePath();
    const first = await openRepositories(path);
    createProfile(first.profiles);
    createProfile(first.profiles, PROFILE_2, CONFIGURATION_2, 1_750_000_000_105);
    first.bindings.bindProfile(bindCommand(BINDING_EVENT_3, PROJECT_2));
    first.bindings.bindProfile(bindCommand());
    const rebound = first.bindings.bindProfile(rebindCommand());
    first.events.close();

    const reopened = await openRepositories(path);
    expect(rebound.binding).toMatchObject({
      bindingVersion: 2,
      profileId: PROFILE_2,
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: CONFIGURATION_2,
      createdAtMs: 1_750_000_000_110,
      updatedAtMs: 1_750_000_000_130,
    });
    expect(reopened.bindings.listBindings().map((binding) => binding.projectId)).toEqual([
      PROJECT_1,
      PROJECT_2,
    ]);
    expect(
      reopened.bindings.listBindings(PROJECT_1, 1).map((binding) => binding.projectId),
    ).toEqual([PROJECT_2]);
    expect(reopened.bindings.readBinding(PROJECT_1).profileId).toBe(PROFILE_2);
  });

  it("keeps an original binding retry idempotent after profile updates and project rebinding", async () => {
    const { events, profiles, bindings } = await openRepositories(await databasePath());
    createProfile(profiles);
    createProfile(profiles, PROFILE_2, CONFIGURATION_2, 1_750_000_000_105);
    const input = bindCommand();
    const first = bindings.bindProfile(input);
    updateProfile(profiles);
    bindings.bindProfile(rebindCommand());
    const duplicate = bindings.bindProfile(input);

    expect(duplicate).toEqual({ duplicate: true, event: first.event, binding: first.binding });
    expect(duplicate.binding).toMatchObject({
      bindingVersion: 1,
      profileId: PROFILE_1,
      profileVersionAtBinding: 1,
      configurationRevisionIdAtBinding: CONFIGURATION_1,
    });
    expect(bindings.readBinding(PROJECT_1).profileId).toBe(PROFILE_2);
    expect(events.inspect()).toMatchObject({ eventCount: 5, lastSequence: 5 });
  });

  it("rejects conflicting historical retries including metadata changes", async () => {
    const { events, profiles, bindings } = await openRepositories(await databasePath());
    createProfile(profiles);
    const input = bindCommand();
    bindings.bindProfile(input);
    const conflicts = [
      { ...input, projectId: PROJECT_2 },
      { ...input, expectedBindingVersion: 1, previousProfileId: PROFILE_1 },
      { ...input, profileId: PROFILE_2 },
      { ...input, expectedProfileVersion: 2 },
      { ...input, expectedConfigurationRevisionId: CONFIGURATION_1_UPDATED },
      { ...input, occurredAtMs: input.occurredAtMs + 1 },
      { ...input, metadata: { actor: "system.other" } },
    ];
    for (const conflict of conflicts) {
      expect(() => bindings.bindProfile(conflict)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
    expect(events.inspect()).toMatchObject({ eventCount: 2, lastSequence: 2 });
  });

  it("rejects stale binding fences, no-op rebinding, and time rollback", async () => {
    const { profiles, bindings } = await openRepositories(await databasePath());
    createProfile(profiles);
    createProfile(profiles, PROFILE_2, CONFIGURATION_2, 1_750_000_000_105);
    bindings.bindProfile(bindCommand());
    const invalid = [
      { ...rebindCommand(), expectedBindingVersion: 0, previousProfileId: null },
      { ...rebindCommand(), previousProfileId: PROFILE_2 },
      {
        ...rebindCommand(),
        profileId: PROFILE_1,
        expectedConfigurationRevisionId: CONFIGURATION_1,
      },
      { ...rebindCommand(), occurredAtMs: 1_750_000_000_109 },
    ];
    for (const command of invalid) {
      expect(() => bindings.bindProfile(command)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
  });

  it("rejects missing profiles and stale profile version, revision, or activation time", async () => {
    const { events, profiles, bindings } = await openRepositories(await databasePath());
    expect(() => bindings.bindProfile(bindCommand())).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    createProfile(profiles);
    const invalid = [
      { ...bindCommand(), eventId: BINDING_EVENT_2, expectedProfileVersion: 2 },
      {
        ...bindCommand(),
        eventId: BINDING_EVENT_2,
        expectedConfigurationRevisionId: CONFIGURATION_1_UPDATED,
      },
      { ...bindCommand(), eventId: BINDING_EVENT_2, occurredAtMs: 1_750_000_000_099 },
    ];
    for (const command of invalid) {
      expect(() => bindings.bindProfile(command)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
    expect(() => bindings.bindProfile({ ...bindCommand(), eventId: CONFIGURATION_1 })).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(events.inspect()).toMatchObject({ eventCount: 1 });
  });

  it("validates commands and queries before touching persistent state", async () => {
    const { events, bindings } = await openRepositories(await databasePath());
    const invalid = [
      { ...bindCommand(), unexpected: true },
      { ...bindCommand(), eventId: "bad" },
      { ...bindCommand(), projectId: "bad" },
      { ...bindCommand(), expectedBindingVersion: -1 },
      { ...bindCommand(), expectedBindingVersion: 1, previousProfileId: null },
      { ...bindCommand(), profileId: "bad" },
      { ...bindCommand(), expectedProfileVersion: 0 },
      { ...bindCommand(), expectedConfigurationRevisionId: "bad" },
      { ...bindCommand(), occurredAtMs: -1 },
      { ...bindCommand(), metadata: { actor: "not namespaced" } },
    ];
    for (const input of invalid) {
      expect(() => bindings.bindProfile(input as never)).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    expect(() => bindings.readBinding("bad")).toThrowError(ProjectRoutingProfileBindingError);
    expect(() => bindings.listBindings("bad")).toThrowError(ProjectRoutingProfileBindingError);
    expect(() => bindings.listBindings("", 0)).toThrowError(ProjectRoutingProfileBindingError);
    expect(events.inspect()).toMatchObject({ eventCount: 0 });
  });

  it("requires both projections and leaves EventStore lifecycle ownership external", async () => {
    const path = await databasePath();
    for (const projections of [
      [MODEL_ROUTING_PROFILE_PROJECTION],
      [PROJECT_ROUTING_PROFILE_BINDING_PROJECTION],
    ]) {
      const events = await HarnessEventStore.open({ path, projections });
      stores.push(events);
      expect(() => new ProjectRoutingProfileBindingRepository(events)).toThrowError(
        expect.objectContaining({ code: "storage_failure" }),
      );
      expect(events.inspect()).toMatchObject({ eventCount: 0 });
      events.close();
    }

    const complete = await openRepositories(path);
    expect(() => complete.bindings.readBinding(PROJECT_1)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    complete.events.close();
    expect(() => complete.bindings.readBinding(PROJECT_1)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });
});
