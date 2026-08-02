import { validateJsonValue } from "@codex-harness/protocol";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ACCOUNT_PLAN_TYPES = Object.freeze([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
] as const);

export type AccountPlanType = (typeof ACCOUNT_PLAN_TYPES)[number];
export type AccountAuthenticationStatus =
  "authenticated" | "authentication_required" | "not_required";
export type AccountCredentialKind = "amazon_bedrock" | "api_key" | "chatgpt" | null;

export type AccountStatusSnapshot = Readonly<{
  schemaVersion: 1;
  snapshotId: string;
  workerSessionId: string;
  observedAtMs: number;
  status: AccountAuthenticationStatus;
  credentialKind: AccountCredentialKind;
  planType: AccountPlanType | null;
}>;

export type CreateAccountStatusSnapshotInput = Readonly<{
  schemaVersion: 1;
  snapshotId: string;
  workerSessionId: string;
  observedAtMs: number;
  response: unknown;
}>;

export class AccountStatusError extends Error {
  readonly code = "invalid_account_status";

  constructor() {
    super("The account status snapshot is invalid.");
    this.name = "AccountStatusError";
  }
}

const planTypes = new Set<string>(ACCOUNT_PLAN_TYPES);

export function createAccountStatusSnapshot(input: unknown): AccountStatusSnapshot {
  try {
    if (!validateJsonValue(input).ok) {
      throw new AccountStatusError();
    }
    const record = requireExactRecord(input, [
      "observedAtMs",
      "response",
      "schemaVersion",
      "snapshotId",
      "workerSessionId",
    ]);
    if (record.schemaVersion !== 1) {
      throw new AccountStatusError();
    }
    const projection = projectAccountResponse(record.response);
    return freezeSnapshot({
      schemaVersion: 1,
      snapshotId: requireUuid(record.snapshotId),
      workerSessionId: requireUuid(record.workerSessionId),
      observedAtMs: requireObservedAt(record.observedAtMs),
      ...projection,
    });
  } catch (error: unknown) {
    if (error instanceof AccountStatusError) {
      throw error;
    }
    throw new AccountStatusError();
  }
}

export function decodeAccountStatusSnapshot(input: unknown): AccountStatusSnapshot {
  try {
    if (!validateJsonValue(input).ok) {
      throw new AccountStatusError();
    }
    const record = requireExactRecord(input, [
      "credentialKind",
      "observedAtMs",
      "planType",
      "schemaVersion",
      "snapshotId",
      "status",
      "workerSessionId",
    ]);
    if (record.schemaVersion !== 1) {
      throw new AccountStatusError();
    }
    const status = requireStatus(record.status);
    const credentialKind = requireCredentialKind(record.credentialKind);
    const planType = requireNullablePlanType(record.planType);
    if (
      (status === "authenticated" && credentialKind === null) ||
      (status !== "authenticated" && credentialKind !== null) ||
      (credentialKind === "chatgpt" ? planType === null : planType !== null)
    ) {
      throw new AccountStatusError();
    }
    return freezeSnapshot({
      schemaVersion: 1,
      snapshotId: requireUuid(record.snapshotId),
      workerSessionId: requireUuid(record.workerSessionId),
      observedAtMs: requireObservedAt(record.observedAtMs),
      status,
      credentialKind,
      planType,
    });
  } catch (error: unknown) {
    if (error instanceof AccountStatusError) {
      throw error;
    }
    throw new AccountStatusError();
  }
}

function projectAccountResponse(input: unknown): Readonly<{
  status: AccountAuthenticationStatus;
  credentialKind: AccountCredentialKind;
  planType: AccountPlanType | null;
}> {
  const response = requireExactRecord(input, ["account", "requiresOpenaiAuth"]);
  if (typeof response.requiresOpenaiAuth !== "boolean") {
    throw new AccountStatusError();
  }
  if (response.account === null) {
    return Object.freeze({
      status: response.requiresOpenaiAuth ? "authentication_required" : "not_required",
      credentialKind: null,
      planType: null,
    });
  }
  const account = requireRecord(response.account);
  if (account.type === "apiKey") {
    requireExactKeys(account, ["type"]);
    return Object.freeze({
      status: "authenticated",
      credentialKind: "api_key",
      planType: null,
    });
  }
  if (account.type === "amazonBedrock") {
    requireExactKeys(account, ["type"]);
    return Object.freeze({
      status: "authenticated",
      credentialKind: "amazon_bedrock",
      planType: null,
    });
  }
  if (account.type === "chatgpt") {
    requireExactKeys(account, ["planType", "type"]);
    return Object.freeze({
      status: "authenticated",
      credentialKind: "chatgpt",
      planType: requirePlanType(account.planType),
    });
  }
  throw new AccountStatusError();
}

function freezeSnapshot(input: AccountStatusSnapshot): AccountStatusSnapshot {
  return Object.freeze(input);
}

function requireExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(input);
  requireExactKeys(record, expectedKeys);
  return record;
}

function requireExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): void {
  const keys = Object.keys(record).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new AccountStatusError();
  }
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AccountStatusError();
  }
  return input as Record<string, unknown>;
}

function requireUuid(input: unknown): string {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new AccountStatusError();
  }
  return input;
}

function requireObservedAt(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new AccountStatusError();
  }
  return input as number;
}

function requireStatus(input: unknown): AccountAuthenticationStatus {
  if (
    input !== "authenticated" &&
    input !== "authentication_required" &&
    input !== "not_required"
  ) {
    throw new AccountStatusError();
  }
  return input;
}

function requireCredentialKind(input: unknown): AccountCredentialKind {
  if (input !== null && input !== "amazon_bedrock" && input !== "api_key" && input !== "chatgpt") {
    throw new AccountStatusError();
  }
  return input;
}

function requirePlanType(input: unknown): AccountPlanType {
  if (typeof input !== "string" || !planTypes.has(input)) {
    throw new AccountStatusError();
  }
  return input as AccountPlanType;
}

function requireNullablePlanType(input: unknown): AccountPlanType | null {
  return input === null ? null : requirePlanType(input);
}
