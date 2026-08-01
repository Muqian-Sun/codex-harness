import { describe, expect, it } from "vitest";

import {
  ModelRoutingConfigurationError,
  normalizeModelRoutingConfiguration,
} from "./model-routing-config.js";
import {
  MODEL_ROUTE_POLICY_VERSION,
  ModelRouteClassificationError,
  classifyShadowModelRoute,
  decodeShadowModelRouteDecision,
  normalizeModelRouteFeatures,
  type ModelRouteSafetySignals,
} from "./model-route-classifier.js";

const CONFIGURATION_ID = "00000000-0000-4000-8000-000000000201";

function configuration() {
  return normalizeModelRoutingConfiguration({
    schemaVersion: 1,
    revisionId: CONFIGURATION_ID,
    revisionNumber: 4,
    tiers: {
      fast: { provider: "provider", model: "cheap", reasoningEffort: "low" },
      standard: { provider: "provider", model: "code", reasoningEffort: "medium" },
      deep: { provider: "provider", model: "advanced", reasoningEffort: "high" },
    },
  });
}

function features() {
  return {
    schemaVersion: 1,
    taskKind: "simple",
    complexity: "low",
    scope: "isolated",
    ambiguity: "low",
    estimatedSteps: 1,
    toolBreadth: "none",
    safety: {
      securitySensitive: false,
      dataMigration: false,
      concurrencySensitive: false,
      publicApiChange: false,
      productionImpact: false,
      irreversibleOperation: false,
      permissionBoundaryChange: false,
    },
  };
}

