import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { StartupCapabilityInputError, readStartupCapability } from "./startup-capability.js";

const STARTUP_CAPABILITY = "A".repeat(43);

describe("startup capability input", () => {
  it("reads one canonical capability from fragmented byte chunks", async () => {
    const input = Readable.from([
      Buffer.from(STARTUP_CAPABILITY.slice(0, 10)),
      Buffer.from(STARTUP_CAPABILITY.slice(10)),
    ]);
    await expect(readStartupCapability(input)).resolves.toBe(STARTUP_CAPABILITY);
  });

  it("fails immediately on oversized input without exposing its contents", async () => {
    const secret = `${STARTUP_CAPABILITY}sentinel-secret`;
    const error = await readStartupCapability(Readable.from([Buffer.from(secret)])).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(StartupCapabilityInputError);
    expect(error).toMatchObject({ code: "input_too_large" });
    expect(String(error)).not.toContain(secret);
  });

  it("rejects truncated, non-canonical, and non-byte input", async () => {
    await expect(
      readStartupCapability(Readable.from([Buffer.from("A".repeat(42))])),
    ).rejects.toMatchObject({
      code: "invalid_capability",
    });
    await expect(
      readStartupCapability(Readable.from([Buffer.from(`${"A".repeat(42)}B`)])),
    ).rejects.toMatchObject({
      code: "invalid_capability",
    });
    await expect(
      readStartupCapability(Readable.from([STARTUP_CAPABILITY], { objectMode: true })),
    ).rejects.toMatchObject({ code: "input_error" });
  });

  it("maps stream failures to a fixed public error", async () => {
    const input = Readable.from(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield Buffer.from("A");
        throw new Error("sentinel-stream-detail");
      })(),
    );
    const error = await readStartupCapability(input).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "input_error",
      message: "The startup capability input failed.",
    });
    expect(String(error)).not.toContain("sentinel-stream-detail");
  });
});
