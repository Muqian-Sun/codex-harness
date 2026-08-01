import { APPLICATION_PROTOCOL_VERSION } from "./constants.js";

export class UnsupportedProtocolVersionError extends Error {
  public constructor() {
    super("Unsupported application protocol version.");
    this.name = "UnsupportedProtocolVersionError";
  }
}

export function assertSupportedProtocolVersion(
  version: string,
): asserts version is typeof APPLICATION_PROTOCOL_VERSION {
  if (version !== APPLICATION_PROTOCOL_VERSION) {
    throw new UnsupportedProtocolVersionError();
  }
}
