import { describe, expect, it } from "vitest";

import {
  HARNESS_ROUTE_OPERATION_KINDS,
  HarnessRouteOperationValidationError,
  normalizeHarnessRouteOperations,
} from "./harness-route-operation.js";

const operation = (
  suffix: number,
  kind: (typeof HARNESS_ROUTE_OPERATION_KINDS)[number] = "answer",
) =>
  ({
    operationId: `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`,
    kind,
  }) as const;

describe("Harness route operations", () => {
  it("normalizes and freezes every bounded operation kind", () => {
    const normalized = normalizeHarnessRouteOperations(
      HARNESS_ROUTE_OPERATION_KINDS.map((kind, index) => operation(index + 1, kind)),
    );

    expect(normalized.map((entry) => entry.kind)).toEqual(HARNESS_ROUTE_OPERATION_KINDS);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalized.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it("rejects empty, oversized, duplicate, unknown and non-exact entries", () => {
    const invalid = [
      null,
      [],
      [null],
      Array.from({ length: 257 }, (_, index) => operation(index + 1)),
      [operation(1), operation(1, "inspect_workspace")],
      [{ ...operation(1), kind: "unknown" }],
      [{ ...operation(1), extra: true }],
      [{ kind: "answer" }],
      [Object.assign(Object.create({ inherited: true }), operation(1))],
      [Object.assign(operation(1), { [Symbol("extra")]: true })],
      [
        Object.create(null, {
          operationId: { get: () => operation(1).operationId, enumerable: true },
          kind: { value: "answer", enumerable: true },
        }),
      ],
    ];

    for (const candidate of invalid) {
      expect(() => normalizeHarnessRouteOperations(candidate)).toThrow(
        HarnessRouteOperationValidationError,
      );
    }
  });
});
