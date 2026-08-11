import { validateJsonValue } from "@codex-harness/protocol";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_OPERATIONS = 256;

export const HARNESS_ROUTE_OPERATION_KINDS = Object.freeze([
  "answer",
  "inspect_workspace",
  "modify_workspace",
  "run_workspace_command",
  "network_read",
  "credential_access",
  "external_write",
  "database_migration",
  "production_change",
  "irreversible_action",
  "permission_boundary_change",
  "public_api_change",
  "concurrent_change",
  "architecture_decision",
  "systemic_diagnosis",
  "user_interaction",
] as const);

export type HarnessRouteOperationKind = (typeof HARNESS_ROUTE_OPERATION_KINDS)[number];

export type HarnessRouteOperation = Readonly<{
  operationId: string;
  kind: HarnessRouteOperationKind;
}>;

export class HarnessRouteOperationValidationError extends Error {
  constructor() {
    super("The Harness route operation list is invalid.");
    this.name = "HarnessRouteOperationValidationError";
  }
}

export function normalizeHarnessRouteOperations(input: unknown): readonly HarnessRouteOperation[] {
  if (
    !validateJsonValue(input).ok ||
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > MAX_OPERATIONS
  ) {
    throw new HarnessRouteOperationValidationError();
  }
  const operations = input.map((operation) => normalizeOperation(operation));
  if (new Set(operations.map((operation) => operation.operationId)).size !== operations.length) {
    throw new HarnessRouteOperationValidationError();
  }
  return Object.freeze(operations);
}

function normalizeOperation(input: unknown): HarnessRouteOperation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessRouteOperationValidationError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
    keys.length !== 2 ||
    !Object.hasOwn(descriptors, "kind") ||
    !Object.hasOwn(descriptors, "operationId") ||
    keys.some((key) => {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new HarnessRouteOperationValidationError();
  }
  const record = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      "value" in descriptor ? descriptor.value : undefined,
    ]),
  );
  if (
    typeof record.operationId !== "string" ||
    !UUID_PATTERN.test(record.operationId) ||
    typeof record.kind !== "string" ||
    !HARNESS_ROUTE_OPERATION_KINDS.includes(record.kind as HarnessRouteOperationKind)
  ) {
    throw new HarnessRouteOperationValidationError();
  }
  return Object.freeze({
    operationId: record.operationId,
    kind: record.kind as HarnessRouteOperationKind,
  });
}
