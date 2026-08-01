import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessEventStore } from "../persistence/event-store.js";
import {
  PROJECT_REGISTRY_PROJECTION,
  PROJECT_WORKSPACE_OWNER_PROJECTION,
  ProjectRegistryRepository,
  type RegisterProjectInput,
} from "./project-registry-repository.js";

const PROJECT_1 = "00000000-0000-4000-8000-000000000801";
const PROJECT_2 = "00000000-0000-4000-8000-000000000802";
const PROJECT_3 = "00000000-0000-4000-8000-000000000803";
const EVENT_1 = "00000000-0000-4000-8000-000000000811";
const EVENT_2 = "00000000-0000-4000-8000-000000000812";
const EVENT_3 = "00000000-0000-4000-8000-000000000813";
const temporaryDirectories: string[] = [];
const stores: HarnessEventStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-project-registry-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

async function openRepository(path: string): Promise<{
  events: HarnessEventStore;
  projects: ProjectRegistryRepository;
}> {
  const events = await HarnessEventStore.open({
    path,
    now: () => 1_750_000_000_000,
    projections: [PROJECT_REGISTRY_PROJECTION, PROJECT_WORKSPACE_OWNER_PROJECTION],
  });
  stores.push(events);
  return { events, projects: new ProjectRegistryRepository(events) };
}

