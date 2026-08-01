import { describe, expect, it } from "vitest";

import {
  MODEL_TIERS,
  ModelRoutingConfigurationError,
  normalizeModelRoutingConfiguration,
  resolveModelTier,
} from "./model-routing-config.js";

const REVISION_ID = "00000000-0000-4000-8000-000000000101";

function configuration() {
  return {
    schemaVersion: 1,
    revisionId: REVISION_ID,
    revisionNumber: 7,
    tiers: {
      fast: {
        provider: "provider-fast",
        model: "model-cheap",
        reasoningEffort: "low",
      },
      standard: {
        provider: "provider-standard",
        model: "model-code",
        reasoningEffort: "medium",
      },
      deep: {
        provider: "provider-deep",
        model: "model-advanced",
        reasoningEffort: "high",
      },
    },
  };
}

describe("model routing configuration", () => {
  it("normalizes and deeply freezes all three user-configured tiers", () => {
    const normalized = normalizeModelRoutingConfiguration(configuration());

    expect(normalized).toEqual(configuration());
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.tiers)).toBe(true);
    for (const tier of MODEL_TIERS) {
      expect(Object.isFrozen(normalized.tiers[tier])).toBe(true);
    }
  });

  it("resolves every logical tier to an auditable immutable configuration snapshot", () => {
    const source = configuration();

    expect(MODEL_TIERS.map((tier) => resolveModelTier(source, tier))).toEqual([
      {
        tier: "fast",
        configurationRevisionId: REVISION_ID,
        configurationRevisionNumber: 7,
        provider: "provider-fast",
        model: "model-cheap",
        reasoningEffort: "low",
      },
      {
        tier: "standard",
        configurationRevisionId: REVISION_ID,
        configurationRevisionNumber: 7,
        provider: "provider-standard",
        model: "model-code",
        reasoningEffort: "medium",
      },
      {
        tier: "deep",
        configurationRevisionId: REVISION_ID,
        configurationRevisionNumber: 7,
        provider: "provider-deep",
        model: "model-advanced",
        reasoningEffort: "high",
      },
    ]);
    expect(Object.isFrozen(resolveModelTier(source, "fast"))).toBe(true);
  });

  it("copies caller-owned input and permits the user to map tiers to the same target", () => {
    const source = configuration();
    source.tiers.standard = { ...source.tiers.fast };
    source.tiers.deep = { ...source.tiers.fast };
    const normalized = normalizeModelRoutingConfiguration(source);

    source.tiers.fast.model = "caller-mutated";

    expect(normalized.tiers.fast.model).toBe("model-cheap");
    expect(normalized.tiers.standard).toEqual(normalized.tiers.fast);
    expect(normalized.tiers.deep).toEqual(normalized.tiers.fast);
  });

  it("rejects missing tiers, extra fields, unsupported schema versions, and bad revisions", () => {
    const valid = configuration();
    const missingDeep = { fast: valid.tiers.fast, standard: valid.tiers.standard };
    const invalid = [
      { ...valid, tiers: missingDeep },
      { ...valid, unexpected: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, revisionNumber: 0 },
      { ...valid, revisionId: "not-a-uuid" },
      {
        ...valid,
        tiers: { ...valid.tiers, fast: { ...valid.tiers.fast, unexpected: true } },
      },
    ];

    for (const candidate of invalid) {
      expect(() => normalizeModelRoutingConfiguration(candidate)).toThrowError(
        ModelRoutingConfigurationError,
      );
    }
  });

  it("rejects unsafe identifiers and non-JSON input without exposing their contents", () => {
    const sensitiveModel = " secret-model ";
    const malformed = configuration();
    malformed.tiers.fast.model = sensitiveModel;
    let captured: unknown;
    try {
      normalizeModelRoutingConfiguration(malformed);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "invalid_configuration" });
    expect(String(captured)).not.toContain(sensitiveModel);

    const accessor = configuration() as Record<string, unknown>;
    Object.defineProperty(accessor, "tiers", {
      enumerable: true,
      get: () => configuration().tiers,
    });
    expect(() => normalizeModelRoutingConfiguration(accessor)).toThrowError(
      ModelRoutingConfigurationError,
    );

    const controlCharacter = configuration();
    controlCharacter.tiers.deep.reasoningEffort = "high\nunsafe";
    expect(() => normalizeModelRoutingConfiguration(controlCharacter)).toThrowError(
      ModelRoutingConfigurationError,
    );
  });

  it("enforces App Server-aligned identifier capacities", () => {
    const cases = [
      ["provider", 257],
      ["model", 4097],
      ["reasoningEffort", 129],
    ] as const;

    for (const [field, length] of cases) {
      const candidate = configuration();
      candidate.tiers.fast[field] = "x".repeat(length);
      expect(() => normalizeModelRoutingConfiguration(candidate)).toThrowError(
        ModelRoutingConfigurationError,
      );
    }
  });

  it("rejects unknown logical tiers independently from malformed configuration", () => {
    expect(() => resolveModelTier(configuration(), "premium")).toThrowError(
      expect.objectContaining({ code: "invalid_tier" }),
    );
    expect(() => resolveModelTier({}, "fast")).toThrowError(
      expect.objectContaining({ code: "invalid_configuration" }),
    );
  });
});
