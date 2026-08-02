import { basename, isAbsolute } from "node:path";

import {
  MODEL_ROUTING_PROFILE_PROJECTION,
  ModelRoutingProfileRepository,
} from "../domain/model-routing-profile-repository.js";
import {
  PROJECT_REGISTRY_PROJECTION,
  PROJECT_WORKSPACE_OWNER_PROJECTION,
  ProjectRegistryRepository,
} from "../domain/project-registry-repository.js";
import {
  PROJECT_ROUTING_PROFILE_BINDING_PROJECTION,
  ProjectRoutingProfileBindingRepository,
} from "../domain/project-routing-profile-binding-repository.js";
import {
  SHADOW_ROUTE_DECISION_PROJECTION,
  ShadowRouteDecisionRepository,
} from "../domain/shadow-route-decision-repository.js";
import {
  PROJECT_TASK_INDEX_PROJECTION,
  TASK_PROJECT_OWNERSHIP_PROJECTION,
  TaskProjectOwnershipRepository,
} from "../domain/task-project-ownership-repository.js";
import { TASK_PLAN_PROJECTION, TaskPlanRepository } from "../domain/task-plan-store.js";
import {
  HarnessEventStore,
  type EventStoreInspection,
  type ProjectionDefinition,
} from "../persistence/event-store.js";

const DATABASE_FILENAME = "harness.db";

const DAEMON_PROJECTIONS: readonly ProjectionDefinition[] = Object.freeze([
  TASK_PLAN_PROJECTION,
  MODEL_ROUTING_PROFILE_PROJECTION,
  PROJECT_ROUTING_PROFILE_BINDING_PROJECTION,
  PROJECT_REGISTRY_PROJECTION,
  PROJECT_WORKSPACE_OWNER_PROJECTION,
  TASK_PROJECT_OWNERSHIP_PROJECTION,
  PROJECT_TASK_INDEX_PROJECTION,
  SHADOW_ROUTE_DECISION_PROJECTION,
]);

export type DaemonStateStoreState = "ready" | "closed";
export type DaemonStateStoreErrorCode =
  "closed" | "invalid_configuration" | "state_shutdown_failed" | "state_start_failed";

const ERROR_MESSAGES: Readonly<Record<DaemonStateStoreErrorCode, string>> = Object.freeze({
  closed: "The daemon state store is closed.",
  invalid_configuration: "The daemon state store configuration is invalid.",
  state_shutdown_failed: "The daemon state store failed to close.",
  state_start_failed: "The daemon state store failed to start.",
});

export class DaemonStateStoreError extends Error {
  readonly code: DaemonStateStoreErrorCode;

  constructor(code: DaemonStateStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "DaemonStateStoreError";
    this.code = code;
  }
}

export class DaemonStateStore {
  readonly #events: HarnessEventStore;
  #state: DaemonStateStoreState = "ready";

  private constructor(events: HarnessEventStore) {
    this.#events = events;
  }

  static async open(config: Readonly<{ databasePath: string }>): Promise<DaemonStateStore> {
    let databasePath: string;
    try {
      databasePath = config.databasePath;
    } catch {
      throw new DaemonStateStoreError("invalid_configuration");
    }
    if (
      typeof databasePath !== "string" ||
      !isAbsolute(databasePath) ||
      databasePath.includes("\0") ||
      basename(databasePath) !== DATABASE_FILENAME
    ) {
      throw new DaemonStateStoreError("invalid_configuration");
    }
    try {
      const events = await HarnessEventStore.open({
        path: databasePath,
        projections: DAEMON_PROJECTIONS,
      });
      const store = new DaemonStateStore(events);
      store.#verifyRepositories();
      return store;
    } catch (error: unknown) {
      if (error instanceof DaemonStateStoreError && error.code === "invalid_configuration") {
        throw error;
      }
      throw new DaemonStateStoreError("state_start_failed");
    }
  }

  get state(): DaemonStateStoreState {
    return this.#state;
  }

  get events(): HarnessEventStore {
    if (this.#state !== "ready") {
      throw new DaemonStateStoreError("closed");
    }
    return this.#events;
  }

  inspect(): EventStoreInspection {
    try {
      return this.events.inspect();
    } catch (error: unknown) {
      if (error instanceof DaemonStateStoreError) {
        throw error;
      }
      throw new DaemonStateStoreError("state_start_failed");
    }
  }

  close(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    try {
      this.#events.close();
    } catch {
      throw new DaemonStateStoreError("state_shutdown_failed");
    }
  }

  #verifyRepositories(): void {
    try {
      new TaskPlanRepository(this.#events);
      new ModelRoutingProfileRepository(this.#events);
      new ProjectRoutingProfileBindingRepository(this.#events);
      new ProjectRegistryRepository(this.#events);
      new TaskProjectOwnershipRepository(this.#events);
      new ShadowRouteDecisionRepository(this.#events);
      this.#events.inspect();
    } catch {
      try {
        this.#events.close();
      } catch {
        // The fixed startup error remains authoritative.
      }
      throw new DaemonStateStoreError("state_start_failed");
    }
  }
}
