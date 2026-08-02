import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import type { ModelRoutingConfiguration } from "../domain/model-routing-config.js";
import { ProjectRegistryRepository } from "../domain/project-registry-repository.js";
import { ProjectRoutingProfileBindingRepository } from "../domain/project-routing-profile-binding-repository.js";
import { DaemonStateStore } from "./daemon-state-store.js";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "./desktop-default-routing-profile.js";
import {
  ProjectRoutingBindingService,
  ProjectRoutingBindingServiceError,
} from "./project-routing-binding-service.js";

const PROJECT_1 = "00000000-0000-4000-8000-000000000941";
const PROJECT_2 = "00000000-0000-4000-8000-000000000942";
const PROJECT_EVENT_1 = "00000000-0000-4000-8000-000000000943";
const PROJECT_EVENT_2 = "00000000-0000-4000-8000-000000000944";
const OTHER_PROFILE_ID = "00000000-0000-4000-8000-000000000945";
const DEFAULT_REVISION_1 = "00000000-0000-4000-8000-000000000951";
const DEFAULT_REVISION_2 = "00000000-0000-4000-8000-000000000952";
const OTHER_REVISION = "00000000-0000-4000-8000-000000000953";
const BIND_COMMAND_1 = "00000000-0000-4000-8000-000000000961";
const BIND_COMMAND_2 = "00000000-0000-4000-8000-000000000962";
const OTHER_BIND_COMMAND = "00000000-0000-4000-8000-000000000963";
const temporaryDirectories: string[] = [];
const stores: DaemonStateStore[] = [];

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-project-binding-service-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openStore(path?: string): Promise<DaemonStateStore> {
  const store = await DaemonStateStore.open({ databasePath: path ?? (await createDatabasePath()) });
  stores.push(store);
  return store;
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
      fast: { provider: "openai", model: `fast-${suffix}`, reasoningEffort: "low" },
      standard: { provider: "openai", model: `standard-${suffix}`, reasoningEffort: "medium" },
      deep: { provider: "openai", model: `deep-${suffix}`, reasoningEffort: "high" },
    },
  };
}

function registerProject(store: DaemonStateStore, projectId = PROJECT_1): void {
  new ProjectRegistryRepository(store.events).registerProject({
    eventId: projectId === PROJECT_1 ? PROJECT_EVENT_1 : PROJECT_EVENT_2,
    projectId,
    displayName: projectId === PROJECT_1 ? "alpha" : "beta",
    workspace: {
      platform: "macos",
      absolutePath: projectId === PROJECT_1 ? "/Users/example/alpha" : "/Users/example/beta",
    },
    occurredAtMs: 1_750_000_000_001,
  });
}

function createProfile(
  store: DaemonStateStore,
  profileId = DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
  revisionId = DEFAULT_REVISION_1,
): void {
  new ModelRoutingProfileRepository(store.events).setConfiguration({
    profileId,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs: 1_750_000_000_002,
    configuration: configuration(revisionId),
  });
}

function bindParams(
  commandId = BIND_COMMAND_1,
  overrides: Partial<{
    expectedBindingVersion: number;
    previousProfileId: string | null;
    expectedProfileVersion: number;
    expectedConfigurationRevisionId: string;
  }> = {},
) {
  return {
    commandId,
    projectId: PROJECT_1,
    expectedBindingVersion: 0,
    previousProfileId: null,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: DEFAULT_REVISION_1,
    ...overrides,
  };
}

