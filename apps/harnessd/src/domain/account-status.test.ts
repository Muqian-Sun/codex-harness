import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PLAN_TYPES,
  AccountStatusError,
  createAccountStatusSnapshot,
  decodeAccountStatusSnapshot,
} from "./account-status.js";

const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000701";
const WORKER_SESSION_ID = "00000000-0000-4000-8000-000000000702";

function snapshot(response: unknown) {
  return createAccountStatusSnapshot({
    schemaVersion: 1,
    snapshotId: SNAPSHOT_ID,
    workerSessionId: WORKER_SESSION_ID,
    observedAtMs: 1_750_000_000_001,
    response,
  });
}

describe("account status snapshot", () => {
  it("projects signed-out and auth-free states without retaining a raw account", () => {
    expect(snapshot({ account: null, requiresOpenaiAuth: true })).toMatchObject({
      status: "authentication_required",
      credentialKind: null,
      planType: null,
    });
    expect(snapshot({ account: null, requiresOpenaiAuth: false })).toMatchObject({
      status: "not_required",
      credentialKind: null,
      planType: null,
    });
  });

  it("projects each fixed credential kind and every known ChatGPT plan", () => {
    expect(snapshot({ account: { type: "apiKey" }, requiresOpenaiAuth: true })).toMatchObject({
      status: "authenticated",
      credentialKind: "api_key",
      planType: null,
    });
    expect(
      snapshot({ account: { type: "amazonBedrock" }, requiresOpenaiAuth: false }),
    ).toMatchObject({
      status: "authenticated",
      credentialKind: "amazon_bedrock",
      planType: null,
    });
    for (const planType of ACCOUNT_PLAN_TYPES) {
      expect(
        snapshot({ account: { type: "chatgpt", planType }, requiresOpenaiAuth: true }),
      ).toMatchObject({
        status: "authenticated",
        credentialKind: "chatgpt",
        planType,
      });
    }
  });

  it("creates and decodes exact frozen snapshots", () => {
    const created = snapshot({
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    const decoded = decodeAccountStatusSnapshot(structuredClone(created));

    expect(decoded).toEqual(created);
    expect(decoded).not.toBe(created);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it("rejects raw PII, unknown fields, semantic contradictions, and invalid freshness", () => {
    const invalid = [
      {
        schemaVersion: 1,
        snapshotId: SNAPSHOT_ID,
        workerSessionId: WORKER_SESSION_ID,
        observedAtMs: 1,
        response: {
          account: { type: "chatgpt", planType: "plus", email: "private@example.com" },
          requiresOpenaiAuth: true,
        },
      },
      {
        schemaVersion: 1,
        snapshotId: "invalid",
        workerSessionId: WORKER_SESSION_ID,
        observedAtMs: 1,
        response: { account: null, requiresOpenaiAuth: true },
      },
      {
        schemaVersion: 1,
        snapshotId: SNAPSHOT_ID,
        workerSessionId: WORKER_SESSION_ID,
        observedAtMs: -1,
        response: { account: null, requiresOpenaiAuth: true },
      },
    ];
    for (const candidate of invalid) {
      expect(() => createAccountStatusSnapshot(candidate)).toThrow(AccountStatusError);
    }
    expect(() =>
      decodeAccountStatusSnapshot({
        schemaVersion: 1,
        snapshotId: SNAPSHOT_ID,
        workerSessionId: WORKER_SESSION_ID,
        observedAtMs: 1,
        status: "authenticated",
        credentialKind: null,
        planType: null,
      }),
    ).toThrow(AccountStatusError);
    expect(() =>
      decodeAccountStatusSnapshot({
        schemaVersion: 1,
        snapshotId: SNAPSHOT_ID,
        workerSessionId: WORKER_SESSION_ID,
        observedAtMs: 1,
        status: "authenticated",
        credentialKind: "api_key",
        planType: "plus",
      }),
    ).toThrow(AccountStatusError);
  });
});
