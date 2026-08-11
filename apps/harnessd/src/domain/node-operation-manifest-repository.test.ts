import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@codex-harness/protocol";

import { HarnessEventStore } from "../persistence/event-store.js";
import {
  NODE_OPERATION_MANIFEST_PROJECTION,
  NodeOperationManifestError,
  NodeOperationManifestRepository,
  type ConfirmNodeOperationManifestInput,
  type ProposeNodeOperationManifestInput,
} from "./node-operation-manifest-repository.js";
import { TASK_PLAN_PROJECTION, TaskPlanRepository } from "./task-plan-store.js";

const TASK_ID = uuid(1);
const REQUIREMENT_ID = uuid(2);
const PLAN_ID = uuid(3);
const GRAPH_ID = uuid(4);
const STEP_ONE_ID = uuid(5);
const STEP_TWO_ID = uuid(6);
const NODE_ONE_ID = uuid(7);
const NODE_TWO_ID = uuid(8);
const MANIFEST_ONE_ID = uuid(9);
const CONFIRM_ONE_ID = uuid(10);
const MANIFEST_TWO_ID = uuid(11);
const CONFIRM_TWO_ID = uuid(12);
const CANDIDATE_PLAN_ID = uuid(13);
const NEXT_REQUIREMENT_ID = uuid(14);
const temporaryDirectories: string[] = [];
const stores: HarnessEventStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-node-manifest-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openRepository(existingPath?: string) {
  const path = existingPath ?? (await databasePath());
  const events = await HarnessEventStore.open({
    path,
    projections: [TASK_PLAN_PROJECTION, NODE_OPERATION_MANIFEST_PROJECTION],
  });
  stores.push(events);
  return {
    path,
    events,
    tasks: new TaskPlanRepository(events),
    manifests: new NodeOperationManifestRepository(events),
  };
}

function materializeTask(tasks: TaskPlanRepository): void {
  tasks.createTask({
    eventId: REQUIREMENT_ID,
    taskId: TASK_ID,
    title: "Persist node operations",
    occurredAtMs: 100,
    requirement: {
      revisionId: REQUIREMENT_ID,
      sourceText: "Persist the intended operations before execution.",
      objective: "Create an authoritative operation manifest.",
      constraints: ["Do not authorize execution."],
      acceptanceCriteria: ["The manifest survives restart."],
    },
  });
  tasks.revisePlan({
    eventId: PLAN_ID,
    taskId: TASK_ID,
    occurredAtMs: 101,
    expectedTaskVersion: 1,
    previousPlanRevisionId: null,
    plan: {
      revisionId: PLAN_ID,
      status: "confirmed",
      basedOnRequirementRevisionId: REQUIREMENT_ID,
      steps: planSteps(),
    },
  });
  tasks.commitTaskGraph({
    eventId: GRAPH_ID,
    taskId: TASK_ID,
    occurredAtMs: 102,
    expectedTaskVersion: 2,
    previousGraphRevisionId: null,
    graph: {
      revisionId: GRAPH_ID,
      basedOnPlanRevisionId: PLAN_ID,
      nodes: [
        {
          nodeId: NODE_ONE_ID,
          sourcePlanStepId: STEP_ONE_ID,
          title: "Inspect",
          description: "Inspect the workspace.",
          acceptanceCriteria: ["Relevant files identified."],
          dependsOnNodeIds: [],
        },
        {
          nodeId: NODE_TWO_ID,
          sourcePlanStepId: STEP_TWO_ID,
          title: "Modify",
          description: "Modify the workspace.",
          acceptanceCriteria: ["Change is verified."],
          dependsOnNodeIds: [NODE_ONE_ID],
        },
      ],
    },
  });
}

function planSteps() {
  return [
    {
      stepId: STEP_ONE_ID,
      title: "Inspect",
      description: "Inspect the workspace.",
      acceptanceCriteria: ["Relevant files identified."],
    },
    {
      stepId: STEP_TWO_ID,
      title: "Modify",
      description: "Modify the workspace.",
      acceptanceCriteria: ["Change is verified."],
    },
  ];
}

