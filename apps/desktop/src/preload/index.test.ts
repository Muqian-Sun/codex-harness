import Module from "node:module";

import { describe, expect, it, vi } from "vitest";

const PROJECT_ID = "00000000-0000-4000-8000-000000000891";

const harness = vi.hoisted(() => ({
  api: undefined as unknown,
  invoke: vi.fn(),
}));

const electron = {
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, api: unknown) => {
      harness.api = api;
    }),
  },
  ipcRenderer: {
    invoke: harness.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
};

type ExposedApi = Readonly<{
  getBootstrapState(): Promise<unknown>;
  bindProjectToDefaultRouting(projectId: string): Promise<unknown>;
}>;

function readyState(binding: unknown): unknown {
  return {
    phase: "ready",
    account: { status: "not_required", credentialKind: null, planType: null },
    catalog: {
      provider: "openai",
      totalVisibleModels: 0,
      models: [],
      hasMore: false,
    },
    routing: {
      configured: false,
      profileVersion: 0,
      configurationRevisionId: null,
      tiers: null,
      availability: null,
    },
    projects: {
      projects: [
        {
          projectId: PROJECT_ID,
          projectVersion: 1,
          displayName: "workspace",
          workspace: {
            platform: "macos",
            absolutePath: "/Users/example/workspace",
            identityStatus: "unverified",
          },
        },
      ],
      hasMore: false,
    },
    projectRoutingBindings: { bindings: [binding] },
  };
}

describe("desktop preload Project routing binding boundary", () => {
  it("strictly decodes bootstrap bindings and the minimal mutation API", async () => {
    const moduleLoader = Module as unknown as {
      _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = (request, parent, isMain) =>
      request === "electron" ? electron : originalLoad(request, parent, isMain);
    try {
      await import("./index.cjs");
    } finally {
      moduleLoader._load = originalLoad;
    }
    const api = harness.api as ExposedApi;
    expect(api).toBeDefined();

    harness.invoke.mockResolvedValueOnce(
      readyState({ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }),
    );
    await expect(api.getBootstrapState()).resolves.toMatchObject({
      phase: "ready",
      projectRoutingBindings: {
        bindings: [{ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }],
      },
    });

    harness.invoke.mockResolvedValueOnce(
      readyState({ projectId: PROJECT_ID, status: "default_bound", bindingVersion: 1 }),
    );
    await expect(api.getBootstrapState()).resolves.toMatchObject({
      projectRoutingBindings: { bindings: [{ status: "default_bound", bindingVersion: 1 }] },
    });

    for (const invalidBinding of [
      { projectId: PROJECT_ID, status: "unbound", bindingVersion: 1 },
      { projectId: PROJECT_ID, status: "default_bound", bindingVersion: null },
      {
        projectId: "00000000-0000-4000-8000-000000000892",
        status: "unbound",
        bindingVersion: null,
      },
    ]) {
      harness.invoke.mockResolvedValueOnce(readyState(invalidBinding));
      await expect(api.getBootstrapState()).rejects.toThrow("bootstrap state is invalid");
    }
    harness.invoke.mockResolvedValueOnce({
      ...(readyState({ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }) as object),
      projectRoutingBindings: { bindings: [] },
    });
    await expect(api.getBootstrapState()).rejects.toThrow("bootstrap state is invalid");

    await expect(api.bindProjectToDefaultRouting("invalid")).rejects.toThrow(
      "valid desktop Project identifier",
    );
    for (const status of [
      "bound",
      "existing",
      "conflict",
      "routing_unconfigured",
      "unavailable",
    ] as const) {
      harness.invoke.mockResolvedValueOnce({ status });
      await expect(api.bindProjectToDefaultRouting(PROJECT_ID)).resolves.toEqual({ status });
    }
    harness.invoke.mockResolvedValueOnce({ status: "unexpected" });
    await expect(api.bindProjectToDefaultRouting(PROJECT_ID)).rejects.toThrow(
      "routing binding result is invalid",
    );
  });
});
