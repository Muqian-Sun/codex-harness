import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessTaskExecutionActivateParams } from "@codex-harness/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalogSnapshot } from "../domain/model-catalog.js";
import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import { NodeOperationManifestRepository } from "../domain/node-operation-manifest-repository.js";
import { ProjectRegistryRepository } from "../domain/project-registry-repository.js";
import { ProjectRoutingProfileBindingRepository } from "../domain/project-routing-profile-binding-repository.js";
import { RouteActivationRepository } from "../domain/route-activation-repository.js";
import { TaskPlanRepository } from "../domain/task-plan-store.js";
import { TaskProjectOwnershipRepository } from "../domain/task-project-ownership-repository.js";
import type { AppServerWorkerManager } from "./app-server-worker-manager.js";
import { DaemonStateStore } from "./daemon-state-store.js";
import type { MacosWorkspaceAdmissionObservation } from "./macos-workspace-admission-observer.js";
import {
  NodeExecutionAdmissionService,
  NodeExecutionAdmissionServiceError,
} from "./node-execution-admission-service.js";

const directories: string[] = [];
const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const PROJECT_ID = id(1);
const TASK_ID = id(2);
const REQUIREMENT_ID = id(3);
const PLAN_ID = id(6);
const GRAPH_ID = id(8);
const NODE_ID = id(9);
const MANIFEST_ID = id(10);
const PROFILE_ID = id(12);
const CONFIGURATION_ID = id(13);
const WORKSPACE_STATUS_DIGEST = digest("");
const WORKSPACE_DIGEST = digest(
  JSON.stringify({
    canonicalPath: "/Users/example/project",
    deviceId: "1",
    gitHead: "a".repeat(40),
    inode: "2",
    statusDigest: WORKSPACE_STATUS_DIGEST,
  }),
);

type Setup = Readonly<{
  store: DaemonStateStore;
  service: NodeExecutionAdmissionService;
  params: HarnessTaskExecutionActivateParams;
  observe: ReturnType<typeof vi.fn>;
}>;