function seedOtherBinding(store: DaemonStateStore): void {
  createProfile(store, OTHER_PROFILE_ID, OTHER_REVISION);
  new ProjectRoutingProfileBindingRepository(store.events).bindProfile({
    eventId: OTHER_BIND_COMMAND,
    projectId: PROJECT_1,
    expectedBindingVersion: 0,
    previousProfileId: null,
    profileId: OTHER_PROFILE_ID,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: OTHER_REVISION,
    occurredAtMs: 1_750_000_000_003,
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("ProjectRoutingBindingService", () => {
  it("returns ordered frozen status projections without persistence timestamps", async () => {
    const store = await openStore();
    registerProject(store, PROJECT_1);
    registerProject(store, PROJECT_2);
    seedOtherBinding(store);
    const service = new ProjectRoutingBindingService(store);

    const result = service.readStatuses({ projectIds: [PROJECT_2, PROJECT_1] });

    expect(result).toEqual({
      schemaVersion: 1,
      statuses: [
        { projectId: PROJECT_2, status: "unbound", binding: null },
        {
          projectId: PROJECT_1,
          status: "other_profile_bound",
          binding: {
            projectId: PROJECT_1,
            bindingVersion: 1,
            profileId: OTHER_PROFILE_ID,
            profileVersionAtBinding: 1,
            configurationRevisionIdAtBinding: OTHER_REVISION,
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("AtMs");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.statuses)).toBe(true);
    expect(Object.isFrozen(result.statuses[1]?.binding)).toBe(true);
  });

  it("binds the configured default with exact retry and same-target idempotency", async () => {
    const store = await openStore();
    registerProject(store);
    createProfile(store);
    const now = vi.fn(() => 1_750_000_000_003);
    const service = new ProjectRoutingBindingService(store, { now });
    const params = bindParams();

    const first = service.bindDefault(params);
    expect(first).toMatchObject({
      schemaVersion: 1,
      status: "bound",
      binding: {
        projectId: PROJECT_1,
        bindingVersion: 1,
        profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
        profileVersionAtBinding: 1,
        configurationRevisionIdAtBinding: DEFAULT_REVISION_1,
      },
    });
    expect(service.bindDefault(params)).toEqual(first);
    expect(
      service.bindDefault(
        bindParams(BIND_COMMAND_2, {
          expectedBindingVersion: 1,
          previousProfileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
        }),
      ),
    ).toEqual({ ...first, status: "existing" });
    expect(service.readStatuses({ projectIds: [PROJECT_1] }).statuses[0]?.status).toBe(
      "default_bound",
    );
    expect(now).toHaveBeenCalledTimes(1);
    expect(store.inspect()).toMatchObject({ eventCount: 3 });
  });

  it("rebinds another profile to the default and restores the status from SQLite", async () => {
    const path = await createDatabasePath();
    const store = await openStore(path);
    registerProject(store);
    createProfile(store);
    seedOtherBinding(store);
    const service = new ProjectRoutingBindingService(store, {
      now: () => 1_750_000_000_004,
    });

    expect(
      service.bindDefault(
        bindParams(BIND_COMMAND_1, {
          expectedBindingVersion: 1,
          previousProfileId: OTHER_PROFILE_ID,
        }),
      ),
    ).toMatchObject({ status: "bound", binding: { bindingVersion: 2 } });

    store.close();
    const reopened = await openStore(path);
    expect(
      new ProjectRoutingBindingService(reopened).readStatuses({ projectIds: [PROJECT_1] }),
    ).toMatchObject({ statuses: [{ status: "default_bound", binding: { bindingVersion: 2 } }] });
  });

  it("keeps a historical exact retry valid after later profile and binding changes", async () => {
    const store = await openStore();
    registerProject(store);
    createProfile(store);
    const service = new ProjectRoutingBindingService(store, {
      now: () => 1_750_000_000_003,
    });
    const original = service.bindDefault(bindParams());

    createProfile(store, OTHER_PROFILE_ID, OTHER_REVISION);
    new ProjectRoutingProfileBindingRepository(store.events).bindProfile({
      eventId: OTHER_BIND_COMMAND,
      projectId: PROJECT_1,
      expectedBindingVersion: 1,
      previousProfileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
      profileId: OTHER_PROFILE_ID,
      expectedProfileVersion: 1,
      expectedConfigurationRevisionId: OTHER_REVISION,
      occurredAtMs: 1_750_000_000_004,
    });
    new ModelRoutingProfileRepository(store.events).setConfiguration({
      profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
      expectedProfileVersion: 1,
      previousConfigurationRevisionId: DEFAULT_REVISION_1,
      occurredAtMs: 1_750_000_000_005,
      configuration: configuration(DEFAULT_REVISION_2, 2, "2"),
    });

    expect(service.bindDefault(bindParams())).toEqual(original);
    expect(service.readStatuses({ projectIds: [PROJECT_1] }).statuses[0]?.status).toBe(
      "other_profile_bound",
    );
  });

  it("rejects missing Projects, missing configurations, and stale fences without binding", async () => {
    const store = await openStore();
    const service = new ProjectRoutingBindingService(store);
    expect(() => service.bindDefault(bindParams())).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );

    registerProject(store);
    expect(() => service.bindDefault(bindParams())).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    createProfile(store);
    expect(() =>
      service.bindDefault(
        bindParams(BIND_COMMAND_2, {
          expectedProfileVersion: 2,
          expectedConfigurationRevisionId: DEFAULT_REVISION_2,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() => service.readStatuses({ projectIds: [PROJECT_2] })).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(store.inspect()).toMatchObject({ eventCount: 2 });
  });

  it("fails closed after the state owner closes", async () => {
    const store = await openStore();
    const service = new ProjectRoutingBindingService(store);
    store.close();

    expect(() => service.readStatuses({ projectIds: [] })).toThrowError(
      ProjectRoutingBindingServiceError,
    );
    expect(() => service.bindDefault(bindParams())).toThrowError(
      expect.objectContaining({ code: "unavailable" }),
    );
  });
});
