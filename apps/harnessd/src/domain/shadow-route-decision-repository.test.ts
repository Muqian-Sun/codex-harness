import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore } from "../persistence/event-store.js";
import type { ModelRouteFeatures } from "./model-route-classifier.js";
import {
  MODEL_ROUTING_PROFILE_PROJECTION,
  ModelRoutingProfileRepository,
} from "./model-routing-profile-repository.js";
import type { ModelRoutingConfiguration } from "./model-routing-config.js";
import {
  SHADOW_ROUTE_DECISION_PROJECTION,
  ShadowRouteDecisionError,
  ShadowRouteDecisionRepository,
  type RecordShadowRouteDecisionInput,
} from "./shadow-route-decision-repository.js";

const PROFILE_ID = "00000000-0000-4000-8000-000000000401";
const CONFIGURATION_1 = "00000000-0000-4000-8000-000000000411";
const CONFIGURATION_2 = "00000000-0000-4000-8000-000000000412";
const TASK_1 = "00000000-0000-4000-8000-000000000421";
const TASK_2 = "00000000-0000-4000-8000-000000000422";
const NODE_ID = "00000000-0000-4000-8000-000000000423";
const DECISION_1 = "00000000-0000-4000-8000-000000000431";
const DECISION_2 = "00000000-0000-4000-8000-000000000432";
const DECISION_3 = "00000000-0000-4000-8000-000000000433";
const temporaryDirectories: string[] = [];
const stores: HarnessEventStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-route-decisions-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openRepositories(path: string) {
  const events = await HarnessEventStore.open({
    path,
    now: () => 1_750_000_000_000,
    projections: [MODEL_ROUTING_PROFILE_PROJECTION, SHADOW_ROUTE_DECISION_PROJECTION],
  });
  stores.push(events);
  return {
    events,
    profiles: new ModelRoutingProfileRepository(events),
    decisions: new ShadowRouteDecisionRepository(events),
  };
}

