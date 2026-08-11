import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ID = "00000000-0000-4000-8000-000000000a01";
const PROJECT_EVENT_ID = "00000000-0000-4000-8000-000000000a02";
const CONFIGURATION_REVISION_ID = "00000000-0000-4000-8000-000000000a03";
const BINDING_EVENT_ID = "00000000-0000-4000-8000-000000000a04";
const TASK_ID = "00000000-0000-4000-8000-000000000a05";
const REQUIREMENT_ID = "00000000-0000-4000-8000-000000000a06";
const OWNERSHIP_EVENT_ID = "00000000-0000-4000-8000-000000000a07";
const CANDIDATE_PLAN_ID = "00000000-0000-4000-8000-000000000a08";
const STEP_ID = "00000000-0000-4000-8000-000000000a09";
const CONFIRMED_PLAN_ID = "00000000-0000-4000-8000-000000000a0a";

async function loadCompiledDependencies() {
  const [
    { DaemonStateStore },
    { ProjectRegistryRepository },
    { ModelRoutingProfileRepository },
    { ProjectRoutingProfileBindingRepository },
    { TaskPlanRepository },
    { ProjectTaskService },
    { DESKTOP_DEFAULT_ROUTING_PROFILE_ID },
  ] = await Promise.all([
    import("../apps/harnessd/dist/runtime/daemon-state-store.js"),
    import("../apps/harnessd/dist/domain/project-registry-repository.js"),
    import("../apps/harnessd/dist/domain/model-routing-profile-repository.js"),
    import("../apps/harnessd/dist/domain/project-routing-profile-binding-repository.js"),
    import("../apps/harnessd/dist/domain/task-plan-store.js"),
    import("../apps/harnessd/dist/runtime/project-task-service.js"),
    import("../apps/harnessd/dist/runtime/desktop-default-routing-profile.js"),
  ]);
  return {
    DaemonStateStore,
    ProjectRegistryRepository,
    ModelRoutingProfileRepository,
    ProjectRoutingProfileBindingRepository,
    TaskPlanRepository,
    ProjectTaskService,
    DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
  };
}

export async function smokeProjectTaskPlanConfirmation(dependencies) {
  const directory = await mkdtemp(join(tmpdir(), "ch-plan-confirm-smoke-"));
  await chmod(directory, 0o700);
  const databasePath = join(directory, "harness.db");
  let store;
  try {
    const {
      DaemonStateStore,
      ProjectRegistryRepository,
      ModelRoutingProfileRepository,
      ProjectRoutingProfileBindingRepository,
      TaskPlanRepository,
      ProjectTaskService,
      DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
    } = dependencies ?? (await loadCompiledDependencies());

    store = await DaemonStateStore.open({ databasePath });
    new ProjectRegistryRepository(store.events).registerProject({
      eventId: PROJECT_EVENT_ID,
      projectId: PROJECT_ID,
      displayName: "compiled-plan-confirmation",
      workspace: { platform: "macos", absolutePath: "/Users/example/compiled-confirmation" },
      occurredAtMs: 1_750_000_000_001,
    });
    new ModelRoutingProfileRepository(store.events).setConfiguration({
      profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      occurredAtMs: 1_750_000_000_002,
      configuration: {
        schemaVersion: 1,
        revisionId: CONFIGURATION_REVISION_ID,
        revisionNumber: 1,
        tiers: {
          fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
          standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
          deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
        },
      },
    });
    new ProjectRoutingProfileBindingRepository(store.events).bindProfile({
      eventId: BINDING_EVENT_ID,
      projectId: PROJECT_ID,
      expectedBindingVersion: 0,
      previousProfileId: null,
      profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
      expectedProfileVersion: 1,
      expectedConfigurationRevisionId: CONFIGURATION_REVISION_ID,
      occurredAtMs: 1_750_000_000_003,
    });
    new ProjectTaskService(store, { now: () => 1_750_000_000_004 }).create({
      commandId: REQUIREMENT_ID,
      ownershipCommandId: OWNERSHIP_EVENT_ID,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      expectedProjectVersion: 1,
      expectedRoutingBindingVersion: 1,
      title: "Confirm a compiled candidate Plan",
      sourceText: "Confirm only after explicit user review.",
    });
    new TaskPlanRepository(store.events).revisePlan({
      eventId: CANDIDATE_PLAN_ID,
      taskId: TASK_ID,
      occurredAtMs: 1_750_000_000_005,
      expectedTaskVersion: 1,
      previousPlanRevisionId: null,
      plan: {
        revisionId: CANDIDATE_PLAN_ID,
        status: "candidate",
        basedOnRequirementRevisionId: REQUIREMENT_ID,
        steps: [
          {
            stepId: STEP_ID,
            title: "Preserve the candidate step",
            description: "Copy the reviewed step into an authoritative Plan revision.",
            acceptanceCriteria: ["Execution remains locked."],
          },
        ],
      },
    });
    const service = new ProjectTaskService(store, { now: () => 1_750_000_000_006 });
    const result = service.confirmCandidatePlan({
      commandId: CONFIRMED_PLAN_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      expectedTaskVersion: 2,
      expectedOwnershipVersion: 1,
      previousRequirementRevisionId: REQUIREMENT_ID,
      candidatePlanRevisionId: CANDIDATE_PLAN_ID,
    });
    if (result.status !== "confirmed") {
      throw new Error("The compiled candidate Plan confirmation did not commit.");
    }
    store.close();
    store = await DaemonStateStore.open({ databasePath });
    const detail = new ProjectTaskService(store).detail({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
    });
    if (
      detail.stage !== "confirmed_plan" ||
      detail.taskVersion !== 3 ||
      detail.candidatePlan !== null ||
      detail.confirmedPlan?.revisionId !== CONFIRMED_PLAN_ID ||
      detail.confirmedPlan.steps[0]?.stepId !== STEP_ID ||
      detail.confirmedPlan.steps[0]?.title !== "Preserve the candidate step"
    ) {
      throw new Error("The compiled confirmed Plan did not recover exactly.");
    }
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
