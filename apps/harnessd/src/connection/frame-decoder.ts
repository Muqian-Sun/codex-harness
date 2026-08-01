import { MAX_FRAME_BYTES } from "@codex-harness/protocol";

export type FrameDecoderFailureCode = "decoder_closed" | "frame_too_large" | "invalid_chunk";

export type FrameDecoderResult =
  | Readonly<{ ok: true; frames: readonly Uint8Array[] }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: FrameDecoderFailureCode; message: string }>;
    }>;

const FAILURE_MESSAGES: Readonly<Record<FrameDecoderFailureCode, string>> = Object.freeze({
  decoder_closed: "The JSONL frame decoder is closed.",
  frame_too_large: "The JSONL frame exceeds the size limit.",
  invalid_chunk: "The JSONL input chunk is invalid.",
});

function success(frames: readonly Uint8Array[]): FrameDecoderResult {
  return Object.freeze({ ok: true, frames: Object.freeze(frames) });
}

function failure(code: FrameDecoderFailureCode): FrameDecoderResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message: FAILURE_MESSAGES[code] }),
  });
}

export class JsonlFrameDecoder {
  #bufferedByteLength = 0;
  #chunks: Uint8Array[] = [];
  #closed = false;

  get bufferedByteLength(): number {
    return this.#bufferedByteLength;
  }

  push(input: unknown): FrameDecoderResult {
    try {
      if (this.#closed) {
        return failure("decoder_closed");
      }
      if (!(input instanceof Uint8Array)) {
        this.#failClosed();
        return failure("invalid_chunk");
      }

      const frames: Uint8Array[] = [];
      let segmentStart = 0;
      for (let index = 0; index < input.byteLength; index += 1) {
        if (input[index] !== 0x0a) {
          continue;
        }

        if (!this.#append(input.subarray(segmentStart, index))) {
          return failure("frame_too_large");
        }
        frames.push(this.#takeFrame());
        segmentStart = index + 1;
      }

      if (!this.#append(input.subarray(segmentStart))) {
        return failure("frame_too_large");
      }
      return success(frames);
    } catch {
      this.#failClosed();
      return failure("invalid_chunk");
    }
  }

  finish(): FrameDecoderResult {
    if (this.#closed) {
      return failure("decoder_closed");
    }
    this.#closed = true;
    if (this.#bufferedByteLength > 0) {
      this.#clear();
      return failure("invalid_chunk");
    }
    return success([]);
  }

  close(): void {
    this.#failClosed();
  }

  #append(segment: Uint8Array): boolean {
    if (segment.byteLength === 0) {
      return true;
    }

    const nextLength = this.#bufferedByteLength + segment.byteLength;
    const lastByte = segment[segment.byteLength - 1];
    if (
      nextLength > MAX_FRAME_BYTES + 1 ||
      (nextLength === MAX_FRAME_BYTES + 1 && lastByte !== 0x0d)
    ) {
      this.#failClosed();
      return false;
    }

    this.#chunks.push(Uint8Array.from(segment));
    this.#bufferedByteLength = nextLength;
    return true;
  }

  #takeFrame(): Uint8Array {
    const frame = new Uint8Array(this.#bufferedByteLength);
    let offset = 0;
    for (const chunk of this.#chunks) {
      frame.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.#clear();
    return frame;
  }

  #clear(): void {
    this.#chunks = [];
    this.#bufferedByteLength = 0;
  }

  #failClosed(): void {
    this.#closed = true;
    this.#clear();
  }
}
