import { describe, expect, it } from "vitest";

import type { ModelRoutingConfiguration } from "./model-routing-config.js";
import {
  ModelCatalogError,
  assessModelRoutingAvailability,
  createModelCatalogSnapshot,
} from "./model-catalog.js";

const SNAPSHOT_OPENAI = "00000000-0000-4000-8000-000000000501";
const SNAPSHOT_REMOTE = "00000000-0000-4000-8000-000000000502";
const WORKER_OPENAI = "00000000-0000-4000-8000-000000000511";
const WORKER_REMOTE = "00000000-0000-4000-8000-000000000512";
const CONFIGURATION_ID = "00000000-0000-4000-8000-000000000521";

function model(
  name: string,
  efforts: readonly string[] = ["low", "medium", "high"],
  inputModalities: readonly string[] | undefined = ["text", "image"],
) {
  return {
    id: `id-${name}`,
    model: name,
    displayName: name.toUpperCase(),
    description: "Catalog metadata is tolerated but not trusted for availability.",
    hidden: false,
    defaultReasoningEffort: efforts[0],
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    supportsPersonality: true,
  };
}

function snapshotInput(
  provider = "openai",
  snapshotId = SNAPSHOT_OPENAI,
  workerSessionId = WORKER_OPENAI,
) {
  return {
    schemaVersion: 1,
    snapshotId,
    workerSessionId,
    provider,
    observedAtMs: 1_750_000_000_100,
    pages: [
      {
        requestCursor: null,
        includeHidden: true,
        response: {
          data: [model("standard", ["medium", "low"])],
          nextCursor: "page-2",
        },
      },
      {
        requestCursor: "page-2",
        includeHidden: true,
        response: {
          data: [
            model("fast", ["low"], undefined),
            model("deep", ["high"]),
            model("Ä-model", ["low"]),
            model("Z-model", ["low"]),
          ],
          nextCursor: null,
        },
      },
    ],
  };
}

function configuration(): ModelRoutingConfiguration {
  return {
    schemaVersion: 1,
    revisionId: CONFIGURATION_ID,
    revisionNumber: 3,
    tiers: {
      fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
      standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
      deep: { provider: "remote", model: "deep", reasoningEffort: "high" },
    },
  };
}

