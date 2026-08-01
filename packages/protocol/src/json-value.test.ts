import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_JSON_DEPTH, MAX_JSON_NODES } from "./constants.js";
import { isJsonValue, validateJsonValue, type JsonValidationFailureReason } from "./json-value.js";

function expectFailureReason(value: unknown, reason: JsonValidationFailureReason): void {
  const result = validateJsonValue(value);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
  }
}

describe("validateJsonValue", () => {
  it("accepts JSON primitives, arrays, objects, and shared non-cyclic references", () => {
    const shared = { accepted: true };
    expect(validateJsonValue(null)).toEqual({ ok: true });
    expect(validateJsonValue(["value", 1, false, null])).toEqual({ ok: true });
    expect(validateJsonValue({ left: shared, right: shared })).toEqual({ ok: true });
    expect(isJsonValue({ nested: [shared] })).toBe(true);
  });

  it("rejects non-JSON runtime values and non-finite numbers", () => {
    expect(validateJsonValue(undefined)).toEqual({
      ok: false,
      reason: "non_json_type",
    });
    expect(validateJsonValue(1n).ok).toBe(false);
    expect(validateJsonValue(Number.NaN)).toEqual({
      ok: false,
      reason: "non_finite_number",
    });
    expect(validateJsonValue(Number.POSITIVE_INFINITY).ok).toBe(false);
    expectFailureReason(new Date(), "non_plain_object");
  });

  it("rejects cycles without throwing", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => validateJsonValue(cyclic)).not.toThrow();
    expect(validateJsonValue(cyclic)).toEqual({ ok: false, reason: "cycle" });
  });

  it("rejects throwing accessors without invoking them", () => {
    const value = {};
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get() {
        throw new Error("sentinel-secret");
      },
    });

    expect(() => validateJsonValue(value)).not.toThrow();
    expect(validateJsonValue(value)).toEqual({
      ok: false,
      reason: "accessor",
    });
  });

  it("rejects sparse arrays and symbol keys", () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = true;
    const symbolObject = { valid: true } as Record<PropertyKey, unknown>;
    symbolObject[Symbol("hidden")] = true;

    expectFailureReason(sparse, "sparse_array");
    expectFailureReason(symbolObject, "symbol_key");
  });

  it("enforces nesting and node limits", () => {
    let deep: unknown = null;
    for (let index = 0; index <= MAX_JSON_DEPTH; index += 1) {
      deep = [deep];
    }

    expectFailureReason(deep, "depth");
    expectFailureReason(new Array(MAX_JSON_NODES + 1).fill(null), "nodes");
  });

  it("bounds pending work for wide shared graphs", () => {
    const sharedLevel = new Array(MAX_JSON_NODES - 1).fill(null);
    const root = new Array(MAX_JSON_NODES - 1).fill(sharedLevel);

    expectFailureReason(root, "nodes");
  });

  it("never throws for property-generated runtime values", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => validateJsonValue(value)).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });
});
