import {
  decodeRequestParams,
  decodeResponseResult,
  type HarnessRoutingAvailabilityStatus,
  type HarnessRoutingConfigurationResult,
  type HarnessRoutingConfigurationSetParams,
} from "@codex-harness/protocol";

import {
  ModelRoutingProfileError,
  ModelRoutingProfileRepository,
} from "../domain/model-routing-profile-repository.js";
import {
  normalizeModelRoutingConfiguration,
  type ModelRoutingConfiguration,
  type ModelTier,
  type ModelTierTarget,
} from "../domain/model-routing-config.js";
import type { ModelCatalogSnapshot } from "../domain/model-catalog.js";
import type { AppServerWorkerManager } from "./app-server-worker-manager.js";
import type { DaemonStateStore } from "./daemon-state-store.js";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "./desktop-default-routing-profile.js";

export type ModelRoutingConfigurationServiceErrorCode = "conflict" | "unavailable";

const ERROR_MESSAGES: Readonly<Record<ModelRoutingConfigurationServiceErrorCode, string>> =
  Object.freeze({
    conflict: "The routing configuration conflicts with current state.",
    unavailable: "The routing configuration service is unavailable.",
  });

export class ModelRoutingConfigurationServiceError extends Error {
  readonly code: ModelRoutingConfigurationServiceErrorCode;

  constructor(code: ModelRoutingConfigurationServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ModelRoutingConfigurationServiceError";
    this.code = code;
  }
}

type ServiceDependencies = Readonly<{ now(): number }>;

const PRODUCTION_DEPENDENCIES: ServiceDependencies = Object.freeze({
  now: () => Date.now(),
});

export class ModelRoutingConfigurationService {
  readonly #stateStore: DaemonStateStore;
  readonly #workerManager: AppServerWorkerManager;
  readonly #repository: ModelRoutingProfileRepository;
  readonly #dependencies: ServiceDependencies;

  constructor(
    stateStore: DaemonStateStore,
    workerManager: AppServerWorkerManager,
    dependencies: ServiceDependencies = PRODUCTION_DEPENDENCIES,
  ) {
    try {
      if (
        stateStore.state !== "ready" ||
        workerManager.state !== "ready" ||
        typeof dependencies?.now !== "function"
      ) {
        throw new ModelRoutingConfigurationServiceError("unavailable");
      }
      this.#stateStore = stateStore;
      this.#workerManager = workerManager;
      this.#repository = new ModelRoutingProfileRepository(stateStore.events);
      this.#dependencies = Object.freeze({ now: dependencies.now });
      this.#currentCatalog();
    } catch (error: unknown) {
      if (error instanceof ModelRoutingConfigurationServiceError) {
        throw error;
      }
      throw new ModelRoutingConfigurationServiceError("unavailable");
    }
  }

  read(): HarnessRoutingConfigurationResult {
    try {
      const catalog = this.#currentCatalog();
      try {
        const profile = this.#repository.readProfile(DESKTOP_DEFAULT_ROUTING_PROFILE_ID);
        return this.#configuredResult(profile.profileVersion, profile.activeConfiguration, catalog);
      } catch (error: unknown) {
        if (error instanceof ModelRoutingProfileError && error.code === "not_found") {
          return validateResult({
            schemaVersion: 1,
            configured: false,
            profileVersion: 0,
            configurationRevisionId: null,
            tiers: null,
            availability: null,
          });
        }
        throw error;
      }
    } catch (error: unknown) {
      if (error instanceof ModelRoutingConfigurationServiceError) {
        throw error;
      }
      throw new ModelRoutingConfigurationServiceError("unavailable");
    }
  }

