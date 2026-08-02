import { describe, expect, it, vi } from "vitest";

import {
  BootstrapStateStore,
  BootstrapStateTransitionError,
  advanceDesktopBootstrapState,
  decodeDesktopBootstrapState,
  failedBootstrapState,
} from "./bootstrap-state.js";

describe("desktop bootstrap state", () => {
  it("strictly decodes and freezes the renderer boundary value", () => {
    const ready = decodeDesktopBootstrapState({ phase: "ready" });
    const failed = decodeDesktopBootstrapState({ phase: "failed", code: "resource_invalid" });

    expect(ready).toEqual({ phase: "ready" });
    expect(failed).toEqual({ phase: "failed", code: "resource_invalid" });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(failed)).toBe(true);
    expect(decodeDesktopBootstrapState({ phase: "ready", endpoint: "/private/secret" })).toBe(
      undefined,
    );
    expect(decodeDesktopBootstrapState({ phase: "failed", code: "raw_error" })).toBe(undefined);
  });

  it("publishes only valid forward transitions and supports unsubscription", () => {
    const store = new BootstrapStateStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.transition(Object.freeze({ phase: "ready" }));
    store.transition(Object.freeze({ phase: "ready" }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.current).toEqual({ phase: "ready" });

    unsubscribe();
    store.transition(failedBootstrapState("daemon_unavailable"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.current).toEqual({ phase: "failed", code: "daemon_unavailable" });
    expect(() => store.transition(Object.freeze({ phase: "ready" }))).toThrow(
      BootstrapStateTransitionError,
    );
  });

  it("isolates a failing observer from state commits and later observers", () => {
    const store = new BootstrapStateStore();
    const observer = vi.fn();
    store.subscribe(() => {
      throw new Error("renderer unavailable");
    });
    store.subscribe(observer);

    expect(() => store.transition(Object.freeze({ phase: "ready" }))).not.toThrow();
    expect(store.current).toEqual({ phase: "ready" });
    expect(observer).toHaveBeenCalledExactlyOnceWith({ phase: "ready" });
  });

  it("rejects a stale snapshot after a newer event", () => {
    const ready = Object.freeze({ phase: "ready" } as const);
    const staleStarting = Object.freeze({ phase: "starting" } as const);

    expect(advanceDesktopBootstrapState(ready, staleStarting)).toBe(ready);
    expect(advanceDesktopBootstrapState(staleStarting, ready)).toBe(ready);
  });
});
