import { MAX_JSON_DEPTH, MAX_JSON_NODES } from "./constants.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type JsonValidationFailureReason =
  | "accessor"
  | "cycle"
  | "depth"
  | "inspection"
  | "nodes"
  | "non_finite_number"
  | "non_json_type"
  | "non_plain_object"
  | "sparse_array"
  | "symbol_key";

export type JsonValidationResult =
  { ok: true } | { ok: false; reason: JsonValidationFailureReason };

type StackEntry =
  { kind: "enter"; value: unknown; depth: number } | { kind: "exit"; value: object };

function failure(reason: JsonValidationFailureReason): JsonValidationResult {
  return { ok: false, reason };
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) {
    return false;
  }

  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

export function validateJsonValue(input: unknown): JsonValidationResult {
  const activeObjects = new WeakSet<object>();
  const stack: StackEntry[] = [{ kind: "enter", value: input, depth: 0 }];
  let visitedNodes = 0;

  try {
    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry === undefined) {
        break;
      }

      if (entry.kind === "exit") {
        activeObjects.delete(entry.value);
        continue;
      }

      visitedNodes += 1;
      if (visitedNodes > MAX_JSON_NODES) {
        return failure("nodes");
      }

      if (entry.depth > MAX_JSON_DEPTH) {
        return failure("depth");
      }

      const value = entry.value;
      if (value === null || typeof value === "boolean" || typeof value === "string") {
        continue;
      }

      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          return failure("non_finite_number");
        }
        continue;
      }

      if (typeof value !== "object") {
        return failure("non_json_type");
      }

      if (activeObjects.has(value)) {
        return failure("cycle");
      }
      activeObjects.add(value);
      stack.push({ kind: "exit", value });

      if (Array.isArray(value)) {
        if (
          value.length + visitedNodes > MAX_JSON_NODES ||
          value.length + stack.length > MAX_JSON_NODES
        ) {
          return failure("nodes");
        }

        const ownKeys = Reflect.ownKeys(value);
        for (const key of ownKeys) {
          if (typeof key === "symbol") {
            return failure("symbol_key");
          }
          if (key !== "length" && !isArrayIndex(key, value.length)) {
            return failure("non_json_type");
          }
        }

        for (let index = value.length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined) {
            return failure("sparse_array");
          }
          if (!("value" in descriptor) || !descriptor.enumerable) {
            return failure("accessor");
          }
          stack.push({
            kind: "enter",
            value: descriptor.value,
            depth: entry.depth + 1,
          });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return failure("non_plain_object");
      }

      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length + visitedNodes > MAX_JSON_NODES ||
        ownKeys.length + stack.length > MAX_JSON_NODES
      ) {
        return failure("nodes");
      }

      for (let index = ownKeys.length - 1; index >= 0; index -= 1) {
        const key = ownKeys[index];
        if (key === undefined) {
          return failure("inspection");
        }
        if (typeof key === "symbol") {
          return failure("symbol_key");
        }

        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return failure("accessor");
        }

        stack.push({
          kind: "enter",
          value: descriptor.value,
          depth: entry.depth + 1,
        });
      }
    }
  } catch {
    return failure("inspection");
  }

  return { ok: true };
}

export function isJsonValue(input: unknown): input is JsonValue {
  return validateJsonValue(input).ok;
}
