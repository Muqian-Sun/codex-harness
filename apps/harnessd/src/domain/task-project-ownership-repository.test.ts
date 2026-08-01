import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore } from "../persistence/event-store.js";
import {
  PROJECT_REGISTRY_PROJECTION,
  PROJECT_WORKSPACE_OWNER_PROJECTION,
  ProjectRegistryRepository,
} from "./project-registry-repository.js";
import { TASK_PLAN_PROJECTION, TaskPlanRepository } from "./task-plan-store.js";
import {
  PROJECT_TASK_INDEX_PROJECTION,
  TASK_PROJECT_OWNERSHIP_PROJECTION,
  TaskProjectOwnershipRepository,
  type AssignTaskToProjectInput,
} from "./task-project-ownership-repository.js";

const TASK_1 = "00000000-0000-4000-8000-000000000901";
const TASK_2 = "00000000-0000-4000-8000-000000000902";
const TASK_3 = "00000000-0000-4000-8000-000000000903";
const REQUIREMENT_1 = "00000000-0000-4000-8000-000000000911";
const REQUIREMENT_1_UPDATED = "00000000-0000-4000-8000-000000000912";
const REQUIREMENT_2 = "00000000-0000-4000-8000-000000000913";
const REQUIREMENT_3 = "00000000-0000-4000-8000-000000000914";
const PROJECT_1 = "00000000-0000-4000-8000-000000000921";
const PROJECT_2 = "00000000-0000-4000-8000-000000000922";
const PROJECT_EVENT_1 = "00000000-0000-4000-8000-000000000931";
const PROJECT_EVENT_2 = "00000000-0000-4000-8000-000000000932";
const OWNERSHIP_EVENT_1 = "00000000-0000-4000-8000-000000000941";
const OWNERSHIP_EVENT_2 = "00000000-0000-4000-8000-000000000942";
const OWNERSHIP_EVENT_3 = "00000000-0000-4000-8000-000000000943";
const temporaryDirectories: string[] = [];
const stores: HarnessEventStore[] = [];

const ALL_PROJECTIONS = [
  TASK_PLAN_PROJECTION,
  PROJECT_REGISTRY_PROJECTION,
  PROJECT_WORKSPACE_OWNER_PROJECTION,
  TASK_PROJECT_OWNERSHIP_PROJECTION,
  PROJECT_TASK_INDEX_PROJECTION,
];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-task-project-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openRepositories(path: string) {
  const events = await HarnessEventStore.open({
    path,
    now: () => 1_750_000_000_000,
    projections: ALL_PROJECTIONS,
  });
  stores.push(events);
  return {
    events,
    tasks: new TaskPlanRepository(events),
    projects: new ProjectRegistryRepository(events),
    ownerships: new TaskProjectOwnershipRepository(events),
  };
}

function createTask(
  tasks: TaskPlanRepository,
  taskId = TASK_1,
  requirementId = REQUIREMENT_1,
  occurredAtMs = 100,
): void {
  tasks.createTask({
    eventId: requirementId,
    taskId,
    title: `Task ${taskId.slice(-1)}`,
    occurredAtMs,
    requirement: {
      revisionId: requirementId,
      sourceText: "Associate this task with one project.",
      objective: "Resolve project policy from authoritative ownership.",
      constraints: [],
      acceptanceCriteria: ["Ownership is recoverable."],
    },
  });
}

function reviseTask(tasks: TaskPlanRepository): void {
  tasks.reviseRequirements({
    eventId: REQUIREMENT_1_UPDATED,
    taskId: TASK_1,
    expectedTaskVersion: 1,
    previousRequirementRevisionId: REQUIREMENT_1,
    occurredAtMs: 130,
    requirement: {
      revisionId: REQUIREMENT_1_UPDATED,
      sourceText: "Associate the revised task with one project.",
      objective: "Keep ownership stable after task revisions.",
      constraints: [],
      acceptanceCriteria: ["Historical retries remain idempotent."],
    },
  });
}

function registerProject(
  projects: ProjectRegistryRepository,
  projectId = PROJECT_1,
  eventId = PROJECT_EVENT_1,
  occurredAtMs = 101,
): void {
  projects.registerProject({
    eventId,
    projectId,
    displayName: `Project ${projectId.slice(-1)}`,
    workspace: { platform: "macos", absolutePath: `/tmp/${projectId}` },
    occurredAtMs,
  });
}

function assignCommand(
  eventId = OWNERSHIP_EVENT_1,
  taskId = TASK_1,
  projectId = PROJECT_1,
): AssignTaskToProjectInput {
  return {
    eventId,
    taskId,
    expectedTaskVersion: 1,
    expectedOwnershipVersion: 0,
    previousProjectId: null,
    projectId,
    expectedProjectVersion: 1,
    occurredAtMs: 110,
    metadata: { actor: "system.task_project" },
  };
}

