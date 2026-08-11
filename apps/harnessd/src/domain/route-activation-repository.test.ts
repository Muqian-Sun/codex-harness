import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore } from "../persistence/event-store.js";
import { classifyShadowModelRoute } from "./model-route-classifier.js";
import {
  ROUTE_ACTIVATION_PROJECTION,
  RouteActivationRepository,
  type NodeExecutionAdmissionRecord,
  type RouteActivation,
} from "./route-activation-repository.js";

const directories: string[] = [];
const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

async function repository(): Promise<{
  events: HarnessEventStore;
  repository: RouteActivationRepository;
}> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-route-activation-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const events = await HarnessEventStore.open({
    path: join(directory, "harness.db"),
    projections: [ROUTE_ACTIVATION_PROJECTION],
  });
  return { events, repository: new RouteActivationRepository(events) };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function activation(activationId = id(1), decisionId = id(2)): RouteActivation {
  const canonicalPath = "/Users/example/project";
  const deviceId = "1";
  const inode = "2";
  const gitHead = "a".repeat(40);
  const statusDigest = digest("");
  const configuration = {
    schemaVersion: 1 as const,
    revisionId: id(20),
    revisionNumber: 1,
    tiers: {
      fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
      standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
      deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
    },
  };
  return Object.freeze({
    schemaVersion: 1,
    executionAuthorized: true,
    activationId,
    decisionId,
    projectId: id(3),
    projectVersion: 1,
    taskId: id(4),
    taskVersion: 3,
    ownershipVersion: 1,
    nodeId: id(5),
    requirementRevisionId: id(6),
    planRevisionId: id(7),
    graphRevisionId: id(8),
    manifestId: id(9),
    manifestStateVersion: 2,
    manifestPlanningFence: Object.freeze({
      schemaVersion: 1,
      taskId: id(4),
      requirementRevisionId: id(6),
      planRevisionId: id(7),
      graphRevisionId: id(8),
      nodeId: id(5),
      nodeDigest: "1".repeat(64),
      digest: "2".repeat(64),
    }),
    routingBindingVersion: 1,
    profileId: id(10),
    profileVersion: 1,
    configurationRevisionId: id(20),
    catalog: Object.freeze({
      snapshotId: id(11),
      workerSessionId: id(12),
      provider: "openai",
      observedAtMs: 1,
    }),
    routeDecision: classifyShadowModelRoute(
      {
        schemaVersion: 1,
        taskKind: "simple",
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
      configuration,
    ),
    permission: Object.freeze({
      schemaVersion: 1,
      policyVersion: "node-execution-permission-policy-v1",
      workspaceMode: "read_only",
      commandExecution: false,
      networkAccess: false,
      allowedOperationKinds: Object.freeze(["answer"] as const),
    }),
    workspace: Object.freeze({
      schemaVersion: 1,
      policyVersion: "macos-workspace-admission-policy-v1",
      platform: "macos",
      canonicalPath,
      deviceId,
      inode,
      gitHead,
      statusDigest,
      workspaceDigest: digest(
        JSON.stringify({ canonicalPath, deviceId, gitHead, inode, statusDigest }),
      ),
      observedAtMs: 5,
    }),
    userConfirmedAtMs: 6,
  });
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function activatedRecord(activationId = id(1), decisionId = id(2)): NodeExecutionAdmissionRecord {
  const routeActivation = activation(activationId, decisionId);
  return Object.freeze({
    schemaVersion: 1,
    activationId,
    decisionId,
    commandDigest: "d".repeat(64),
    projectId: routeActivation.projectId,
    taskId: routeActivation.taskId,
    nodeId: routeActivation.nodeId,
    manifestId: routeActivation.manifestId,
    operationKinds: Object.freeze(["answer"] as const),
    occurredAtMs: 6,
    status: "activated",
    rejectionReason: null,
    routeActivation,
  });
}

function deniedRecord(activationId = id(30), decisionId = id(31)): NodeExecutionAdmissionRecord {
  return Object.freeze({
    schemaVersion: 1,
    activationId,
    decisionId,
    commandDigest: "e".repeat(64),
    projectId: id(3),
    taskId: id(4),
    nodeId: id(5),
    manifestId: id(9),
    operationKinds: Object.freeze(["answer"] as const),
    occurredAtMs: 5,
    status: "denied",
    rejectionReason: "workspace_dirty",
    routeActivation: null,
  });
}

describe("route activation repository", () => {
  it("persists, projects, recovers and idempotently retries an activated record", async () => {
    const store = await repository();
    const record = activatedRecord();

    expect(store.repository.record(record)).toMatchObject({ duplicate: false, record });
    expect(store.repository.readAdmission(id(4), id(1))).toEqual(record);
    expect(store.repository.readLatestForNode(id(4), id(5))).toEqual(record);
    expect(store.repository.record(record)).toMatchObject({ duplicate: true, record });

    store.events.close();
  });

  it("retains immutable history while later commands advance the node latest projection", async () => {
    const store = await repository();
    expect(store.repository.record(deniedRecord())).toMatchObject({ duplicate: false });

    const activated = activatedRecord(id(40), id(41));
    expect(store.repository.record(activated)).toMatchObject({ duplicate: false });
    expect(store.repository.readLatestForNode(id(4), id(5))).toMatchObject({
      activationId: id(40),
      status: "activated",
    });
    expect(store.repository.record(activatedRecord(id(42), id(43)))).toMatchObject({
      duplicate: false,
    });
    expect(store.repository.readLatestForNode(id(4), id(5))).toMatchObject({
      activationId: id(42),
      status: "activated",
    });
    expect(store.repository.readAdmission(id(4), id(40))).toMatchObject({
      activationId: id(40),
      status: "activated",
    });

    expect(() =>
      store.repository.record({ ...deniedRecord(id(44), id(45)), occurredAtMs: 5 }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));

    store.events.close();
  });

  it("rejects malformed commands, identifier reuse and missing reads with fixed errors", async () => {
    const store = await repository();
    const record = deniedRecord();
    store.repository.record(record);

    expect(() =>
      store.repository.record({ ...record, commandDigest: "f".repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() =>
      store.repository.record({ ...record, commandDigest: "not-a-digest" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() => store.repository.record(null as never)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => store.repository.record({ ...record, unexpected: true } as never)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    const activated = activatedRecord(id(50), id(51));
    expect(() =>
      store.repository.record({
        ...activated,
        routeActivation: {
          ...activated.routeActivation,
          workspace: { ...activated.routeActivation?.workspace, workspaceDigest: "f".repeat(64) },
        },
      } as never),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      store.repository.record({
        ...activated,
        routeActivation: {
          ...activated.routeActivation,
          permission: {
            ...activated.routeActivation?.permission,
            allowedOperationKinds: ["answer", "answer"],
          },
        },
      } as never),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() => store.repository.readAdmission("invalid", id(30))).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => store.repository.readAdmission(id(4), id(99))).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => store.repository.readLatestForNode(id(4), id(99))).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => store.repository.readLatestForNode("invalid", id(5))).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );

    store.events.close();
    expect(() => store.repository.readAdmission(id(4), id(30))).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });
});
