import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore } from "../persistence/event-store.js";
import {
  MODEL_ROUTING_PROFILE_PROJECTION,
  ModelRoutingProfileRepository,
} from "./model-routing-profile-repository.js";
import {
  PROJECT_ROUTING_PROFILE_BINDING_PROJECTION,
  ProjectRoutingProfileBindingRepository,
} from "./project-routing-profile-binding-repository.js";
import { TASK_PLAN_PROJECTION, TaskPlanRepository } from "./task-plan-store.js";

const TASK_ID = "00000000-0000-4000-8000-000000000701";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000702";
const PROJECT_ID = "00000000-0000-4000-8000-000000000703";
const PROFILE_ID = "00000000-0000-4000-8000-000000000711";
const CONFIGURATION_ID = "00000000-0000-4000-8000-000000000712";
const BINDING_EVENT_ID = "00000000-0000-4000-8000-000000000713";
const temporaryDirectories: string[] = [];
const stores: HarnessEventStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-shared-task-repository-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

const projections = [
  TASK_PLAN_PROJECTION,
  MODEL_ROUTING_PROFILE_PROJECTION,
  PROJECT_ROUTING_PROFILE_BINDING_PROJECTION,
];

async function openShared(path: string) {
  const events = await HarnessEventStore.open({ path, projections });
  stores.push(events);
  return {
    events,
    tasks: new TaskPlanRepository(events),
    profiles: new ModelRoutingProfileRepository(events),
    bindings: new ProjectRoutingProfileBindingRepository(events),
  };
}

function createTask(repository: TaskPlanRepository): void {
  repository.createTask({
    eventId: REQUIREMENT_ID,
    taskId: TASK_ID,
    title: "Shared EventStore task",
    occurredAtMs: 100,
    requirement: {
      revisionId: REQUIREMENT_ID,
      sourceText: "Keep the task and routing facts in one daemon-owned store.",
      objective: "Prove shared repository composition.",
      constraints: ["Do not create another SQLite writer."],
      acceptanceCriteria: ["All projections recover from the same event log."],
    },
  });
}

function createProfile(repository: ModelRoutingProfileRepository): void {
  repository.setConfiguration({
    profileId: PROFILE_ID,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs: 101,
    configuration: {
      schemaVersion: 1,
      revisionId: CONFIGURATION_ID,
      revisionNumber: 1,
      tiers: {
        fast: { provider: "provider", model: "cheap", reasoningEffort: "low" },
        standard: { provider: "provider", model: "code", reasoningEffort: "medium" },
        deep: { provider: "provider", model: "advanced", reasoningEffort: "high" },
      },
    },
  });
}

function bindProject(repository: ProjectRoutingProfileBindingRepository): void {
  repository.bindProfile({
    eventId: BINDING_EVENT_ID,
    projectId: PROJECT_ID,
    expectedBindingVersion: 0,
    previousProfileId: null,
    profileId: PROFILE_ID,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_ID,
    occurredAtMs: 102,
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("injected task plan repository", () => {
  it("shares one EventStore with routing repositories and recovers every projection", async () => {
    const path = await databasePath();
    const first = await openShared(path);
    createTask(first.tasks);
    createProfile(first.profiles);
    bindProject(first.bindings);
    expect(first.events.inspect()).toMatchObject({ eventCount: 3, projectionCount: 3 });
    expect("close" in first.tasks).toBe(false);
    first.events.close();

    const reopened = await openShared(path);
    expect(reopened.tasks.readTask(TASK_ID).activeRequirement.revisionId).toBe(REQUIREMENT_ID);
    expect(reopened.profiles.readProfile(PROFILE_ID).activeConfiguration.revisionId).toBe(
      CONFIGURATION_ID,
    );
    expect(reopened.bindings.readBinding(PROJECT_ID).profileId).toBe(PROFILE_ID);
    expect(reopened.events.inspect()).toMatchObject({ eventCount: 3, lastSequence: 3 });
  });

  it("requires the task projection before any injected repository write", async () => {
    const events = await HarnessEventStore.open({
      path: await databasePath(),
      projections: [MODEL_ROUTING_PROFILE_PROJECTION],
    });
    stores.push(events);
    expect(() => new TaskPlanRepository(events)).toThrowError(
      expect.objectContaining({ code: "storage_failure" }),
    );
    expect(events.inspect()).toMatchObject({ eventCount: 0 });
  });

  it("leaves lifecycle ownership with the injected EventStore", async () => {
    const shared = await openShared(await databasePath());
    createTask(shared.tasks);
    shared.events.close();
    expect(() => shared.tasks.readTask(TASK_ID)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
    expect(() => createTask(shared.tasks)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });
});