describe("shadow model route classifier", () => {
  it("routes a bounded simple task to the user-configured fast target", () => {
    const decision = classifyShadowModelRoute(features(), configuration());

    expect(decision).toMatchObject({
      schemaVersion: 1,
      mode: "shadow",
      executionAuthorized: false,
      policyVersion: MODEL_ROUTE_POLICY_VERSION,
      candidateTier: "fast",
      safetyFloorTier: "fast",
      selectedTier: "fast",
      candidateReasons: ["task_simple"],
      safetyReasons: [],
      resolvedTarget: {
        tier: "fast",
        configurationRevisionId: CONFIGURATION_ID,
        configurationRevisionNumber: 4,
        model: "cheap",
      },
    });
    expect(decision).not.toHaveProperty("permission");
  });

  it("routes general code changes and ordinary analysis to standard", () => {
    for (const taskKind of ["code_change", "analysis"] as const) {
      const decision = classifyShadowModelRoute({ ...features(), taskKind }, configuration());
      expect(decision.candidateTier).toBe("standard");
      expect(decision.selectedTier).toBe("standard");
      expect(decision.resolvedTarget.model).toBe("code");
    }
  });

  it("routes architecture decisions and systemic diagnosis to deep", () => {
    for (const taskKind of ["architecture", "systemic_diagnosis"] as const) {
      const decision = classifyShadowModelRoute({ ...features(), taskKind }, configuration());
      expect(decision.candidateTier).toBe("deep");
      expect(decision.selectedTier).toBe("deep");
      expect(decision.resolvedTarget.model).toBe("advanced");
    }
  });

  it("upgrades each medium task dimension to at least standard", () => {
    const cases = [
      { complexity: "medium", reason: "complexity_medium" },
      { scope: "module", reason: "scope_module" },
      { ambiguity: "medium", reason: "ambiguity_medium" },
      { estimatedSteps: 3, reason: "estimated_steps_standard" },
      { toolBreadth: "multiple", reason: "tools_multiple" },
    ] as const;

    for (const { reason, ...override } of cases) {
      const decision = classifyShadowModelRoute({ ...features(), ...override }, configuration());
      expect(decision.candidateTier).toBe("standard");
      expect(decision.candidateReasons).toContain(reason);
    }
  });

  it("upgrades each high task dimension to deep", () => {
    const cases = [
      { complexity: "high", reason: "complexity_high" },
      { scope: "cross_system", reason: "scope_cross_system" },
      { ambiguity: "high", reason: "ambiguity_high" },
      { estimatedSteps: 9, reason: "estimated_steps_deep" },
      { toolBreadth: "extensive", reason: "tools_extensive" },
    ] as const;

    for (const { reason, ...override } of cases) {
      const decision = classifyShadowModelRoute({ ...features(), ...override }, configuration());
      expect(decision.candidateTier).toBe("deep");
      expect(decision.candidateReasons).toContain(reason);
    }
  });

  it("applies a deep safety floor for every deterministic risk signal", () => {
    const cases = [
      ["securitySensitive", "risk_security_sensitive"],
      ["dataMigration", "risk_data_migration"],
      ["concurrencySensitive", "risk_concurrency_sensitive"],
      ["publicApiChange", "risk_public_api_change"],
      ["productionImpact", "risk_production_impact"],
      ["irreversibleOperation", "risk_irreversible_operation"],
      ["permissionBoundaryChange", "risk_permission_boundary_change"],
    ] as const;

    for (const [signal, reason] of cases) {
      const source = features();
      source.safety[signal] = true;
      const decision = classifyShadowModelRoute(source, configuration());
      expect(decision.candidateTier).toBe("fast");
      expect(decision.safetyFloorTier).toBe("deep");
      expect(decision.selectedTier).toBe("deep");
      expect(decision.safetyReasons).toEqual([reason]);
      expect(decision.resolvedTarget.model).toBe("advanced");
    }
  });

  it("records simultaneous safety reasons in a stable policy-defined order", () => {
    const source = features();
    source.safety.permissionBoundaryChange = true;
    source.safety.securitySensitive = true;
    source.safety.productionImpact = true;

    expect(classifyShadowModelRoute(source, configuration()).safetyReasons).toEqual([
      "risk_security_sensitive",
      "risk_production_impact",
      "risk_permission_boundary_change",
    ]);
  });

  it("produces deterministic deeply frozen snapshots isolated from caller mutation", () => {
    const source = features();
    const first = classifyShadowModelRoute(source, configuration());
    const second = classifyShadowModelRoute(source, configuration());

    source.taskKind = "architecture";
    source.safety.securitySensitive = true;

    expect(first).toEqual(second);
    expect(first.features.taskKind).toBe("simple");
    expect(first.features.safety.securitySensitive).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.features)).toBe(true);
    expect(Object.isFrozen(first.features.safety)).toBe(true);
    expect(Object.isFrozen(first.candidateReasons)).toBe(true);
    expect(Object.isFrozen(first.safetyReasons)).toBe(true);
    expect(Object.isFrozen(first.resolvedTarget)).toBe(true);
  });

  it("strictly decodes only decisions reproducible by the pinned routing policy", () => {
    const decision = classifyShadowModelRoute(features(), configuration());
    expect(decodeShadowModelRouteDecision(decision)).toEqual(decision);

    const invalid = [
      { ...decision, unexpected: true },
      { ...decision, mode: "active" },
      { ...decision, executionAuthorized: true },
      { ...decision, selectedTier: "deep" },
      { ...decision, candidateReasons: ["task_analysis"] },
      { ...decision, policyVersion: "model-route-policy-v2" },
      { ...decision, resolvedTarget: { ...decision.resolvedTarget, tier: "standard" } },
      { ...decision, resolvedTarget: { ...decision.resolvedTarget, model: " invalid " } },
    ];
    for (const candidate of invalid) {
      expect(() => decodeShadowModelRouteDecision(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_decision" }),
      );
    }
  });

  it("strictly rejects malformed, incomplete, accessor-backed, and oversized features", () => {
    const valid = features();
    const invalid = [
      { ...valid, unexpected: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, taskKind: "unknown" },
      { ...valid, complexity: "extreme" },
      { ...valid, scope: "global" },
      { ...valid, ambiguity: "unknown" },
      { ...valid, estimatedSteps: 0 },
      { ...valid, estimatedSteps: 10_001 },
      { ...valid, toolBreadth: "all" },
      {
        ...valid,
        safety: {
          securitySensitive: false,
          dataMigration: false,
          concurrencySensitive: false,
          publicApiChange: false,
          productionImpact: false,
          irreversibleOperation: false,
        },
      },
    ];

    for (const candidate of invalid) {
      expect(() => normalizeModelRouteFeatures(candidate)).toThrowError(
        ModelRouteClassificationError,
      );
    }

    const accessor = features() as Record<string, unknown>;
    Object.defineProperty(accessor, "taskKind", { enumerable: true, get: () => "simple" });
    expect(() => normalizeModelRouteFeatures(accessor)).toThrowError(ModelRouteClassificationError);
  });

  it("keeps configuration failures distinct from feature classification failures", () => {
    expect(() => classifyShadowModelRoute(features(), {} as never)).toThrowError(
      ModelRoutingConfigurationError,
    );
    expect(() => classifyShadowModelRoute({}, configuration())).toThrowError(
      ModelRouteClassificationError,
    );
  });

  it("requires every safety signal to be boolean", () => {
    const source = features();
    const malformed = { ...source, safety: { ...source.safety } } as {
      safety: Record<keyof ModelRouteSafetySignals, unknown>;
    } & Omit<ReturnType<typeof features>, "safety">;
    malformed.safety.securitySensitive = "false";
    expect(() => normalizeModelRouteFeatures(malformed)).toThrowError(
      ModelRouteClassificationError,
    );
  });
});
