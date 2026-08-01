import { TextEncoder } from "node:util";

import { MAX_FRAME_BYTES } from "@codex-harness/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { JsonlFrameDecoder } from "./frame-decoder.js";

const encoder = new TextEncoder();

describe("incremental JSONL frame decoder", () => {
  it("reassembles fragmented frames and splits multiple LF or CRLF frames", () => {
    const decoder = new JsonlFrameDecoder();
    expect(decoder.push(encoder.encode('{"one":'))).toEqual({ ok: true, frames: [] });

    const result = decoder.push(encoder.encode('1}\n{"two":2}\r\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("frames were not decoded");
    }
    expect(result.frames.map((frame) => new TextDecoder().decode(frame))).toEqual([
      '{"one":1}',
      '{"two":2}\r',
    ]);
    expect(decoder.bufferedByteLength).toBe(0);
  });

  it("owns buffered bytes instead of retaining mutable Buffer views", () => {
    const decoder = new JsonlFrameDecoder();
    const firstChunk = Buffer.from('{"stable":');
    expect(decoder.push(firstChunk).ok).toBe(true);
    firstChunk.fill(0x78);
    const result = decoder.push(encoder.encode("true}\n"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(decoderText(result.frames[0])).toBe('{"stable":true}');
    }
  });

  it("accepts the exact frame limit plus an optional carriage return", () => {
    const decoder = new JsonlFrameDecoder();
    expect(decoder.push(new Uint8Array(MAX_FRAME_BYTES).fill(0x20)).ok).toBe(true);
    const result = decoder.push(Uint8Array.of(0x0d, 0x0a));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]?.byteLength).toBe(MAX_FRAME_BYTES + 1);
    }
  });

  it("fails closed before retaining an oversized unterminated frame", () => {
    const decoder = new JsonlFrameDecoder();
    const result = decoder.push(new Uint8Array(MAX_FRAME_BYTES + 1).fill(0x20));
    expect(result).toMatchObject({ ok: false, error: { code: "frame_too_large" } });
    expect(decoder.bufferedByteLength).toBe(0);
    expect(decoder.push(Uint8Array.of(0x0a))).toMatchObject({
      ok: false,
      error: { code: "decoder_closed" },
    });
  });

  it("rejects non-byte chunks and truncated final frames", () => {
    const invalid = new JsonlFrameDecoder();
    expect(invalid.push("not bytes")).toMatchObject({
      ok: false,
      error: { code: "invalid_chunk" },
    });

    const truncated = new JsonlFrameDecoder();
    expect(truncated.push(encoder.encode("partial")).ok).toBe(true);
    expect(truncated.finish()).toMatchObject({
      ok: false,
      error: { code: "invalid_chunk" },
    });
  });

  it("never throws for arbitrary byte chunks", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (chunk) => {
        const decoder = new JsonlFrameDecoder();
        expect(() => decoder.push(chunk)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

function decoderText(frame: Uint8Array | undefined): string {
  if (frame === undefined) {
    throw new Error("expected a decoded frame");
  }
  return new TextDecoder().decode(frame);
}