describe("model catalog snapshot", () => {
  it("closes all pages, normalizes order, and applies the older-catalog modality default", () => {
    const input = snapshotInput();
    const snapshot = createModelCatalogSnapshot(input);
    input.pages[1]!.response.data[0]!.hidden = true;

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      snapshotId: SNAPSHOT_OPENAI,
      workerSessionId: WORKER_OPENAI,
      provider: "openai",
      includeHidden: true,
      complete: true,
    });
    expect(snapshot.models.map((entry) => entry.model)).toEqual([
      "Z-model",
      "deep",
      "fast",
      "standard",
      "Ä-model",
    ]);
    expect(snapshot.models[2]?.inputModalities).toEqual(["image", "text"]);
    expect(snapshot.models[2]?.hidden).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.models)).toBe(true);
    expect(Object.isFrozen(snapshot.models[0])).toBe(true);
    expect(Object.isFrozen(snapshot.models[0]?.supportedReasoningEfforts)).toBe(true);
  });

  it("reports all configured tiers as observed without authorizing execution", () => {
    const openai = createModelCatalogSnapshot(snapshotInput());
    const remoteInput = {
      ...snapshotInput("remote", SNAPSHOT_REMOTE, WORKER_REMOTE),
      pages: [
        {
          requestCursor: null,
          includeHidden: true,
          response: { data: [model("deep", ["high"])], nextCursor: null },
        },
      ],
    };
    const assessment = assessModelRoutingAvailability(configuration(), [
      openai,
      createModelCatalogSnapshot(remoteInput),
    ]);

    expect(assessment).toMatchObject({
      configurationRevisionId: CONFIGURATION_ID,
      configurationRevisionNumber: 3,
      allObservedAvailable: true,
      executionAuthorized: false,
      tiers: {
        fast: { status: "observed_available", snapshotId: SNAPSHOT_OPENAI, modelId: "id-fast" },
        standard: {
          status: "observed_available",
          snapshotId: SNAPSHOT_OPENAI,
          modelId: "id-standard",
        },
        deep: { status: "observed_available", snapshotId: SNAPSHOT_REMOTE, modelId: "id-deep" },
      },
    });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.tiers)).toBe(true);
  });

  it("distinguishes an unobserved provider, missing model, and unsupported effort", () => {
    const config = configuration();
    const assessment = assessModelRoutingAvailability(
      {
        ...config,
        tiers: {
          fast: { provider: "missing", model: "fast", reasoningEffort: "low" },
          standard: { provider: "openai", model: "absent", reasoningEffort: "medium" },
          deep: { provider: "openai", model: "deep", reasoningEffort: "xhigh" },
        },
      },
      [createModelCatalogSnapshot(snapshotInput())],
    );

    expect(assessment.allObservedAvailable).toBe(false);
    expect(assessment.tiers.fast).toMatchObject({
      status: "provider_unobserved",
      snapshotId: null,
      observedAtMs: null,
    });
    expect(assessment.tiers.standard).toMatchObject({
      status: "model_unavailable",
      snapshotId: SNAPSHOT_OPENAI,
      modelId: null,
    });
    expect(assessment.tiers.deep).toMatchObject({
      status: "reasoning_effort_unsupported",
      modelId: "id-deep",
      supportedReasoningEfforts: ["high"],
    });
  });

  it("rejects incomplete, discontinuous, repeated, and picker-only pagination", () => {
    const input = snapshotInput();
    const invalid = [
      { ...input, pages: [{ ...input.pages[0], requestCursor: "not-first" }] },
      { ...input, pages: [input.pages[0]] },
      {
        ...input,
        pages: [input.pages[0], { ...input.pages[1], requestCursor: "wrong" }],
      },
      {
        ...input,
        pages: [
          input.pages[0],
          {
            ...input.pages[1],
            response: { ...input.pages[1]?.response, nextCursor: "page-2" },
          },
        ],
      },
      {
        ...input,
        pages: [{ ...input.pages[0], includeHidden: false }, input.pages[1]],
      },
    ];
    for (const candidate of invalid) {
      expect(() => createModelCatalogSnapshot(candidate)).toThrowError(
        expect.objectContaining({ code: "invalid_catalog" }),
      );
    }
  });

  it("rejects duplicate identities, model names, efforts, modalities, and unsupported defaults", () => {
    const base = snapshotInput();
    const invalidModels = [
      [model("same"), { ...model("other"), id: "id-same" }],
      [model("same"), { ...model("same"), id: "other-id" }],
      [model("duplicate-effort", ["low", "low"])],
      [model("duplicate-modality", ["low"], ["text", "text"])],
      [{ ...model("bad-default", ["low"]), defaultReasoningEffort: "high" }],
      [
        model(
          "too-many-efforts",
          Array.from({ length: 65 }, (_, index) => `effort-${String(index)}`),
        ),
      ],
    ];
    for (const data of invalidModels) {
      expect(() =>
        createModelCatalogSnapshot({
          ...base,
          pages: [
            {
              requestCursor: null,
              includeHidden: true,
              response: { data, nextCursor: null },
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_catalog" }));
    }
  });

  it("accepts only in-process snapshots produced by complete pagination validation", () => {
    const snapshot = createModelCatalogSnapshot(snapshotInput());
    const cloned = JSON.parse(JSON.stringify(snapshot)) as unknown;
    expect(() => assessModelRoutingAvailability(configuration(), [cloned])).toThrowError(
      expect.objectContaining({ code: "invalid_catalog" }),
    );
    expect(() =>
      assessModelRoutingAvailability(configuration(), [{ ...snapshot, complete: false }]),
    ).toThrowError(expect.objectContaining({ code: "invalid_catalog" }));
  });

  it("rejects malformed JSON inputs, bounded-resource violations, and duplicate providers", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get() {
        throw new Error("must not escape validation");
      },
    });
    const tooManyPages = Array.from({ length: 129 }, () => snapshotInput().pages[0]);
    for (const candidate of [
      accessor,
      { ...snapshotInput(), unexpected: true },
      { ...snapshotInput(), snapshotId: "bad" },
      { ...snapshotInput(), pages: tooManyPages },
    ]) {
      expect(() => createModelCatalogSnapshot(candidate)).toThrowError(ModelCatalogError);
    }

    const snapshot = createModelCatalogSnapshot(snapshotInput());
    expect(() =>
      assessModelRoutingAvailability(configuration(), [snapshot, snapshot]),
    ).toThrowError(expect.objectContaining({ code: "ambiguous_provider" }));
    const sparseSnapshots = new Array(1) as unknown[];
    expect(() => assessModelRoutingAvailability(configuration(), sparseSnapshots)).toThrowError(
      expect.objectContaining({ code: "invalid_catalog" }),
    );
    expect(() => assessModelRoutingAvailability({ bad: true }, [])).toThrowError(
      expect.objectContaining({ code: "invalid_configuration" }),
    );
  });
});