async function setup(
  operationKinds: readonly ("answer" | "network_read")[] = ["answer"],
  options: Readonly<{
    includeFastModel?: boolean;
    observation?: MacosWorkspaceAdmissionObservation;
  }> = {},
): Promise<Setup> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-execution-admission-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const store = await DaemonStateStore.open({ databasePath: join(directory, "harness.db") });
  const projects = new ProjectRegistryRepository(store.events);
  const profiles = new ModelRoutingProfileRepository(store.events);
  const bindings = new ProjectRoutingProfileBindingRepository(store.events);
  const ownerships = new TaskProjectOwnershipRepository(store.events);
  const tasks = new TaskPlanRepository(store.events);
  const manifests = new NodeOperationManifestRepository(store.events);

  projects.registerProject({
    eventId: id(21),
    projectId: PROJECT_ID,
    displayName: "Project",
    workspace: { platform: "macos", absolutePath: "/Users/example/project" },
    occurredAtMs: 1,
  });
  profiles.setConfiguration({
    profileId: PROFILE_ID,
    expectedProfileVersion: 0,
    previousConfigurationRevisionId: null,
    occurredAtMs: 1,
    configuration: {
      schemaVersion: 1,
      revisionId: CONFIGURATION_ID,
      revisionNumber: 1,
      tiers: {
        fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
        standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
      },
    },
  });
  bindings.bindProfile({
    eventId: id(14),
    projectId: PROJECT_ID,
    expectedBindingVersion: 0,
    previousProfileId: null,
    profileId: PROFILE_ID,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_ID,
    occurredAtMs: 2,
  });
  ownerships.createTaskInProject({
    task: {
      eventId: REQUIREMENT_ID,
      taskId: TASK_ID,
      title: "Task",
      occurredAtMs: 1,
      requirement: {
        revisionId: REQUIREMENT_ID,
        sourceText: "answer the question",
        objective: "answer the question",
        constraints: [],
        acceptanceCriteria: [],
      },
    },
    ownershipEventId: id(5),
    projectId: PROJECT_ID,
    expectedProjectVersion: 1,
  });
  tasks.revisePlan({
    eventId: PLAN_ID,
    taskId: TASK_ID,
    occurredAtMs: 3,
    expectedTaskVersion: 1,
    previousPlanRevisionId: null,
    plan: {
      revisionId: PLAN_ID,
      status: "confirmed",
      basedOnRequirementRevisionId: REQUIREMENT_ID,
      steps: [
        {
          stepId: id(7),
          title: "Answer",
          description: "Answer",
          acceptanceCriteria: ["answered"],
        },
      ],
    },
  });
  tasks.commitTaskGraph({
    eventId: GRAPH_ID,
    taskId: TASK_ID,
    occurredAtMs: 4,
    expectedTaskVersion: 2,
    previousGraphRevisionId: null,
    graph: {
      revisionId: GRAPH_ID,
      basedOnPlanRevisionId: PLAN_ID,
      nodes: [
        {
          nodeId: NODE_ID,
          sourcePlanStepId: id(7),
          title: "Answer",
          description: "Answer",
          acceptanceCriteria: ["answered"],
          dependsOnNodeIds: [],
        },
      ],
    },
  });
  manifests.propose({
    manifestId: MANIFEST_ID,
    taskId: TASK_ID,
    nodeId: NODE_ID,
    expectedTaskVersion: 3,
    expectedGraphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 0,
    previousManifestId: null,
    occurredAtMs: 5,
    operations: operationKinds.map((kind, index) => ({ operationId: id(30 + index), kind })),
  });
  manifests.confirm({
    eventId: id(11),
    taskId: TASK_ID,
    nodeId: NODE_ID,
    manifestId: MANIFEST_ID,
    expectedTaskVersion: 3,
    expectedGraphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 1,
    occurredAtMs: 6,
  });

  const catalog: ModelCatalogSnapshot = Object.freeze({
    schemaVersion: 1,
    snapshotId: id(15),
    workerSessionId: id(16),
    provider: "openai",
    observedAtMs: 1,
    includeHidden: true,
    complete: true,
    models: Object.freeze([
      ...(options.includeFastModel === false
        ? []
        : [
            Object.freeze({
              id: "fast-id",
              model: "fast",
              hidden: false,
              defaultReasoningEffort: "low",
              supportedReasoningEfforts: Object.freeze(["low"]),
              inputModalities: Object.freeze(["text" as const]),
            }),
          ]),
      Object.freeze({
        id: "standard-id",
        model: "standard",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: Object.freeze(["medium"]),
        inputModalities: Object.freeze(["text" as const]),
      }),
      Object.freeze({
        id: "deep-id",
        model: "deep",
        hidden: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: Object.freeze(["high"]),
        inputModalities: Object.freeze(["text" as const]),
      }),
    ]),
  });
  const workerManager = {
    state: "ready",
    catalog,
    isCatalogCurrent: (candidate: unknown) => candidate === catalog,
  } as unknown as AppServerWorkerManager;
  const observation: MacosWorkspaceAdmissionObservation =
    options.observation ??
    Object.freeze({
      status: "verified",
      snapshot: Object.freeze({
        schemaVersion: 1,
        policyVersion: "macos-workspace-admission-policy-v1",
        platform: "macos",
        canonicalPath: "/Users/example/project",
        deviceId: "1",
        inode: "2",
        gitHead: "a".repeat(40),
        statusDigest: WORKSPACE_STATUS_DIGEST,
        workspaceDigest: WORKSPACE_DIGEST,
        observedAtMs: 7,
      }),
    });
  const observe = vi.fn(async () => observation);
  const service = new NodeExecutionAdmissionService(store, workerManager, {
    now: () => 10,
    workspaceObserver: { observe },
  });
  const params: HarnessTaskExecutionActivateParams = Object.freeze({
    activationId: id(19),
    decisionId: id(20),
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    nodeId: NODE_ID,
    manifestId: MANIFEST_ID,
    expectedProjectVersion: 1,
    expectedTaskVersion: 3,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: REQUIREMENT_ID,
    confirmedPlanRevisionId: PLAN_ID,
    graphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 2,
    expectedRoutingBindingVersion: 1,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: CONFIGURATION_ID,
    userConfirmed: true,
  });
  return Object.freeze({ store, service, params, observe });
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("node execution admission service", () => {
  it("activates a confirmed node against current model, workspace and state fences", async () => {
    const context = await setup();

    await expect(context.service.activate(context.params)).resolves.toMatchObject({
      status: "activated",
      route: { tier: "fast", provider: "openai", model: "fast", reasoningEffort: "low" },
      permission: { workspaceMode: "read_only", commandExecution: false, networkAccess: false },
      evidence: {
        manifestId: MANIFEST_ID,
        catalogSnapshotId: id(15),
        workspaceDigest: WORKSPACE_DIGEST,
        gitHead: "a".repeat(40),
      },
    });
    expect(context.observe).toHaveBeenCalledOnce();
    expect(
      new RouteActivationRepository(context.store.events).readLatestForNode(TASK_ID, NODE_ID),
    ).toMatchObject({ status: "activated", routeActivation: { executionAuthorized: true } });

    await expect(context.service.activate(context.params)).resolves.toMatchObject({
      status: "existing",
    });
    expect(context.observe).toHaveBeenCalledOnce();
    context.store.close();
  });

  it("persists policy denials without touching the workspace", async () => {
    const unconfirmed = await setup();
    await expect(
      unconfirmed.service.activate({ ...unconfirmed.params, userConfirmed: false }),
    ).resolves.toMatchObject({
      status: "denied",
      rejectionReason: "user_confirmation_required",
      route: null,
      permission: null,
    });
    expect(unconfirmed.observe).not.toHaveBeenCalled();
    unconfirmed.store.close();

    const forbidden = await setup(["network_read"]);
    await expect(forbidden.service.activate(forbidden.params)).resolves.toMatchObject({
      status: "denied",
      rejectionReason: "operation_not_allowed",
    });
    expect(forbidden.observe).not.toHaveBeenCalled();
    forbidden.store.close();
  });

  it("persists stable model and workspace denials", async () => {
    const missingModel = await setup(["answer"], { includeFastModel: false });
    await expect(missingModel.service.activate(missingModel.params)).resolves.toMatchObject({
      status: "denied",
      rejectionReason: "model_unavailable",
    });
    expect(missingModel.observe).not.toHaveBeenCalled();
    missingModel.store.close();

    const dirty = await setup(["answer"], {
      observation: Object.freeze({ status: "denied", rejectionReason: "workspace_dirty" }),
    });
    await expect(dirty.service.activate(dirty.params)).resolves.toMatchObject({
      status: "denied",
      rejectionReason: "workspace_dirty",
    });
    dirty.store.close();

    const futureObservation = await setup(["answer"], {
      observation: Object.freeze({
        status: "verified",
        snapshot: Object.freeze({
          schemaVersion: 1,
          policyVersion: "macos-workspace-admission-policy-v1",
          platform: "macos",
          canonicalPath: "/Users/example/project",
          deviceId: "1",
          inode: "2",
          gitHead: "a".repeat(40),
          statusDigest: WORKSPACE_STATUS_DIGEST,
          workspaceDigest: WORKSPACE_DIGEST,
          observedAtMs: 11,
        }),
      }),
    });
    await expect(
      futureObservation.service.activate(futureObservation.params),
    ).rejects.toMatchObject({ code: "conflict" });
    futureObservation.store.close();
  });

  it("rejects stale fences, identifier reuse and unavailable state", async () => {
    const context = await setup();
    await expect(
      context.service.activate({ ...context.params, expectedTaskVersion: 4 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await context.service.activate(context.params);
    await expect(
      context.service.activate({ ...context.params, decisionId: id(40) }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(context.service.activate({})).rejects.toMatchObject({ code: "conflict" });

    context.store.close();
    await expect(context.service.activate(context.params)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(
      () => new NodeExecutionAdmissionService(context.store, {} as AppServerWorkerManager),
    ).toThrow(NodeExecutionAdmissionServiceError);
  });
});

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
