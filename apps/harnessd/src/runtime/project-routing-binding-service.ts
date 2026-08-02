import {
  decodeRequestParams,
  decodeResponseResult,
  type HarnessProjectRoutingBindingBindDefaultParams,
  type HarnessProjectRoutingBindingBindDefaultResult,
  type HarnessProjectRoutingBindingRecord,
  type HarnessProjectRoutingBindingStatus,
  type HarnessProjectRoutingBindingStatusBatchParams,
  type HarnessProjectRoutingBindingStatusBatchResult,
} from "@codex-harness/protocol";

import {
  ModelRoutingProfileError,
  ModelRoutingProfileRepository,
} from "../domain/model-routing-profile-repository.js";
import {
  ProjectRegistryError,
  ProjectRegistryRepository,
} from "../domain/project-registry-repository.js";
import {
  ProjectRoutingProfileBindingError,
  ProjectRoutingProfileBindingRepository,
  type ProjectRoutingProfileBindingRecord,
} from "../domain/project-routing-profile-binding-repository.js";
import type { DaemonStateStore } from "./daemon-state-store.js";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "./desktop-default-routing-profile.js";

export type ProjectRoutingBindingServiceErrorCode = "conflict" | "unavailable";

const ERROR_MESSAGES: Readonly<Record<ProjectRoutingBindingServiceErrorCode, string>> =
  Object.freeze({
    conflict: "The Project routing binding conflicts with current state.",
    unavailable: "The Project routing binding service is unavailable.",
  });

export class ProjectRoutingBindingServiceError extends Error {
  readonly code: ProjectRoutingBindingServiceErrorCode;

  constructor(code: ProjectRoutingBindingServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProjectRoutingBindingServiceError";
    this.code = code;
  }
}

type ServiceDependencies = Readonly<{ now(): number }>;

const PRODUCTION_DEPENDENCIES: ServiceDependencies = Object.freeze({
  now: () => Date.now(),
});

export class ProjectRoutingBindingService {
  readonly #stateStore: DaemonStateStore;
  readonly #projects: ProjectRegistryRepository;
  readonly #bindings: ProjectRoutingProfileBindingRepository;
  readonly #profiles: ModelRoutingProfileRepository;
  readonly #dependencies: ServiceDependencies;

  constructor(
    stateStore: DaemonStateStore,
    dependencies: ServiceDependencies = PRODUCTION_DEPENDENCIES,
  ) {
    try {
      if (stateStore.state !== "ready" || typeof dependencies?.now !== "function") {
        throw new ProjectRoutingBindingServiceError("unavailable");
      }
      this.#stateStore = stateStore;
      this.#projects = new ProjectRegistryRepository(stateStore.events);
      this.#bindings = new ProjectRoutingProfileBindingRepository(stateStore.events);
      this.#profiles = new ModelRoutingProfileRepository(stateStore.events);
      this.#dependencies = Object.freeze({ now: dependencies.now });
    } catch (error: unknown) {
      if (error instanceof ProjectRoutingBindingServiceError) {
        throw error;
      }
      throw new ProjectRoutingBindingServiceError("unavailable");
    }
  }

