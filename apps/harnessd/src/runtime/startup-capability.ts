import type { Readable } from "node:stream";

import { StartupCapabilitySchema } from "@codex-harness/protocol";

const STARTUP_CAPABILITY_BYTES = 43;

export type StartupCapabilityInputErrorCode =
  "input_error" | "input_too_large" | "invalid_capability";

const PUBLIC_MESSAGES: Readonly<Record<StartupCapabilityInputErrorCode, string>> = Object.freeze({
  input_error: "The startup capability input failed.",
  input_too_large: "The startup capability input exceeds the size limit.",
  invalid_capability: "The startup capability input is invalid.",
});

export class StartupCapabilityInputError extends Error {
  readonly code: StartupCapabilityInputErrorCode;

  constructor(code: StartupCapabilityInputErrorCode) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "StartupCapabilityInputError";
    this.code = code;
  }
}

export async function readStartupCapability(input: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of input as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array)) {
        input.destroy();
        throw new StartupCapabilityInputError("input_error");
      }

      totalBytes += chunk.byteLength;
      if (totalBytes > STARTUP_CAPABILITY_BYTES) {
        input.destroy();
        throw new StartupCapabilityInputError("input_too_large");
      }
      chunks.push(Uint8Array.from(chunk));
    }
  } catch (error: unknown) {
    if (error instanceof StartupCapabilityInputError) {
      throw error;
    }
    throw new StartupCapabilityInputError("input_error");
  }

  if (totalBytes !== STARTUP_CAPABILITY_BYTES) {
    throw new StartupCapabilityInputError("invalid_capability");
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const capability = Buffer.from(bytes).toString("ascii");
  if (!StartupCapabilitySchema.safeParse(capability).success) {
    throw new StartupCapabilityInputError("invalid_capability");
  }
  return capability;
}
