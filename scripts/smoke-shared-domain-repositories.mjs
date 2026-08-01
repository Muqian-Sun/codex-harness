import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function smokeSharedDomainRepositories() {
  const directory = await mkdtemp(join(tmpdir(), "ch-shared-repositories-smoke-"));
  await chmod(directory, 0o700);
  const path = join(directory, "harness.db");
  let events;
  try {
    const { HarnessEventStore } = await import("../apps/harnessd/dist/persistence/event-store.js");
    const { TASK_PLAN_PROJECTION, TaskPlanRepository } =
      await import("../apps/harnessd/dist/domain/task-plan-store.js");
    const { MODEL_ROUTING_PROFILE_PROJECTION, ModelRoutingProfileRepository } =
      await import("../apps/harnessd/dist/domain/model-routing-profile-repository.js");
    const { PROJECT_ROUTING_PROFILE_BINDING_PROJECTION, ProjectRoutingProfileBindingRepository } =
      await import("../apps/harnessd/dist/domain/project-routing-profile-binding-repository.js");
    const { SHADOW_ROUTE_DECISION_PROJECTION, ShadowRouteDecisionRepository } =
      await import("../apps/harnessd/dist/domain/shadow-route-decision-repository.js");
    const projections = [
      TASK_PLAN_PROJECTION,
      MODEL_ROUTING_PROFILE_PROJECTION,
      PROJECT_ROUTING_PROFILE_BINDING_PROJECTION,
      SHADOW_ROUTE_DECISION_PROJECTION,
    ];
    events = await HarnessEventStore.open({ path, projections });
    let tasks = new TaskPlanRepository(events);
    let profiles = new ModelRoutingProfileRepository(events);
    let bindings = new ProjectRoutingProfileBindingRepository(events);
    let decisions = new ShadowRouteDecisionRepository(events);
    tasks.createTask(taskCommand());
    profiles.setConfiguration(profileCommand());
    bindings.bindProfile(bindingCommand());
    decisions.record(decisionCommand());
    events.close();

    events = await HarnessEventStore.open({ path, projections });
    tasks = new TaskPlanRepository(events);
    profiles = new ModelRoutingProfileRepository(events);
    bindings = new ProjectRoutingProfileBindingRepository(events);
    decisions = new ShadowRouteDecisionRepository(events);
    if (
      tasks.readTask(TASK_ID).taskVersion !== 1 ||
      profiles.readProfile(PROFILE_ID).profileVersion !== 1 ||
      bindings.readBinding(PROJECT_ID).profileId !== PROFILE_ID ||
      decisions.readDecision(TASK_ID, DECISION_ID).decision.selectedTier !== "standard" ||
      events.inspect().eventCount !== 4 ||
      events.inspect().projectionCount !== 4
    ) {
      throw new Error("The compiled shared domain repository smoke result was invalid.");
    }
  } finally {
    events?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const TASK_ID = "00000000-0000-4000-8000-000000000701";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000702";
const PROJECT_ID = "00000000-0000-4000-8000-000000000703";
const PROFILE_ID = "00000000-0000-4000-8000-000000000711";
const CONFIGURATION_ID = "00000000-0000-4000-8000-000000000712";
const BINDING_EVENT_ID = "00000000-0000-4000-8000-000000000713";
const DECISION_ID = "00000000-0000-4000-8000-000000000714";

function taskCommand() {
  return {
    eventId: REQUIREMENT_ID,
    taskId: TASK_ID,
    title: "Shared domain repository smoke",
    occurredAtMs: 100,
    requirement: {
      revisionId: REQUIREMENT_ID,
      sourceText: "Use one daemon-owned EventStore.",
      objective: "Recover Task and routing facts together.",
      constraints: ["Do not create a second SQLite writer."],
      acceptanceCriteria: ["All registered projections recover."],
    },
  };
}

function profileCommand() {
  return {
    profileId: PROFILE_ID,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs: 101,
    configuration: routingConfiguration(),
  };
}

function bindingCommand() {
  return {
    eventId: BINDING_EVENT_ID,
    projectId: PROJECT_ID,
    expectedBindingVersion: 0,
    previousProfileId: null,
    profileId: PROFILE_ID,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_ID,
    occurredAtMs: 102,
  };
}

function decisionCommand() {
  return {
    decisionId: DECISION_ID,
    taskId: TASK_ID,
    taskVersion: 1,
    nodeId: null,
    profileId: PROFILE_ID,
    expectedConfigurationRevisionId: CONFIGURATION_ID,
    occurredAtMs: 103,
    features: {
      schemaVersion: 1,
      taskKind: "code_change",
      complexity: "low",
      scope: "isolated",
      ambiguity: "low",
      estimatedSteps: 1,
      toolBreadth: "single",
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

function routingConfiguration() {
  return {
    schemaVersion: 1,
    revisionId: CONFIGURATION_ID,
    revisionNumber: 1,
    tiers: {
      fast: { provider: "provider", model: "cheap", reasoningEffort: "low" },
      standard: { provider: "provider", model: "code", reasoningEffort: "medium" },
      deep: { provider: "provider", model: "advanced", reasoningEffort: "high" },
    },
  };
}
