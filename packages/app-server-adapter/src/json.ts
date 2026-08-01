import type { JsonValue } from "@codex-harness/protocol";

export function deepFreezeJsonValue<T extends JsonValue>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJsonValue(item);
    }
  } else {
    for (const item of Object.values(value)) {
      deepFreezeJsonValue(item);
    }
  }

  return Object.freeze(value);
}
