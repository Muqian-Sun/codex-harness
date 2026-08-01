import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { monitorParentWatchdog } from "./parent-watchdog.js";

describe("parent watchdog", () => {
  it("reports EOF exactly once", async () => {
    const watchdog = new PassThrough();
    const onParentLost = vi.fn();
    monitorParentWatchdog(watchdog, onParentLost);
    watchdog.end();
    await new Promise<void>((resolve) => watchdog.once("end", resolve));
    expect(onParentLost).toHaveBeenCalledOnce();
    expect(onParentLost).toHaveBeenCalledWith("parent_eof");
  });

  it("reports stream errors conservatively and supports disposal", () => {
    const failed = new PassThrough();
    const onFailure = vi.fn();
    monitorParentWatchdog(failed, onFailure);
    failed.emit("error", new Error("sentinel"));
    failed.emit("error", new Error("ignored"));
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith("parent_watchdog_error");

    const disposed = new PassThrough();
    const onDisposed = vi.fn();
    const dispose = monitorParentWatchdog(disposed, onDisposed);
    dispose();
    expect(onDisposed).not.toHaveBeenCalled();
  });

  it("treats an unexpected close without EOF as parent loss", () => {
    const watchdog = new PassThrough();
    const onParentLost = vi.fn();
    monitorParentWatchdog(watchdog, onParentLost);
    watchdog.emit("close");
    expect(onParentLost).toHaveBeenCalledOnce();
    expect(onParentLost).toHaveBeenCalledWith("parent_watchdog_error");
  });
});