function configuration(
  revisionId = CONFIGURATION_1,
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

function features(taskKind: ModelRouteFeatures["taskKind"] = "simple"): ModelRouteFeatures {
  return {
    schemaVersion: 1,
    taskKind,
    complexity: "low",
    scope: "isolated",
    ambiguity: "low",
    estimatedSteps: 1,
    toolBreadth: "none",
    safety: {
      securitySensitive: false,
      dataMigration: false,
      concurrencySensitive: false,
      publicApiChange: false,
      productionImpact: false,
      irreversibleOperation: false,
      permissionBoundaryChange: false,
    },
  };
}

function command(decisionId = DECISION_1, taskId = TASK_1): RecordShadowRouteDecisionInput {
  return {
    decisionId,
    taskId,
    taskVersion: 3,
    nodeId: NODE_ID,
    profileId: PROFILE_ID,
    expectedConfigurationRevisionId: CONFIGURATION_1,
    occurredAtMs: 1_750_000_000_010,
    features: features(),
    metadata: { actor: "system.router" },
  };
}

function createProfile(repository: ModelRoutingProfileRepository): void {
  repository.setConfiguration({
    profileId: PROFILE_ID,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs: 1_750_000_000_001,
    configuration: configuration(),
  });
}

function updateProfile(repository: ModelRoutingProfileRepository): void {
  repository.setConfiguration({
    profileId: PROFILE_ID,
    expectedProfileVersion: 1,
    previousConfigurationRevisionId: CONFIGURATION_1,
    occurredAtMs: 1_750_000_000_002,
    configuration: configuration(CONFIGURATION_2, 2, "2"),
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("shadow route decision repository", () => {
  it("derives and persists a frozen decision from the current user profile", async () => {
    const { events, profiles, decisions } = await openRepositories(await databasePath());
    createProfile(profiles);
    const input = command();
    const result = decisions.record(input);
    (input.features.safety as { securitySensitive: boolean }).securitySensitive = true;

    expect(result).toMatchObject({
      duplicate: false,
      event: {
        eventId: DECISION_1,
        streamType: "routing.task_decisions",
        streamId: TASK_1,
        eventType: "routing.shadow_decision_recorded",
      },
      record: {
        decisionId: DECISION_1,
        taskId: TASK_1,
        taskVersion: 3,
        nodeId: NODE_ID,
        profileId: PROFILE_ID,
        decision: {
          mode: "shadow",
          executionAuthorized: false,
          selectedTier: "fast",
          resolvedTarget: {
            configurationRevisionId: CONFIGURATION_1,
            model: "cheap-1",
          },
        },
      },
    });
    expect(result.record.decision.features.safety.securitySensitive).toBe(false);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.decision)).toBe(true);
    expect(events.inspect()).toMatchObject({ eventCount: 2, projectionCount: 2 });
  });

  it("persists the deep safety floor rather than trusting a cheap candidate", async () => {
    const { profiles, decisions } = await openRepositories(await databasePath());
    createProfile(profiles);
    const input = command();
    (input.features.safety as { permissionBoundaryChange: boolean }).permissionBoundaryChange =
      true;
    const result = decisions.record(input);

    expect(result.record.decision).toMatchObject({
      candidateTier: "fast",
      safetyFloorTier: "deep",
      selectedTier: "deep",
      safetyReasons: ["risk_permission_boundary_change"],
      resolvedTarget: { model: "advanced-1" },
    });
  });

  it("keeps an exact historical retry idempotent after the active profile changes", async () => {
    const { events, profiles, decisions } = await openRepositories(await databasePath());
    createProfile(profiles);
    const input = command();
    const first = decisions.record(input);
    updateProfile(profiles);
    const duplicate = decisions.record(input);

    expect(duplicate).toEqual({ duplicate: true, event: first.event, record: first.record });
    expect(duplicate.record.decision.resolvedTarget).toMatchObject({
      configurationRevisionId: CONFIGURATION_1,
      model: "cheap-1",
    });
    expect(events.inspect()).toMatchObject({ eventCount: 3, lastSequence: 3 });
  });

  it("rejects conflicting historical retries including metadata changes", async () => {
    const { events, profiles, decisions } = await openRepositories(await databasePath());
    createProfile(profiles);
    const input = command();
    decisions.record(input);
    const conflicts = [
      { ...input, taskVersion: 4 },
      { ...input, nodeId: null },
      { ...input, occurredAtMs: input.occurredAtMs + 1 },
      { ...input, expectedConfigurationRevisionId: CONFIGURATION_2 },
      { ...input, features: features("analysis") },
      { ...input, metadata: { actor: "system.other" } },
    ];
    for (const conflict of conflicts) {
      expect(() => decisions.record(conflict)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
    expect(events.inspect()).toMatchObject({ eventCount: 2, lastSequence: 2 });
  });

  it("rejects a stale configuration fence for a new decision and accepts the fresh revision", async () => {
    const { events, profiles, decisions } = await openRepositories(await databasePath());
    createProfile(profiles);
    updateProfile(profiles);
    expect(() => decisions.record(command(DECISION_2))).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() =>
      decisions.record({
        ...command(DECISION_2),
        expectedConfigurationRevisionId: CONFIGURATION_2,
        occurredAtMs: 1_750_000_000_001,
      }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));

    const fresh = {
      ...command(DECISION_2),
      expectedConfigurationRevisionId: CONFIGURATION_2,
      features: features("code_change"),
    };
    expect(decisions.record(fresh).record.decision).toMatchObject({
      selectedTier: "standard",
      resolvedTarget: { configurationRevisionId: CONFIGURATION_2, model: "code-2" },
    });
    expect(events.inspect()).toMatchObject({ eventCount: 3, lastSequence: 3 });
  });

  it("restores immutable decisions and lists only the requested task in identifier order", async () => {
    const path = await databasePath();
    const first = await openRepositories(path);
    createProfile(first.profiles);
    first.decisions.record(command(DECISION_2, TASK_1));
    first.decisions.record(command(DECISION_1, TASK_1));
    first.decisions.record(command(DECISION_3, TASK_2));
    first.events.close();

    const reopened = await openRepositories(path);
    expect(reopened.decisions.readDecision(TASK_1, DECISION_1).decision.selectedTier).toBe("fast");
    expect(reopened.decisions.listTaskDecisions(TASK_1).map((record) => record.decisionId)).toEqual(
      [DECISION_1, DECISION_2],
    );
    expect(
      reopened.decisions
        .listTaskDecisions(TASK_1, DECISION_1, 1)
        .map((record) => record.decisionId),
    ).toEqual([DECISION_2]);
    expect(reopened.events.inspect()).toMatchObject({ eventCount: 4, lastSequence: 4 });
  });

  it("rejects malformed commands, missing profiles, and non-route event identifier collisions", async () => {
    const { events, profiles, decisions } = await openRepositories(await databasePath());
    const invalid = [
      { ...command(), unexpected: true },
      { ...command(), decisionId: "bad" },
      { ...command(), taskVersion: 0 },
      { ...command(), nodeId: "bad" },
      { ...command(), occurredAtMs: -1 },
      { ...command(), features: { ...features(), taskKind: "unknown" } },
      { ...command(), metadata: { actor: "not namespaced" } },
    ];
    for (const input of invalid) {
      expect(() => decisions.record(input as never)).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    expect(() => decisions.record(command())).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );

    createProfile(profiles);
    expect(() => decisions.record({ ...command(), decisionId: CONFIGURATION_1 })).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(events.inspect()).toMatchObject({ eventCount: 1 });
  });

  it("requires both projections before writing and leaves event store ownership external", async () => {
    const path = await databasePath();
    for (const projections of [
      [MODEL_ROUTING_PROFILE_PROJECTION],
      [SHADOW_ROUTE_DECISION_PROJECTION],
    ]) {
      const events = await HarnessEventStore.open({ path, projections });
      stores.push(events);
      expect(() => new ShadowRouteDecisionRepository(events)).toThrowError(
        expect.objectContaining({ code: "storage_failure" }),
      );
      expect(events.inspect()).toMatchObject({ eventCount: 0 });
      events.close();
    }

    const complete = await openRepositories(path);
    createProfile(complete.profiles);
    complete.decisions.record(command());
    complete.events.close();
    expect(() => complete.decisions.readDecision(TASK_1, DECISION_1)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });

  it("returns not_found and validates task-scoped query cursors", async () => {
    const { decisions } = await openRepositories(await databasePath());
    expect(() => decisions.readDecision(TASK_1, DECISION_1)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => decisions.listTaskDecisions("bad")).toThrowError(ShadowRouteDecisionError);
    expect(() => decisions.listTaskDecisions(TASK_1, "bad")).toThrowError(ShadowRouteDecisionError);
    expect(() => decisions.listTaskDecisions(TASK_1, "", 0)).toThrowError(ShadowRouteDecisionError);
  });
});
