import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function smokeShadowRouteDecisionRepository() {
  const directory = await mkdtemp(join(tmpdir(), "ch-route-decision-smoke-"));
  await chmod(directory, 0o700);
  const path = join(directory, "harness.db");
  let events;
  try {
    const { HarnessEventStore } = await import("../apps/harnessd/dist/persistence/event-store.js");
    const { MODEL_ROUTING_PROFILE_PROJECTION, ModelRoutingProfileRepository } =
      await import("../apps/harnessd/dist/domain/model-routing-profile-repository.js");
    const { SHADOW_ROUTE_DECISION_PROJECTION, ShadowRouteDecisionRepository } =
      await import("../apps/harnessd/dist/domain/shadow-route-decision-repository.js");
    events = await HarnessEventStore.open({
      path,
      projections: [MODEL_ROUTING_PROFILE_PROJECTION, SHADOW_ROUTE_DECISION_PROJECTION],
    });
    let profiles = new ModelRoutingProfileRepository(events);
    let decisions = new ShadowRouteDecisionRepository(events);
    profiles.setConfiguration({
      profileId: "00000000-0000-4000-8000-000000000401",
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      occurredAtMs: 1_750_000_000_001,
      configuration: routingConfiguration("00000000-0000-4000-8000-000000000411", 1, "1"),
    });
    const firstCommand = decisionCommand(
      "00000000-0000-4000-8000-000000000431",
      "00000000-0000-4000-8000-000000000411",
      "simple",
    );
    const first = decisions.record(firstCommand);
    profiles.setConfiguration({
      profileId: "00000000-0000-4000-8000-000000000401",
      expectedProfileVersion: 1,
      previousConfigurationRevisionId: "00000000-0000-4000-8000-000000000411",
      occurredAtMs: 1_750_000_000_002,
      configuration: routingConfiguration("00000000-0000-4000-8000-000000000412", 2, "2"),
    });
    const duplicate = decisions.record(firstCommand);
    decisions.record(
      decisionCommand(
        "00000000-0000-4000-8000-000000000432",
        "00000000-0000-4000-8000-000000000412",
        "code_change",
      ),
    );
    events.close();

    events = await HarnessEventStore.open({
      path,
      projections: [MODEL_ROUTING_PROFILE_PROJECTION, SHADOW_ROUTE_DECISION_PROJECTION],
    });
    profiles = new ModelRoutingProfileRepository(events);
    decisions = new ShadowRouteDecisionRepository(events);
    const records = decisions.listTaskDecisions("00000000-0000-4000-8000-000000000421");
    if (
      first.duplicate ||
      !duplicate.duplicate ||
      records.length !== 2 ||
      records[0]?.decision.resolvedTarget.model !== "cheap-1" ||
      records[1]?.decision.resolvedTarget.model !== "code-2" ||
      profiles.readProfile("00000000-0000-4000-8000-000000000401").profileVersion !== 2 ||
      events.inspect().eventCount !== 4
    ) {
      throw new Error("The compiled shadow route decision repository smoke result was invalid.");
    }
  } finally {
    events?.close();
    await rm(directory, { recursive: true, force: true });
  }
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

function decisionCommand(decisionId, configurationRevisionId, taskKind) {
  return {
    decisionId,
    taskId: "00000000-0000-4000-8000-000000000421",
    taskVersion: 1,
    nodeId: null,
    profileId: "00000000-0000-4000-8000-000000000401",
    expectedConfigurationRevisionId: configurationRevisionId,
    occurredAtMs: decisionId.endsWith("431") ? 1_750_000_000_010 : 1_750_000_000_011,
    features: {
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
    },
  };
}