  set(input: unknown): HarnessRoutingConfigurationResult {
    const decoded = decodeRequestParams("routing.configuration.set", input);
    if (!decoded.ok) {
      throw new ModelRoutingConfigurationServiceError("conflict");
    }
    const params = decoded.value as HarnessRoutingConfigurationSetParams;
    let configuration: ModelRoutingConfiguration;
    try {
      configuration = normalizeModelRoutingConfiguration({
        schemaVersion: 1,
        revisionId: params.commandId,
        revisionNumber: params.expectedProfileVersion + 1,
        tiers: params.tiers,
      });
    } catch {
      throw new ModelRoutingConfigurationServiceError("conflict");
    }

    try {
      const prior = this.#stateStore.events.readByEventId(params.commandId);
      if (prior === undefined) {
        const availability = assessAvailability(configuration, this.#currentCatalog());
        if (Object.values(availability).some((status) => status !== "observed_available")) {
          throw new ModelRoutingConfigurationServiceError("conflict");
        }
      }
      const occurredAtMs = prior?.occurredAtMs ?? requireTimestamp(this.#dependencies.now());
      this.#repository.setConfiguration({
        profileId: DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
        expectedProfileVersion: params.expectedProfileVersion,
        previousConfigurationRevisionId: params.previousConfigurationRevisionId,
        occurredAtMs,
        configuration,
        metadata: { actor: "desktop.routing_configuration" },
      });
      return this.read();
    } catch (error: unknown) {
      if (error instanceof ModelRoutingConfigurationServiceError) {
        throw error;
      }
      if (error instanceof ModelRoutingProfileError && error.code === "conflict") {
        throw new ModelRoutingConfigurationServiceError("conflict");
      }
      throw new ModelRoutingConfigurationServiceError("unavailable");
    }
  }

  #configuredResult(
    profileVersion: number,
    configuration: ModelRoutingConfiguration,
    catalog: ModelCatalogSnapshot,
  ): HarnessRoutingConfigurationResult {
    return validateResult({
      schemaVersion: 1,
      configured: true,
      profileVersion,
      configurationRevisionId: configuration.revisionId,
      tiers: configuration.tiers,
      availability: assessAvailability(configuration, catalog),
    });
  }

  #currentCatalog(): ModelCatalogSnapshot {
    const catalog = this.#workerManager.catalog;
    if (
      this.#stateStore.state !== "ready" ||
      this.#workerManager.state !== "ready" ||
      catalog === null ||
      !this.#workerManager.isCatalogCurrent(catalog)
    ) {
      throw new ModelRoutingConfigurationServiceError("unavailable");
    }
    return catalog;
  }
}

function assessAvailability(
  configuration: ModelRoutingConfiguration,
  catalog: ModelCatalogSnapshot,
): Readonly<Record<ModelTier, HarnessRoutingAvailabilityStatus>> {
  return Object.freeze({
    fast: assessTarget(configuration.tiers.fast, catalog),
    standard: assessTarget(configuration.tiers.standard, catalog),
    deep: assessTarget(configuration.tiers.deep, catalog),
  });
}

function assessTarget(
  target: ModelTierTarget,
  catalog: ModelCatalogSnapshot,
): HarnessRoutingAvailabilityStatus {
  if (target.provider !== catalog.provider) {
    return "provider_unobserved";
  }
  const model = catalog.models.find(
    (candidate) => !candidate.hidden && candidate.model === target.model,
  );
  if (model === undefined) {
    return "model_unavailable";
  }
  return model.supportedReasoningEfforts.includes(target.reasoningEffort)
    ? "observed_available"
    : "reasoning_effort_unsupported";
}

function requireTimestamp(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new ModelRoutingConfigurationServiceError("unavailable");
  }
  return input;
}

function validateResult(input: unknown): HarnessRoutingConfigurationResult {
  const decoded = decodeResponseResult("routing.configuration.get", input);
  if (!decoded.ok) {
    throw new ModelRoutingConfigurationServiceError("unavailable");
  }
  const result = decoded.value as HarnessRoutingConfigurationResult;
  return Object.freeze({
    ...result,
    ...(result.tiers === null
      ? {}
      : {
          tiers: Object.freeze({
            fast: Object.freeze(result.tiers.fast),
            standard: Object.freeze(result.tiers.standard),
            deep: Object.freeze(result.tiers.deep),
          }),
        }),
    ...(result.availability === null ? {} : { availability: Object.freeze(result.availability) }),
  });
}
