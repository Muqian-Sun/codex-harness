import { describe, expect, it, vi } from "vitest";

import {
  BootstrapStateStore,
  BootstrapStateTransitionError,
  advanceDesktopBootstrapState,
  decodeDesktopBootstrapState,
  failedBootstrapState,
  projectDesktopModelCatalogSummary,
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

const READY = Object.freeze({
  phase: "ready" as const,
  account: Object.freeze({
    status: "authenticated" as const,
    credentialKind: "chatgpt" as const,
    planType: "plus" as const,
  }),
  catalog: CATALOG,
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
      }),
    ).toBe(undefined);
    expect(
      decodeDesktopBootstrapState({
        phase: "ready",
        account: READY.account,
        catalog: { ...READY.catalog, nextCursor: "private-cursor" },
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
    const state = readyBootstrapState(account, catalog);

    expect(state).toEqual(READY);
    expect(JSON.stringify(state)).not.toContain("snapshotId");
    expect(JSON.stringify(state)).not.toContain("workerSessionId");
    expect(JSON.stringify(state)).not.toContain("nextCursor");
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.phase === "ready" ? state.account : undefined)).toBe(true);
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
