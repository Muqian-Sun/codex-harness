import { describe, expect, it, vi } from "vitest";

import {
  BootstrapStateStore,
  BootstrapStateTransitionError,
  advanceDesktopBootstrapState,
  decodeDesktopBootstrapState,
  decodeDesktopProjectSelectionResult,
  decodeDesktopProjectRoutingBindingMutationResult,
  decodeDesktopProjectRoutingBindingProjectId,
  decodeDesktopProjectWorkspaceRegistration,
  decodeDesktopRoutingConfigurationMutationResult,
  decodeDesktopRoutingConfigurationUpdate,
  failedBootstrapState,
  projectDesktopModelCatalogSummary,
  projectDesktopProjectCatalog,
  projectDesktopProjectRegistration,
  projectDesktopProjectRoutingBindings,
  projectDesktopRoutingConfiguration,
  readyBootstrapState,
} from "./bootstrap-state.js";

const CATALOG = Object.freeze({
  provider: "openai",
  totalVisibleModels: 2,
  models: Object.freeze([
    Object.freeze({
      model: "gpt-standard",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high"]),
      inputModalities: Object.freeze(["text", "image"] as const),
    }),
    Object.freeze({
      model: "gpt-fast",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: Object.freeze(["low"]),
      inputModalities: Object.freeze(["text"] as const),
    }),
  ]),
  hasMore: false,
});

const ROUTING = Object.freeze({
  configured: true,
  profileVersion: 1,
  configurationRevisionId: "00000000-0000-4000-8000-000000000861",
  tiers: Object.freeze({
    fast: Object.freeze({ provider: "openai", model: "gpt-fast", reasoningEffort: "low" }),
    standard: Object.freeze({
      provider: "openai",
      model: "gpt-standard",
      reasoningEffort: "medium",
    }),
    deep: Object.freeze({ provider: "openai", model: "gpt-standard", reasoningEffort: "high" }),
  }),
  availability: Object.freeze({
    fast: "observed_available" as const,
    standard: "observed_available" as const,
    deep: "observed_available" as const,
  }),
});

const PROJECT = Object.freeze({
  projectId: "00000000-0000-4000-8000-000000000871",
  projectVersion: 1 as const,
  displayName: "workspace",
  workspace: Object.freeze({
    platform: "macos" as const,
    absolutePath: "/Users/example/workspace",
    identityStatus: "unverified" as const,
  }),
});

const PROJECTS = Object.freeze({
  projects: Object.freeze([PROJECT]),
  hasMore: false,
});

const RAW_PROJECT_ROUTING_BINDINGS = Object.freeze({
  schemaVersion: 1,
  statuses: Object.freeze([
    Object.freeze({ projectId: PROJECT.projectId, status: "unbound" as const, binding: null }),
  ]),
});

const PROJECT_ROUTING_BINDINGS = Object.freeze({
  bindings: Object.freeze([
    Object.freeze({
      projectId: PROJECT.projectId,
      status: "unbound" as const,
      bindingVersion: null,
    }),
  ]),
});

const READY = Object.freeze({
  phase: "ready" as const,
  account: Object.freeze({
    status: "authenticated" as const,
    credentialKind: "chatgpt" as const,
    planType: "plus" as const,
  }),
  catalog: CATALOG,
  routing: ROUTING,
  projects: PROJECTS,
  projectRoutingBindings: PROJECT_ROUTING_BINDINGS,
});