function registerCommand(
  eventId = EVENT_1,
  projectId = PROJECT_1,
  absolutePath = "/Users/muqian/code/project-one",
): RegisterProjectInput {
  return {
    eventId,
    projectId,
    displayName: `Project ${projectId.slice(-1)}`,
    workspace: { platform: "macos", absolutePath },
    occurredAtMs: 1_750_000_000_100,
    metadata: { actor: "user.project_registry", correlationId: "7" },
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("project registry repository", () => {
  it("registers a project with an explicitly unverified workspace identity", async () => {
    const { events, projects } = await openRepository(await databasePath());
    const result = projects.registerProject(registerCommand());

    expect(result).toMatchObject({
      duplicate: false,
      event: {
        eventId: EVENT_1,
        streamType: "project.registry",
        streamId: PROJECT_1,
        eventType: "project.registered",
      },
      project: {
        schemaVersion: 1,
        projectId: PROJECT_1,
        projectVersion: 1,
        displayName: "Project 1",
        workspace: {
          platform: "macos",
          absolutePath: "/Users/muqian/code/project-one",
          identityStatus: "unverified",
        },
        createdAtMs: 1_750_000_000_100,
        updatedAtMs: 1_750_000_000_100,
      },
    });
    expect(projects.readProject(PROJECT_1)).toEqual(result.project);
    expect(
      projects.readProjectByWorkspace({
        platform: "macos",
        absolutePath: "/Users/muqian/code/project-one",
      }),
    ).toEqual(result.project);
    expect(Object.isFrozen(result.project)).toBe(true);
    expect(Object.isFrozen(result.project.workspace)).toBe(true);
    expect(events.inspect()).toMatchObject({ eventCount: 1, projectionCount: 2 });
  });

  it("recovers and pages macOS, Windows, and Linux project records deterministically", async () => {
    const path = await databasePath();
    const first = await openRepository(path);
    first.projects.registerProject({
      ...registerCommand(EVENT_3, PROJECT_3, "/srv/project-three"),
      workspace: { platform: "linux", absolutePath: "/srv/project-three" },
    });
    first.projects.registerProject(registerCommand());
    first.projects.registerProject({
      ...registerCommand(EVENT_2, PROJECT_2),
      workspace: { platform: "windows", absolutePath: "C:\\Users\\Muqian\\project-two" },
    });
    first.events.close();

    const reopened = await openRepository(path);
    expect(reopened.projects.listProjects().map((project) => project.projectId)).toEqual([
      PROJECT_1,
      PROJECT_2,
      PROJECT_3,
    ]);
    expect(
      reopened.projects.listProjects(PROJECT_1, 1).map((project) => project.projectId),
    ).toEqual([PROJECT_2]);
    expect(
      reopened.projects.readProjectByWorkspace({
        platform: "windows",
        absolutePath: "C:\\Users\\Muqian\\project-two",
      }).projectId,
    ).toBe(PROJECT_2);
    expect(reopened.projects.readProject(PROJECT_3).workspace).toEqual({
      platform: "linux",
      absolutePath: "/srv/project-three",
      identityStatus: "unverified",
    });
  });

  it("accepts canonical Windows drive and UNC roots", async () => {
    const { projects } = await openRepository(await databasePath());
    projects.registerProject({
      ...registerCommand(EVENT_1, PROJECT_1),
      workspace: { platform: "windows", absolutePath: "C:\\" },
    });
    projects.registerProject({
      ...registerCommand(EVENT_2, PROJECT_2),
      workspace: { platform: "windows", absolutePath: "\\\\server\\share\\" },
    });

    expect(
      projects.readProjectByWorkspace({ platform: "windows", absolutePath: "C:\\" }).projectId,
    ).toBe(PROJECT_1);
    expect(
      projects.readProjectByWorkspace({
        platform: "windows",
        absolutePath: "\\\\server\\share\\",
      }).projectId,
    ).toBe(PROJECT_2);
  });

  it("keeps a complete historical command retry idempotent", async () => {
    const { events, projects } = await openRepository(await databasePath());
    const input = registerCommand();
    const first = projects.registerProject(input);
    projects.registerProject(registerCommand(EVENT_2, PROJECT_2, "/Users/muqian/code/project-two"));
    const duplicate = projects.registerProject(input);

    expect(duplicate).toEqual({ duplicate: true, event: first.event, project: first.project });
    expect(events.inspect()).toMatchObject({ eventCount: 2, lastSequence: 2 });
  });

  it("rejects conflicting event retries, project identifiers, and workspace descriptors", async () => {
    const { events, projects } = await openRepository(await databasePath());
    const input = registerCommand();
    projects.registerProject(input);
    const conflicts = [
      { ...input, projectId: PROJECT_2 },
      { ...input, displayName: "Changed" },
      { ...input, workspace: { ...input.workspace, absolutePath: "/tmp/changed" } },
      { ...input, occurredAtMs: input.occurredAtMs + 1 },
      { ...input, metadata: { actor: "system.changed" } },
      { ...registerCommand(EVENT_2, PROJECT_1), workspace: { ...input.workspace } },
      { ...registerCommand(EVENT_2, PROJECT_2), workspace: { ...input.workspace } },
    ];
    for (const conflict of conflicts) {
      expect(() => projects.registerProject(conflict)).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
    }
    expect(events.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1 });
  });

  it("enforces workspace uniqueness again inside projection replay", async () => {
    const { events, projects } = await openRepository(await databasePath());
    projects.registerProject(registerCommand());
    expect(() =>
      events.append({
        eventId: EVENT_2,
        streamType: "project.registry",
        streamId: PROJECT_2,
        eventType: "project.registered",
        eventVersion: 1,
        occurredAtMs: 1_750_000_000_101,
        payload: {
          project: {
            schemaVersion: 1,
            projectId: PROJECT_2,
            projectVersion: 1,
            displayName: "Project 2",
            workspace: {
              platform: "macos",
              absolutePath: "/Users/muqian/code/project-one",
              identityStatus: "unverified",
            },
            createdAtMs: 1_750_000_000_101,
            updatedAtMs: 1_750_000_000_101,
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "projection_failure" }));
    expect(events.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1 });
  });

  it.each([
    { platform: "macos", absolutePath: "relative/path" },
    { platform: "macos", absolutePath: "/Users/muqian/../other" },
    { platform: "linux", absolutePath: "/srv//project" },
    { platform: "linux", absolutePath: "/srv/project/" },
    { platform: "windows", absolutePath: "c:\\Users\\Muqian" },
    { platform: "windows", absolutePath: "C:/Users/Muqian" },
    { platform: "windows", absolutePath: "\\Users\\Muqian" },
    { platform: "windows", absolutePath: "\\\\?\\C:\\Users\\Muqian" },
    { platform: "windows", absolutePath: "C:\\Users\\..\\Other" },
    { platform: "windows", absolutePath: "C:\\Users\\Muqian\\" },
  ])("rejects non-canonical workspace input %#", async (workspace) => {
    const { projects } = await openRepository(await databasePath());
    expect(() =>
      projects.registerProject({ ...registerCommand(), workspace } as RegisterProjectInput),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects malformed values, accessors, unknown keys, and invalid queries", async () => {
    const { projects } = await openRepository(await databasePath());
    const accessor = { ...registerCommand() } as Record<string, unknown>;
    Object.defineProperty(accessor, "workspace", {
      enumerable: true,
      get: () => ({ platform: "macos", absolutePath: "/tmp/project" }),
    });
    const invalid = [
      null,
      { ...registerCommand(), displayName: " Project" },
      { ...registerCommand(), displayName: "bad\nname" },
      { ...registerCommand(), extra: true },
      accessor,
      { ...registerCommand(), metadata: { actor: "invalid actor" } },
    ];
    for (const input of invalid) {
      expect(() => projects.registerProject(input as RegisterProjectInput)).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
    expect(() => projects.readProject("not-a-uuid")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => projects.readProject(PROJECT_1)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => projects.listProjects("", 0)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("fails closed when projections are missing or the external owner closes", async () => {
    const path = await databasePath();
    const missing = await HarnessEventStore.open({
      path,
      projections: [PROJECT_REGISTRY_PROJECTION],
    });
    stores.push(missing);
    expect(() => new ProjectRegistryRepository(missing)).toThrowError(
      expect.objectContaining({ code: "storage_failure" }),
    );
    missing.close();
    expect(() => new ProjectRegistryRepository(missing)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );

    const complete = await openRepository(await databasePath());
    complete.events.close();
    expect(() => complete.projects.readProject(PROJECT_1)).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });
});