function proposeInput(
  overrides: Partial<ProposeNodeOperationManifestInput> = {},
): ProposeNodeOperationManifestInput {
  return {
    manifestId: MANIFEST_ONE_ID,
    taskId: TASK_ID,
    nodeId: NODE_ONE_ID,
    expectedTaskVersion: 3,
    expectedGraphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 0,
    previousManifestId: null,
    occurredAtMs: 103,
    operations: [{ operationId: uuid(101), kind: "inspect_workspace" }],
    metadata: { actor: "user", correlationId: "manifest-proposal" },
    ...overrides,
  };
}

function confirmInput(
  overrides: Partial<ConfirmNodeOperationManifestInput> = {},
): ConfirmNodeOperationManifestInput {
  return {
    eventId: CONFIRM_ONE_ID,
    taskId: TASK_ID,
    nodeId: NODE_ONE_ID,
    manifestId: MANIFEST_ONE_ID,
    expectedTaskVersion: 3,
    expectedGraphRevisionId: GRAPH_ID,
    expectedManifestStateVersion: 1,
    occurredAtMs: 104,
    metadata: { actor: "user", correlationId: "manifest-confirmation" },
    ...overrides,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("node operation manifest repository", () => {
  it("persists candidate and confirmed manifests with an immutable planning fence", async () => {
    const { path, events, tasks, manifests } = await openRepository();
    materializeTask(tasks);

    const proposed = manifests.propose(proposeInput());
    expect(proposed).toMatchObject({
      duplicate: false,
      manifest: {
        manifestId: MANIFEST_ONE_ID,
        stateVersion: 1,
        status: "candidate",
        proposedAtTaskVersion: 3,
        confirmedAtTaskVersion: null,
        planningFence: {
          taskId: TASK_ID,
          requirementRevisionId: REQUIREMENT_ID,
          planRevisionId: PLAN_ID,
          graphRevisionId: GRAPH_ID,
          nodeId: NODE_ONE_ID,
        },
      },
    });
    expect(proposed.manifest.planningFence.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(proposed.manifest.planningFence.nodeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(proposed.manifest.operations)).toBe(true);

    const confirmed = manifests.confirm(confirmInput());
    expect(confirmed).toMatchObject({
      duplicate: false,
      manifest: {
        stateVersion: 2,
        status: "confirmed",
        confirmedAtTaskVersion: 3,
        confirmedAtMs: 104,
      },
    });
    expect(manifests.readCurrentManifest(TASK_ID, NODE_ONE_ID)).toEqual(confirmed.manifest);
    expect(manifests.listTaskManifests(TASK_ID)).toEqual([confirmed.manifest]);
    expect(events.inspect()).toMatchObject({ eventCount: 5, projectionCount: 2 });

    events.close();
    const reopened = await openRepository(path);
    expect(reopened.manifests.readLatestManifest(TASK_ID, NODE_ONE_ID)).toEqual(confirmed.manifest);
  });

  it("keeps the planning fence current across a non-authoritative candidate plan", async () => {
    const { tasks, manifests } = await openRepository();
    materializeTask(tasks);
    manifests.propose(proposeInput());
    tasks.revisePlan({
      eventId: CANDIDATE_PLAN_ID,
      taskId: TASK_ID,
      occurredAtMs: 104,
      expectedTaskVersion: 3,
      previousPlanRevisionId: PLAN_ID,
      plan: {
        revisionId: CANDIDATE_PLAN_ID,
        status: "candidate",
        basedOnRequirementRevisionId: REQUIREMENT_ID,
        steps: planSteps(),
      },
    });

    expect(manifests.readCurrentManifest(TASK_ID, NODE_ONE_ID).status).toBe("candidate");
    const confirmed = manifests.confirm(
      confirmInput({ expectedTaskVersion: 4, occurredAtMs: 105 }),
    );
    expect(confirmed.manifest.confirmedAtTaskVersion).toBe(4);
  });

  it("supersedes a candidate or confirmed manifest with an explicit new revision", async () => {
    const { tasks, manifests } = await openRepository();
    materializeTask(tasks);
    manifests.propose(proposeInput());
    manifests.confirm(confirmInput());

    const replacement = manifests.propose(
      proposeInput({
        manifestId: MANIFEST_TWO_ID,
        expectedManifestStateVersion: 2,
        previousManifestId: MANIFEST_ONE_ID,
        occurredAtMs: 105,
        operations: [
          { operationId: uuid(102), kind: "inspect_workspace" },
          { operationId: uuid(103), kind: "run_workspace_command" },
        ],
      }),
    );
    expect(replacement.manifest).toMatchObject({
      manifestId: MANIFEST_TWO_ID,
      stateVersion: 3,
      status: "candidate",
      confirmedAtMs: null,
    });
    const confirmed = manifests.confirm(
      confirmInput({
        eventId: CONFIRM_TWO_ID,
        manifestId: MANIFEST_TWO_ID,
        expectedManifestStateVersion: 3,
        occurredAtMs: 106,
      }),
    );
    expect(confirmed.manifest).toMatchObject({ stateVersion: 4, status: "confirmed" });
  });

  it("retains stale manifests for audit while rejecting them as current", async () => {
    const { tasks, manifests } = await openRepository();
    materializeTask(tasks);
    const proposed = manifests.propose(proposeInput());
    const confirmed = manifests.confirm(confirmInput());
    tasks.reviseRequirements({
      eventId: NEXT_REQUIREMENT_ID,
      taskId: TASK_ID,
      occurredAtMs: 105,
      expectedTaskVersion: 3,
      previousRequirementRevisionId: REQUIREMENT_ID,
      requirement: {
        revisionId: NEXT_REQUIREMENT_ID,
        sourceText: "Changed requirement.",
        objective: "Invalidate the old graph.",
        constraints: [],
        acceptanceCriteria: ["Old manifests are stale."],
      },
    });

    expect(manifests.readLatestManifest(TASK_ID, NODE_ONE_ID)).toEqual(confirmed.manifest);
    expect(() => manifests.readCurrentManifest(TASK_ID, NODE_ONE_ID)).toThrowError(
      expect.objectContaining({ code: "stale" }),
    );
    expect(manifests.propose(proposeInput())).toEqual({ ...proposed, duplicate: true });
    expect(manifests.confirm(confirmInput())).toEqual({ ...confirmed, duplicate: true });
  });

  it("requires exact optimistic fences, timelines and current pending graph subjects", async () => {
    const { tasks, manifests } = await openRepository();
    materializeTask(tasks);
    const conflicts = [
      proposeInput({ expectedTaskVersion: 2 }),
      proposeInput({ expectedGraphRevisionId: uuid(90) }),
      proposeInput({ nodeId: uuid(91) }),
      proposeInput({ occurredAtMs: 101 }),
      proposeInput({ expectedManifestStateVersion: 1, previousManifestId: uuid(92) }),
    ];
    for (const input of conflicts) {
      expect(() => manifests.propose(input)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }

    manifests.propose(proposeInput());
    const confirmations = [
      confirmInput({ expectedTaskVersion: 2 }),
      confirmInput({ expectedGraphRevisionId: uuid(93) }),
      confirmInput({ expectedManifestStateVersion: 2 }),
      confirmInput({ manifestId: uuid(94) }),
      confirmInput({ nodeId: NODE_TWO_ID }),
      confirmInput({ occurredAtMs: 102 }),
    ];
    for (const input of confirmations) {
      expect(() => manifests.confirm(input)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
  });

  it("accepts only exact historical retries including metadata", async () => {
    const { tasks, manifests } = await openRepository();
    materializeTask(tasks);
    const proposed = manifests.propose(proposeInput());
    expect(manifests.propose(proposeInput())).toEqual({ ...proposed, duplicate: true });
    expect(() =>
      manifests.propose(
        proposeInput({ operations: [{ operationId: uuid(104), kind: "network_read" }] }),
      ),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() => manifests.propose(proposeInput({ metadata: { actor: "system" } }))).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );

    const confirmed = manifests.confirm(confirmInput());
    expect(manifests.confirm(confirmInput())).toEqual({ ...confirmed, duplicate: true });
    expect(() => manifests.confirm(confirmInput({ expectedTaskVersion: 4 }))).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => manifests.confirm(confirmInput({ metadata: { actor: "system" } }))).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
  });

  it("validates exact commands, operations, queries and projection registration", async () => {
    const { tasks, manifests } = await openRepository();
    materializeTask(tasks);
    const invalidProposals: unknown[] = [
      null,
      { ...proposeInput(), previousManifestId: MANIFEST_ONE_ID },
      { ...proposeInput(), operations: [] },
      { ...proposeInput(), operations: [{ operationId: "bad", kind: "answer" }] },
      { ...proposeInput(), metadata: { actor: "not valid" } },
      {
        ...proposeInput(),
        expectedManifestStateVersion: Number.MAX_SAFE_INTEGER,
        previousManifestId: uuid(50),
      },
      { ...proposeInput(), extra: true },
    ];
    for (const input of invalidProposals) {
      expect(() => manifests.propose(input as ProposeNodeOperationManifestInput)).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    const getter = Object.create(null, {
      ...Object.fromEntries(
        Object.entries(proposeInput()).map(([key, value]) => [key, { value, enumerable: true }]),
      ),
      taskId: { get: () => TASK_ID, enumerable: true },
    });
    expect(() => manifests.propose(getter)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => manifests.confirm({ ...confirmInput(), eventId: MANIFEST_ONE_ID })).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    const invalidConfirmations: unknown[] = [
      null,
      { ...confirmInput(), eventId: "bad" },
      { ...confirmInput(), expectedTaskVersion: 0 },
      { ...confirmInput(), occurredAtMs: -1 },
      { ...confirmInput(), expectedManifestStateVersion: Number.MAX_SAFE_INTEGER },
      { ...confirmInput(), metadata: null },
      { ...confirmInput(), extra: true },
    ];
    for (const input of invalidConfirmations) {
      expect(() => manifests.confirm(input as ConfirmNodeOperationManifestInput)).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    expect(() => manifests.readLatestManifest("bad", NODE_ONE_ID)).toThrow(
      NodeOperationManifestError,
    );
    expect(() => manifests.readLatestManifest(TASK_ID, NODE_ONE_ID)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => manifests.listTaskManifests(TASK_ID, "bad", 0)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );

    const missing = await HarnessEventStore.open({
      path: await databasePath(),
      projections: [TASK_PLAN_PROJECTION],
    });
    stores.push(missing);
    expect(() => new NodeOperationManifestRepository(missing)).toThrowError(
      expect.objectContaining({ code: "storage_failure" }),
    );
  });

  it("maps closed storage and conflicting event identifiers without leaking internals", async () => {
    const { events, tasks, manifests } = await openRepository();
    materializeTask(tasks);
    events.append({
      eventId: MANIFEST_ONE_ID,
      streamType: "test.events",
      streamId: "test",
      eventType: "test.recorded",
      eventVersion: 1,
      occurredAtMs: 103,
      payload: {},
    });
    expect(() => manifests.propose(proposeInput())).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    events.close();
    expect(() => manifests.listTaskManifests(TASK_ID)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });

  it("fails closed when stored events violate projection invariants", async () => {
    const { events, tasks, manifests } = await openRepository();
    materializeTask(tasks);
    const proposed = manifests.propose(proposeInput());
    const proposedPayload = clonePayload(proposed.event.payload);

    expect(() =>
      appendRawManifestEvent(
        events,
        uuid(201),
        "task.node_operation_manifest_proposed",
        103,
        proposedPayload,
      ),
    ).toThrowError(expect.objectContaining({ code: "projection_failure" }));

    const corruptions: Array<(payload: Record<string, unknown>) => void> = [
      (payload) => {
        nestedManifest(payload).planningFence = {
          ...nestedFence(payload),
          digest: "0".repeat(64),
        };
      },
      (payload) => {
        nestedManifest(payload).nodeId = "bad";
      },
      (payload) => {
        nestedManifest(payload).stateVersion = 0;
      },
      (payload) => {
        nestedManifest(payload).proposedAtMs = -1;
      },
      (payload) => {
        nestedManifest(payload).planningFence = {
          ...nestedFence(payload),
          nodeDigest: "bad",
        };
      },
      (payload) => {
        nestedManifest(payload).confirmedAtMs = 103;
      },
    ];
    corruptions.forEach((corrupt, index) => {
      const payload = clonePayload(proposed.event.payload);
      corrupt(payload);
      expect(() =>
        appendRawManifestEvent(
          events,
          uuid(210 + index),
          "task.node_operation_manifest_proposed",
          103,
          payload,
        ),
      ).toThrowError(expect.objectContaining({ code: "projection_failure" }));
    });

    const confirmed = manifests.confirm(confirmInput());
    const orphan = await HarnessEventStore.open({
      path: await databasePath(),
      projections: [NODE_OPERATION_MANIFEST_PROJECTION],
    });
    stores.push(orphan);
    expect(() =>
      appendRawManifestEvent(
        orphan,
        CONFIRM_ONE_ID,
        "task.node_operation_manifest_confirmed",
        104,
        clonePayload(confirmed.event.payload),
      ),
    ).toThrowError(expect.objectContaining({ code: "projection_failure" }));

    appendRawManifestEvent(
      orphan,
      MANIFEST_ONE_ID,
      "task.node_operation_manifest_proposed",
      103,
      clonePayload(proposed.event.payload),
    );
    const changedConfirmation = clonePayload(confirmed.event.payload);
    nestedManifest(changedConfirmation).operations = [
      { operationId: uuid(299), kind: "network_read" },
    ];
    expect(() =>
      appendRawManifestEvent(
        orphan,
        CONFIRM_ONE_ID,
        "task.node_operation_manifest_confirmed",
        104,
        changedConfirmation,
      ),
    ).toThrowError(expect.objectContaining({ code: "projection_failure" }));

    const regressedTaskVersion = clonePayload(confirmed.event.payload);
    nestedManifest(regressedTaskVersion).confirmedAtTaskVersion = 2;
    expect(() =>
      appendRawManifestEvent(
        orphan,
        CONFIRM_ONE_ID,
        "task.node_operation_manifest_confirmed",
        104,
        regressedTaskVersion,
      ),
    ).toThrowError(expect.objectContaining({ code: "projection_failure" }));
  });
});

function clonePayload(payload: JsonValue): Record<string, unknown> {
  return structuredClone(payload) as Record<string, unknown>;
}

function nestedManifest(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.manifest as Record<string, unknown>;
}

function nestedFence(payload: Record<string, unknown>): Record<string, unknown> {
  return nestedManifest(payload).planningFence as Record<string, unknown>;
}

function appendRawManifestEvent(
  events: HarnessEventStore,
  eventId: string,
  eventType: string,
  occurredAtMs: number,
  payload: Record<string, unknown>,
): void {
  events.append({
    eventId,
    streamType: "task.node_operation_manifest",
    streamId: TASK_ID,
    eventType,
    eventVersion: 1,
    occurredAtMs,
    payload: payload as JsonValue,
  });
}

function uuid(suffix: number): string {
  return `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
}