describe("desktop bootstrap state", () => {
  it("strictly decodes and freezes the renderer boundary value", () => {
    const ready = decodeDesktopBootstrapState(READY);
    const failed = decodeDesktopBootstrapState({ phase: "failed", code: "resource_invalid" });

    expect(ready).toEqual(READY);
    expect(failed).toEqual({ phase: "failed", code: "resource_invalid" });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.account : undefined)).toBe(true);
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.catalog : undefined)).toBe(true);
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.catalog.models : undefined)).toBe(true);
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.catalog.models[0] : undefined)).toBe(
      true,
    );
    expect(Object.isFrozen(ready?.phase === "ready" ? ready.routing.tiers?.fast : undefined)).toBe(
      true,
    );
    expect(Object.isFrozen(failed)).toBe(true);
    expect(
      decodeDesktopBootstrapState({
        ...READY,
        endpoint: "/private/secret",
      }),
    ).toBe(undefined);
    expect(
      decodeDesktopBootstrapState({
        phase: "ready",
        account: { ...READY.account, email: "private@example.com" },
        catalog: READY.catalog,
        routing: READY.routing,
        projects: READY.projects,
        projectRoutingBindings: READY.projectRoutingBindings,
      }),
    ).toBe(undefined);
    expect(
      decodeDesktopBootstrapState({
        phase: "ready",
        account: READY.account,
        catalog: { ...READY.catalog, nextCursor: "private-cursor" },
        routing: READY.routing,
        projects: READY.projects,
        projectRoutingBindings: READY.projectRoutingBindings,
      }),
    ).toBe(undefined);
    expect(decodeDesktopBootstrapState({ phase: "failed", code: "raw_error" })).toBe(undefined);
  });

  it("projects full RPC observations to the minimal renderer boundary", () => {
    const account = {
      schemaVersion: 1,
      snapshotId: "00000000-0000-4000-8000-000000000851",
      workerSessionId: "00000000-0000-4000-8000-000000000852",
      observedAtMs: 1,
      ...READY.account,
      futureSafeField: true,
    };
    const catalog = projectDesktopModelCatalogSummary({
      schemaVersion: 1,
      provider: CATALOG.provider,
      totalVisibleModels: CATALOG.totalVisibleModels,
      models: CATALOG.models,
      nextCursor: null,
    });
    const routing = projectDesktopRoutingConfiguration({ schemaVersion: 1, ...ROUTING });
    const projects = projectDesktopProjectCatalog({
      schemaVersion: 1,
      projects: PROJECTS.projects,
      nextCursor: null,
    });
    const projectRoutingBindings = projectDesktopProjectRoutingBindings(
      RAW_PROJECT_ROUTING_BINDINGS,
      [PROJECT.projectId],
    );
    const state = readyBootstrapState(account, catalog, routing, projects, projectRoutingBindings);

    expect(state).toEqual(READY);
    expect(JSON.stringify(state)).not.toContain("snapshotId");
    expect(JSON.stringify(state)).not.toContain("workerSessionId");
    expect(JSON.stringify(state)).not.toContain("nextCursor");
    expect(JSON.stringify(state)).not.toContain("profileId");
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.phase === "ready" ? state.account : undefined)).toBe(true);
    expect(JSON.stringify(state)).not.toContain("schemaVersion");
  });

  it("projects binding status without exposing profile fences and enforces Project alignment", () => {
    const rawDefault = {
      schemaVersion: 1,
      statuses: [
        {
          projectId: PROJECT.projectId,
          status: "default_bound",
          binding: {
            projectId: PROJECT.projectId,
            bindingVersion: 2,
            profileId: "00000000-0000-4000-8000-000000000901",
            profileVersionAtBinding: 3,
            configurationRevisionIdAtBinding: "00000000-0000-4000-8000-000000000861",
          },
        },
      ],
    };

    expect(projectDesktopProjectRoutingBindings(rawDefault, [PROJECT.projectId])).toEqual({
      bindings: [{ projectId: PROJECT.projectId, status: "default_bound", bindingVersion: 2 }],
    });
    expect(
      JSON.stringify(projectDesktopProjectRoutingBindings(rawDefault, [PROJECT.projectId])),
    ).not.toContain("profileId");
    expect(() => projectDesktopProjectRoutingBindings(rawDefault, [])).toThrow(
      BootstrapStateTransitionError,
    );
    expect(() =>
      projectDesktopProjectRoutingBindings(
        {
          ...rawDefault,
          statuses: [{ ...rawDefault.statuses[0], privateField: "secret" }],
        },
        [PROJECT.projectId],
      ),
    ).toThrow(BootstrapStateTransitionError);
    expect(decodeDesktopProjectRoutingBindingMutationResult({ status: "bound" })).toEqual({
      status: "bound",
    });
    expect(decodeDesktopProjectRoutingBindingMutationResult({ status: "future" })).toBeUndefined();
    expect(decodeDesktopProjectRoutingBindingProjectId(PROJECT.projectId)).toBe(PROJECT.projectId);
    expect(decodeDesktopProjectRoutingBindingProjectId("invalid")).toBeUndefined();
  });

  it("projects and validates Project catalog, chooser input, and selection results", () => {
    const projects = projectDesktopProjectCatalog({
      schemaVersion: 1,
      projects: PROJECTS.projects,
      nextCursor: null,
    });
    const registration = projectDesktopProjectRegistration({
      schemaVersion: 1,
      status: "registered",
      project: PROJECT,
    });
    const chooserInput = {
      displayName: PROJECT.displayName,
      workspace: {
        platform: PROJECT.workspace.platform,
        absolutePath: PROJECT.workspace.absolutePath,
      },
    };

    expect(projects).toEqual(PROJECTS);
    expect(registration).toEqual({ registrationStatus: "registered", project: PROJECT });
    expect(decodeDesktopProjectWorkspaceRegistration(chooserInput)).toEqual(chooserInput);
    expect(
      decodeDesktopProjectSelectionResult({
        status: "selected",
        registrationStatus: "registered",
        project: PROJECT,
        projects,
      }),
    ).toEqual({
      status: "selected",
      registrationStatus: "registered",
      project: PROJECT,
      projects,
    });
    expect(decodeDesktopProjectSelectionResult({ status: "cancelled" })).toEqual({
      status: "cancelled",
    });
    expect(
      decodeDesktopProjectWorkspaceRegistration({
        ...chooserInput,
        workspace: { ...chooserInput.workspace, absolutePath: "/Users/example/../secret" },
      }),
    ).toBeUndefined();
    expect(
      decodeDesktopProjectSelectionResult({
        status: "selected",
        registrationStatus: "registered",
        project: { ...PROJECT, createdAtMs: 1 },
        projects,
      }),
    ).toBeUndefined();
    expect(() =>
      projectDesktopProjectCatalog({
        schemaVersion: 1,
        projects: [PROJECT, PROJECT],
        nextCursor: null,
      }),
    ).toThrow(BootstrapStateTransitionError);
  });

  it("strictly projects routing state and validates renderer mutation boundaries", () => {
    const projected = projectDesktopRoutingConfiguration({ schemaVersion: 1, ...ROUTING });
    const update = {
      expectedProfileVersion: projected.profileVersion,
      previousConfigurationRevisionId: projected.configurationRevisionId,
      tiers: projected.tiers,
    };

    expect(projected).toEqual(ROUTING);
    expect(decodeDesktopRoutingConfigurationUpdate(update)).toEqual(update);
    expect(
      decodeDesktopRoutingConfigurationMutationResult({ status: "saved", routing: projected }),
    ).toEqual({ status: "saved", routing: projected });
    expect(decodeDesktopRoutingConfigurationMutationResult({ status: "unavailable" })).toEqual({
      status: "unavailable",
    });
    expect(
      decodeDesktopRoutingConfigurationUpdate({ ...update, expectedProfileVersion: 0 }),
    ).toBeUndefined();
    expect(
      decodeDesktopRoutingConfigurationMutationResult({
        status: "saved",
        routing: { ...projected, privateRevision: "secret" },
      }),
    ).toBeUndefined();
    expect(() =>
      projectDesktopRoutingConfiguration({
        schemaVersion: 1,
        ...ROUTING,
        availability: { ...ROUTING.availability, deep: "future" },
      }),
    ).toThrow(BootstrapStateTransitionError);
  });

  it("projects only the bounded visible catalog summary and rejects inconsistent pages", () => {
    const projected = projectDesktopModelCatalogSummary({
      schemaVersion: 1,
      provider: "openai",
      totalVisibleModels: 3,
      models: CATALOG.models,
      nextCursor: "00000000-0000-4000-8000-000000000853.Z3B0LWZhc3Q",
    });

    expect(projected).toEqual({ ...CATALOG, totalVisibleModels: 3, hasMore: true });
    expect(JSON.stringify(projected)).not.toContain("nextCursor");
    expect(Object.isFrozen(projected)).toBe(true);
    expect(() =>
      projectDesktopModelCatalogSummary({
        schemaVersion: 1,
        provider: "openai",
        totalVisibleModels: 2,
        models: CATALOG.models,
        nextCursor: "cursor-without-more-models",
      }),
    ).toThrow(BootstrapStateTransitionError);
    expect(() =>
      projectDesktopModelCatalogSummary({
        schemaVersion: 1,
        provider: "openai",
        totalVisibleModels: 2,
        models: [{ ...CATALOG.models[0], id: "private-id" }, CATALOG.models[1]],
        nextCursor: null,
      }),
    ).toThrow(BootstrapStateTransitionError);
  });

  it("publishes only valid forward transitions and supports unsubscription", () => {
    const store = new BootstrapStateStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.transition(READY);
    store.transition(READY);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.current).toEqual(READY);

    unsubscribe();
    store.transition(failedBootstrapState("daemon_unavailable"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.current).toEqual({ phase: "failed", code: "daemon_unavailable" });
    expect(() => store.transition(READY)).toThrow(BootstrapStateTransitionError);
  });

  it("isolates a failing observer from state commits and later observers", () => {
    const store = new BootstrapStateStore();
    const observer = vi.fn();
    store.subscribe(() => {
      throw new Error("renderer unavailable");
    });
    store.subscribe(observer);

    expect(() => store.transition(READY)).not.toThrow();
    expect(store.current).toEqual(READY);
    expect(observer).toHaveBeenCalledExactlyOnceWith(READY);
  });

  it("rejects a stale snapshot after a newer event", () => {
    const staleStarting = Object.freeze({ phase: "starting" } as const);

    expect(advanceDesktopBootstrapState(READY, staleStarting)).toBe(READY);
    expect(advanceDesktopBootstrapState(staleStarting, READY)).toBe(READY);
  });
});