function reassignCommand(): AssignTaskToProjectInput {
  return {
    eventId: OWNERSHIP_EVENT_2,
    taskId: TASK_1,
    expectedTaskVersion: 2,
    expectedOwnershipVersion: 1,
    previousProjectId: PROJECT_1,
    projectId: PROJECT_2,
    expectedProjectVersion: 1,
    occurredAtMs: 140,
    metadata: { actor: "user.task_project" },
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("task project ownership repository", () => {
  it("assigns an existing task to a registered project with freshness snapshots", async () => {
    const { events, tasks, projects, ownerships } = await openRepositories(await databasePath());
    createTask(tasks);
    registerProject(projects);
    const result = ownerships.assignTask(assignCommand());

    expect(result).toMatchObject({
      duplicate: false,
      event: {
        eventId: OWNERSHIP_EVENT_1,
        streamType: "task.project_ownership",
        streamId: TASK_1,
        eventType: "task.project_assigned",
      },
      ownership: {
        schemaVersion: 1,
        taskId: TASK_1,
        ownershipVersion: 1,
        projectId: PROJECT_1,
        taskVersionAtAssignment: 1,
        projectVersionAtAssignment: 1,
        createdAtMs: 110,
        updatedAtMs: 110,
      },
    });
    expect(ownerships.readOwnership(TASK_1)).toEqual(result.ownership);
    expect(ownerships.listTasksForProject(PROJECT_1)).toEqual([result.ownership]);
    expect(Object.isFrozen(result.ownership)).toBe(true);
    expect(events.inspect()).toMatchObject({ eventCount: 3, projectionCount: 5 });
  });

  it("reassigns a revised task and atomically moves the reverse index", async () => {
    const path = await databasePath();
    const first = await openRepositories(path);
    createTask(first.tasks);
    registerProject(first.projects);
    registerProject(first.projects, PROJECT_2, PROJECT_EVENT_2, 102);
    first.ownerships.assignTask(assignCommand());
    reviseTask(first.tasks);
    const reassigned = first.ownerships.assignTask(reassignCommand());

    expect(first.ownerships.listTasksForProject(PROJECT_1)).toEqual([]);
    expect(first.ownerships.listTasksForProject(PROJECT_2)).toEqual([reassigned.ownership]);
    expect(reassigned.ownership).toMatchObject({
      ownershipVersion: 2,
      projectId: PROJECT_2,
      taskVersionAtAssignment: 2,
      createdAtMs: 110,
      updatedAtMs: 140,
    });
    first.events.close();

    const reopened = await openRepositories(path);
    expect(reopened.ownerships.readOwnership(TASK_1)).toEqual(reassigned.ownership);
    expect(reopened.ownerships.listTasksForProject(PROJECT_1)).toEqual([]);
    expect(reopened.ownerships.listTasksForProject(PROJECT_2)).toEqual([reassigned.ownership]);
  });

  it("keeps the original assignment retry idempotent after task revision and reassignment", async () => {
    const { events, tasks, projects, ownerships } = await openRepositories(await databasePath());
    createTask(tasks);
    registerProject(projects);
    registerProject(projects, PROJECT_2, PROJECT_EVENT_2, 102);
    const input = assignCommand();
    const first = ownerships.assignTask(input);
    reviseTask(tasks);
    ownerships.assignTask(reassignCommand());
    const duplicate = ownerships.assignTask(input);

    expect(duplicate).toEqual({ duplicate: true, event: first.event, ownership: first.ownership });
    expect(ownerships.readOwnership(TASK_1).projectId).toBe(PROJECT_2);
    expect(events.inspect()).toMatchObject({ eventCount: 6, lastSequence: 6 });
  });

  it("rejects conflicting historical retries including metadata changes", async () => {
    const { events, tasks, projects, ownerships } = await openRepositories(await databasePath());
    createTask(tasks);
    registerProject(projects);
    const input = assignCommand();
    ownerships.assignTask(input);
    const conflicts = [
      { ...input, taskId: TASK_2 },
      { ...input, expectedTaskVersion: 2 },
      { ...input, expectedOwnershipVersion: 1, previousProjectId: PROJECT_1 },
      { ...input, projectId: PROJECT_2 },
      { ...input, expectedProjectVersion: 2 },
      { ...input, occurredAtMs: 111 },
      { ...input, metadata: { actor: "system.changed" } },
    ];
    for (const conflict of conflicts) {
      expect(() => ownerships.assignTask(conflict)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
    expect(events.inspect()).toMatchObject({ eventCount: 3, lastSequence: 3 });
  });

  it("rejects missing entities, stale fences, no-op reassignment, and time rollback", async () => {
    const { tasks, projects, ownerships } = await openRepositories(await databasePath());
    expect(() => ownerships.assignTask(assignCommand())).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    createTask(tasks);
    expect(() => ownerships.assignTask(assignCommand())).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
    registerProject(projects);
    registerProject(projects, PROJECT_2, PROJECT_EVENT_2, 102);
    ownerships.assignTask(assignCommand());
    reviseTask(tasks);

    const invalid = [
      { ...reassignCommand(), expectedTaskVersion: 1 },
      { ...reassignCommand(), expectedOwnershipVersion: 0, previousProjectId: null },
      { ...reassignCommand(), previousProjectId: PROJECT_2 },
      { ...reassignCommand(), projectId: PROJECT_1 },
      { ...reassignCommand(), expectedProjectVersion: 2 },
      { ...reassignCommand(), occurredAtMs: 109 },
    ];
    for (const command of invalid) {
      expect(() => ownerships.assignTask(command)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
  });

  it("rolls back a stale ownership event at the projection boundary", async () => {
    const { events, tasks, projects, ownerships } = await openRepositories(await databasePath());
    createTask(tasks);
    registerProject(projects);
    registerProject(projects, PROJECT_2, PROJECT_EVENT_2, 102);
    const original = ownerships.assignTask(assignCommand()).ownership;

    expect(() =>
      events.append({
        eventId: OWNERSHIP_EVENT_2,
        streamType: "task.project_ownership",
        streamId: TASK_1,
        eventType: "task.project_assigned",
        eventVersion: 1,
        occurredAtMs: 120,
        payload: {
          expectedOwnershipVersion: 0,
          previousProjectId: null,
          ownership: {
            schemaVersion: 1,
            taskId: TASK_1,
            ownershipVersion: 1,
            projectId: PROJECT_2,
            taskVersionAtAssignment: 1,
            projectVersionAtAssignment: 1,
            createdAtMs: 120,
            updatedAtMs: 120,
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "projection_failure" }));
    expect(ownerships.readOwnership(TASK_1)).toEqual(original);
    expect(ownerships.listTasksForProject(PROJECT_1)).toEqual([original]);
    expect(ownerships.listTasksForProject(PROJECT_2)).toEqual([]);
    expect(events.inspect()).toMatchObject({ eventCount: 4, lastSequence: 4 });
  });

  it("lists current ownerships and project tasks with stable pagination", async () => {
    const { tasks, projects, ownerships } = await openRepositories(await databasePath());
    registerProject(projects);
    createTask(tasks, TASK_3, REQUIREMENT_3, 100);
    createTask(tasks, TASK_1, REQUIREMENT_1, 100);
    createTask(tasks, TASK_2, REQUIREMENT_2, 100);
    ownerships.assignTask(assignCommand(OWNERSHIP_EVENT_3, TASK_3));
    ownerships.assignTask(assignCommand(OWNERSHIP_EVENT_1, TASK_1));
    ownerships.assignTask(assignCommand(OWNERSHIP_EVENT_2, TASK_2));

    expect(ownerships.listOwnerships().map((item) => item.taskId)).toEqual([
      TASK_1,
      TASK_2,
      TASK_3,
    ]);
    expect(ownerships.listTasksForProject(PROJECT_1, TASK_1, 1).map((item) => item.taskId)).toEqual(
      [TASK_2],
    );
  });

  it("rejects malformed commands and invalid queries", async () => {
    const { ownerships } = await openRepositories(await databasePath());
    const input = assignCommand();
    const invalid = [
      null,
      { ...input, expectedOwnershipVersion: 0, previousProjectId: PROJECT_1 },
      { ...input, eventId: "invalid" },
      { ...input, expectedTaskVersion: 0 },
      { ...input, extra: true },
      { ...input, metadata: { actor: "invalid actor" } },
    ];
    for (const command of invalid) {
      expect(() => ownerships.assignTask(command as AssignTaskToProjectInput)).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    expect(() => ownerships.readOwnership("invalid")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => ownerships.readOwnership(TASK_1)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => ownerships.listOwnerships("", 0)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => ownerships.listTasksForProject("invalid")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("fails closed when a dependency projection is missing or the owner closes", async () => {
    const missing = await HarnessEventStore.open({
      path: await databasePath(),
      projections: [
        TASK_PLAN_PROJECTION,
        PROJECT_REGISTRY_PROJECTION,
        PROJECT_WORKSPACE_OWNER_PROJECTION,
        TASK_PROJECT_OWNERSHIP_PROJECTION,
      ],
    });
    stores.push(missing);
    expect(() => new TaskProjectOwnershipRepository(missing)).toThrowError(
      expect.objectContaining({ code: "storage_failure" }),
    );

    const complete = await openRepositories(await databasePath());
    complete.events.close();
    expect(() => complete.ownerships.readOwnership(TASK_1)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });
});
