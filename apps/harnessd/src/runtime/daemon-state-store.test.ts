import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ModelRoutingProfileRepository } from "../domain/model-routing-profile-repository.js";
import { NodeOperationManifestRepository } from "../domain/node-operation-manifest-repository.js";
import { DaemonStateStore, DaemonStateStoreError } from "./daemon-state-store.js";

const directories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-harness-daemon-state-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "harness.db");
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("daemon state store", () => {
  it("opens every current projection and recovers a persisted routing profile", async () => {
    const path = await databasePath();
    const first = await DaemonStateStore.open({ databasePath: path });
    const profiles = new ModelRoutingProfileRepository(first.events);
    expect(() => new NodeOperationManifestRepository(first.events)).not.toThrow();
    profiles.setConfiguration({
      profileId: "00000000-0000-4000-8000-000000000921",
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      occurredAtMs: 1,
      configuration: {
        schemaVersion: 1,
        revisionId: "00000000-0000-4000-8000-000000000922",
        revisionNumber: 1,
        tiers: {
          fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
          standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
          deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
        },
      },
    });
    expect(first.inspect()).toMatchObject({ eventCount: 1, lastSequence: 1, journalMode: "wal" });
    first.close();
    expect(first.state).toBe("closed");
    expect(() => first.events).toThrow(DaemonStateStoreError);
    expect(() => first.close()).not.toThrow();

    const recovered = await DaemonStateStore.open({ databasePath: path });
    expect(
      new ModelRoutingProfileRepository(recovered.events).readProfile(
        "00000000-0000-4000-8000-000000000921",
      ),
    ).toMatchObject({ profileVersion: 1, activeConfiguration: { revisionNumber: 1 } });
    recovered.close();
  });

  it("rejects malformed configuration and maps storage validation to fixed failures", async () => {
    const openUnknown = DaemonStateStore.open as unknown as (
      config: unknown,
    ) => Promise<DaemonStateStore>;
    await expect(openUnknown(null)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      DaemonStateStore.open({ databasePath: "/tmp/not-harness.sqlite" }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });

    const path = await databasePath();
    await chmod(dirname(path), 0o755);
    const error = await DaemonStateStore.open({ databasePath: path }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "state_start_failed" });
    expect(String(error)).not.toContain(path);
  });

  it("maps an existing non-Harness database to a path-free startup failure", async () => {
    const path = await databasePath();
    await writeFile(path, "not a sqlite database", { mode: 0o600 });

    const error = await DaemonStateStore.open({ databasePath: path }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "state_start_failed" });
    expect(String(error)).not.toContain(path);
  });
});