  readStatuses(input: unknown): HarnessProjectRoutingBindingStatusBatchResult {
    const decoded = decodeRequestParams("project.routing_binding.status_batch", input);
    if (!decoded.ok) {
      throw new ProjectRoutingBindingServiceError("conflict");
    }
    const params = decoded.value as unknown as HarnessProjectRoutingBindingStatusBatchParams;

    try {
      this.#assertAvailable();
      const statuses = params.projectIds.map((projectId) => {
        this.#projects.readProject(projectId);
        const binding = this.#readOptionalBinding(projectId);
        if (binding === undefined) {
          return Object.freeze({ projectId, status: "unbound" as const, binding: null });
        }
        return Object.freeze({
          projectId,
          status:
            binding.profileId === DESKTOP_DEFAULT_ROUTING_PROFILE_ID
              ? ("default_bound" as const)
              : ("other_profile_bound" as const),
          binding: publicBinding(binding),
        });
      });
      return validateStatusResult({ schemaVersion: 1, statuses }, params.projectIds);
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  bindDefault(input: unknown): HarnessProjectRoutingBindingBindDefaultResult {
    const decoded = decodeRequestParams("project.routing_binding.bind_default", input);
    if (!decoded.ok) {
      throw new ProjectRoutingBindingServiceError("conflict");
    }
    const params = decoded.value as unknown as HarnessProjectRoutingBindingBindDefaultParams;

    try {
      this.#assertAvailable();
      this.#projects.readProject(params.projectId);
      const prior = this.#stateStore.events.readByEventId(params.commandId);
      if (prior !== undefined) {
        const retried = this.#bindings.bindProfile({
          eventId: params.commandId,
          projectId: params.projectId,
          expectedBindingVersion: params.expectedBindingVersion,
          previousProfileId: params.previousProfileId,
          profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
          expectedProfileVersion: params.expectedProfileVersion,
          expectedConfigurationRevisionId: params.expectedConfigurationRevisionId,
          occurredAtMs: prior.occurredAtMs,
          metadata: { actor: "desktop.project_routing_binding" },
        });
        return validateBindResult({
          schemaVersion: 1,
          status: "bound",
          binding: publicBinding(retried.binding),
        });
      }

      const current = this.#readOptionalBinding(params.projectId);
      const profile = this.#profiles.readProfile(DESKTOP_DEFAULT_ROUTING_PROFILE_ID);
      if (
        profile.profileVersion !== params.expectedProfileVersion ||
        profile.activeConfiguration.revisionId !== params.expectedConfigurationRevisionId
      ) {
        throw new ProjectRoutingBindingServiceError("conflict");
      }

      if (current?.profileId === DESKTOP_DEFAULT_ROUTING_PROFILE_ID) {
        if (
          current.bindingVersion !== params.expectedBindingVersion ||
          current.profileId !== params.previousProfileId ||
          current.profileVersionAtBinding !== params.expectedProfileVersion ||
          current.configurationRevisionIdAtBinding !== params.expectedConfigurationRevisionId
        ) {
          throw new ProjectRoutingBindingServiceError("conflict");
        }
        return validateBindResult({
          schemaVersion: 1,
          status: "existing",
          binding: publicBinding(current),
        });
      }

      const bound = this.#bindings.bindProfile({
        eventId: params.commandId,
        projectId: params.projectId,
        expectedBindingVersion: params.expectedBindingVersion,
        previousProfileId: params.previousProfileId,
        profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
        expectedProfileVersion: params.expectedProfileVersion,
        expectedConfigurationRevisionId: params.expectedConfigurationRevisionId,
        occurredAtMs: requireTimestamp(this.#dependencies.now()),
        metadata: { actor: "desktop.project_routing_binding" },
      });
      return validateBindResult({
        schemaVersion: 1,
        status: "bound",
        binding: publicBinding(bound.binding),
      });
    } catch (error: unknown) {
      throw mapServiceError(error);
    }
  }

  #readOptionalBinding(projectId: string): ProjectRoutingProfileBindingRecord | undefined {
    try {
      return this.#bindings.readBinding(projectId);
    } catch (error: unknown) {
      if (error instanceof ProjectRoutingProfileBindingError && error.code === "not_found") {
        return undefined;
      }
      throw error;
    }
  }

  #assertAvailable(): void {
    if (this.#stateStore.state !== "ready") {
      throw new ProjectRoutingBindingServiceError("unavailable");
    }
  }
}

function publicBinding(
  binding: ProjectRoutingProfileBindingRecord,
): HarnessProjectRoutingBindingRecord {
  return Object.freeze({
    projectId: binding.projectId,
    bindingVersion: binding.bindingVersion,
    profileId: binding.profileId,
    profileVersionAtBinding: binding.profileVersionAtBinding,
    configurationRevisionIdAtBinding: binding.configurationRevisionIdAtBinding,
  });
}

function validateStatusResult(
  input: unknown,
  requestedProjectIds: readonly string[],
): HarnessProjectRoutingBindingStatusBatchResult {
  const decoded = decodeResponseResult("project.routing_binding.status_batch", input);
  if (!decoded.ok) {
    throw new ProjectRoutingBindingServiceError("unavailable");
  }
  const result = decoded.value as unknown as HarnessProjectRoutingBindingStatusBatchResult;
  if (
    result.statuses.length !== requestedProjectIds.length ||
    result.statuses.some((status, index) => status.projectId !== requestedProjectIds[index])
  ) {
    throw new ProjectRoutingBindingServiceError("unavailable");
  }
  return Object.freeze({
    ...result,
    statuses: Object.freeze(
      result.statuses.map((status): HarnessProjectRoutingBindingStatus =>
        status.binding === null
          ? Object.freeze({ ...status })
          : Object.freeze({ ...status, binding: Object.freeze(status.binding) }),
      ),
    ),
  });
}

function validateBindResult(input: unknown): HarnessProjectRoutingBindingBindDefaultResult {
  const decoded = decodeResponseResult("project.routing_binding.bind_default", input);
  if (!decoded.ok) {
    throw new ProjectRoutingBindingServiceError("unavailable");
  }
  const result = decoded.value as unknown as HarnessProjectRoutingBindingBindDefaultResult;
  return Object.freeze({ ...result, binding: Object.freeze(result.binding) });
}

function requireTimestamp(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new ProjectRoutingBindingServiceError("unavailable");
  }
  return input;
}

function mapServiceError(error: unknown): ProjectRoutingBindingServiceError {
  if (error instanceof ProjectRoutingBindingServiceError) {
    return error;
  }
  if (
    (error instanceof ProjectRegistryError ||
      error instanceof ModelRoutingProfileError ||
      error instanceof ProjectRoutingProfileBindingError) &&
    (error.code === "conflict" || error.code === "invalid_input" || error.code === "not_found")
  ) {
    return new ProjectRoutingBindingServiceError("conflict");
  }
  return new ProjectRoutingBindingServiceError("unavailable");
}
