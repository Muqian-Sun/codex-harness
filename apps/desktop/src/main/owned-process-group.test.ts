import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { ownedProcessGroupExists, terminateOwnedProcessGroup } from "./owned-process-group.js";

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    const processGroupId = child.pid;
    if (processGroupId !== undefined && ownedProcessGroupExists(processGroupId)) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The test-owned group may already be gone.
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, "exit"), delay(1_000)]);
    }
  }
});

describe.skipIf(process.platform !== "darwin")("owned macOS process groups", () => {
  it("escalates from SIGTERM to SIGKILL for a test-owned stubborn group", async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(child);
    const ready = once(child.stdout!, "data");
    await once(child, "spawn");
    await ready;
    const processGroupId = child.pid;
    expect(processGroupId).toBeDefined();
    if (processGroupId === undefined) {
      throw new Error("Expected a child process group ID.");
    }
    const exit = once(child, "exit");

    await expect(
      terminateOwnedProcessGroup(processGroupId, {
        sigtermTimeoutMs: 30,
        sigkillTimeoutMs: 1_000,
        pollIntervalMs: 5,
      }),
    ).resolves.toBe("sigkill");
    await exit;
    expect(child.signalCode).toBe("SIGKILL");
    expect(ownedProcessGroupExists(processGroupId)).toBe(false);
  });
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
