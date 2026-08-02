import {
  decodeRequestParams,
  decodeResponseResult,
  type HarnessProjectCatalogPageParams,
  type HarnessProjectCatalogPageResult,
  type HarnessProjectPlatform,
  type HarnessProjectRegisterParams,
  type HarnessProjectRegisterResult,
  type HarnessProjectSummary,
} from "@codex-harness/protocol";

import {
  ProjectRegistryError,
  ProjectRegistryRepository,
  type ProjectRecord,
} from "../domain/project-registry-repository.js";
import type { DaemonStateStore } from "./daemon-state-store.js";

export type ProjectRegistryServiceErrorCode = "conflict" | "unavailable";

const ERROR_MESSAGES: Readonly<Record<ProjectRegistryServiceErrorCode, string>> = Object.freeze({
  conflict: "The Project registry command conflicts with current state.",
  unavailable: "The Project registry service is unavailable.",
});

export class ProjectRegistryServiceError extends Error {
  readonly code: ProjectRegistryServiceErrorCode;

  constructor(code: ProjectRegistryServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProjectRegistryServiceError";
    this.code = code;
  }
}

type ServiceDependencies = Readonly<{
  now(): number;
  hostPlatform: HarnessProjectPlatform;
}>;

const PRODUCTION_DEPENDENCIES: ServiceDependencies = Object.freeze({
  now: () => Date.now(),
  hostPlatform: currentProjectPlatform(),
});

export class ProjectRegistryService {
  readonly #stateStore: DaemonStateStore;
  readonly #repository: ProjectRegistryRepository;
  readonly #dependencies: ServiceDependencies;

  constructor(
    stateStore: DaemonStateStore,
    dependencies: ServiceDependencies = PRODUCTION_DEPENDENCIES,
  ) {
    try {
      if (
        stateStore.state !== "ready" ||
        typeof dependencies?.now !== "function" ||
        !isProjectPlatform(dependencies.hostPlatform)
      ) {
        throw new ProjectRegistryServiceError("unavailable");
      }
      this.#stateStore = stateStore;
      this.#repository = new ProjectRegistryRepository(stateStore.events);
      this.#dependencies = Object.freeze({
        now: dependencies.now,
        hostPlatform: dependencies.hostPlatform,
      });
    } catch (error: unknown) {
      if (error instanceof ProjectRegistryServiceError) {
        throw error;
      }
      throw new ProjectRegistryServiceError("unavailable");
    }
  }

  list(input: unknown): HarnessProjectCatalogPageResult {
    const decoded = decodeRequestParams("project.catalog_page", input);
    if (!decoded.ok) {
      throw new ProjectRegistryServiceError("conflict");
    }
    const params = decoded.value as HarnessProjectCatalogPageParams;
    try {
      this.#assertAvailable();
      const records = this.#repository.listProjects(params.cursor ?? "", params.limit + 1);
      const hasMore = records.length > params.limit;
      const projects = records.slice(0, params.limit).map(projectSummary);
      return validateCatalogResult({
        schemaVersion: 1,
        projects,
        nextCursor: hasMore ? (projects.at(-1)?.projectId ?? null) : null,
      });
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  register(input: unknown): HarnessProjectRegisterResult {
    const decoded = decodeRequestParams("project.register", input);
    if (!decoded.ok) {
      throw new ProjectRegistryServiceError("conflict");
    }
    const params = decoded.value as HarnessProjectRegisterParams;
    if (params.workspace.platform !== this.#dependencies.hostPlatform) {
      throw new ProjectRegistryServiceError("conflict");
    }

    try {
      this.#assertAvailable();
      const prior = this.#stateStore.events.readByEventId(params.commandId);
      if (prior !== undefined) {
        const retried = this.#repository.registerProject({
          eventId: params.commandId,
          projectId: params.projectId,
          displayName: params.displayName,
          workspace: params.workspace,
          occurredAtMs: prior.occurredAtMs,
          metadata: { actor: "desktop.project_registry" },
        });
        return validateRegisterResult({
          schemaVersion: 1,
          status: "registered",
          project: projectSummary(retried.project),
        });
      }

      try {
        const existing = this.#repository.readProjectByWorkspace(params.workspace);
        return validateRegisterResult({
          schemaVersion: 1,
          status: "existing",
          project: projectSummary(existing),
        });
      } catch (error: unknown) {
        if (!(error instanceof ProjectRegistryError) || error.code !== "not_found") {
          throw error;
        }
      }

      const created = this.#repository.registerProject({
        eventId: params.commandId,
        projectId: params.projectId,
        displayName: params.displayName,
        workspace: params.workspace,
        occurredAtMs: requireTimestamp(this.#dependencies.now()),
        metadata: { actor: "desktop.project_registry" },
      });
      return validateRegisterResult({
        schemaVersion: 1,
        status: "registered",
        project: projectSummary(created.project),
      });
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  #assertAvailable(): void {
    if (this.#stateStore.state !== "ready") {
      throw new ProjectRegistryServiceError("unavailable");
    }
  }
}

function projectSummary(project: ProjectRecord): HarnessProjectSummary {
  return Object.freeze({
    projectId: project.projectId,
    projectVersion: 1,
    displayName: project.displayName,
    workspace: Object.freeze({
      platform: project.workspace.platform,
      absolutePath: project.workspace.absolutePath,
      identityStatus: "unverified",
    }),
  });
}

function validateCatalogResult(input: unknown): HarnessProjectCatalogPageResult {
  const decoded = decodeResponseResult("project.catalog_page", input);
  if (!decoded.ok) {
    throw new ProjectRegistryServiceError("unavailable");
  }
  const result = decoded.value as unknown as HarnessProjectCatalogPageResult;
  return Object.freeze({
    ...result,
    projects: Object.freeze(
      result.projects.map((project) =>
        Object.freeze({ ...project, workspace: Object.freeze(project.workspace) }),
      ),
    ),
  });
}

function validateRegisterResult(input: unknown): HarnessProjectRegisterResult {
  const decoded = decodeResponseResult("project.register", input);
  if (!decoded.ok) {
    throw new ProjectRegistryServiceError("unavailable");
  }
  const result = decoded.value as unknown as HarnessProjectRegisterResult;
  return Object.freeze({
    ...result,
    project: Object.freeze({
      ...result.project,
      workspace: Object.freeze(result.project.workspace),
    }),
  });
}

function requireTimestamp(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new ProjectRegistryServiceError("unavailable");
  }
  return input;
}

function mapServiceError(error: unknown): ProjectRegistryServiceError {
  if (error instanceof ProjectRegistryServiceError) {
    return error;
  }
  if (
    error instanceof ProjectRegistryError &&
    (error.code === "conflict" || error.code === "invalid_input")
  ) {
    return new ProjectRegistryServiceError("conflict");
  }
  return new ProjectRegistryServiceError("unavailable");
}

function isProjectPlatform(input: unknown): input is HarnessProjectPlatform {
  return input === "macos" || input === "windows" || input === "linux";
}

function currentProjectPlatform(): HarnessProjectPlatform {
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "win32") {
    return "windows";
  }
  return "linux";
}
