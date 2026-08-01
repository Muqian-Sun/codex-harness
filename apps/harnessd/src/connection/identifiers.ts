import { randomBytes, timingSafeEqual } from "node:crypto";

import { StartupCapabilitySchema, StreamIdSchema } from "@codex-harness/protocol";

export function generateStreamId(): string {
  const streamId = randomBytes(16).toString("base64url");
  if (!StreamIdSchema.safeParse(streamId).success) {
    throw new Error("Failed to generate a stream identifier.");
  }
  return streamId;
}

export function startupCapabilitiesEqual(expected: string, actual: string): boolean {
  try {
    if (
      !StartupCapabilitySchema.safeParse(expected).success ||
      !StartupCapabilitySchema.safeParse(actual).success
    ) {
      return false;
    }

    const expectedBytes = Buffer.from(expected, "base64url");
    const actualBytes = Buffer.from(actual, "base64url");
    return (
      expectedBytes.byteLength === 32 &&
      actualBytes.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(expectedBytes, actualBytes)
    );
  } catch {
    return false;
  }
}
