import {
  APPLICATION_PROTOCOL_VERSION,
  BOOTSTRAP_WIRE_VERSION,
  RPC_ERROR_CODES,
  type RpcRequest,
} from "@codex-harness/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  RpcProviderError,
  dispatchRpcRequest,
  dispatchRpcRequestAsync,
  type RpcDispatchContext,
} from "./rpc-dispatcher.js";

const ACCOUNT_STATUS = Object.freeze({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000811",
  workerSessionId: "00000000-0000-4000-8000-000000000812",
  observedAtMs: 1_750_000_000_001,
  status: "authenticated",
  credentialKind: "chatgpt",
  planType: "plus",
});

const MODEL_CATALOG_PAGE = Object.freeze({
  schemaVersion: 1,
  provider: "openai",
  totalVisibleModels: 1,
  models: Object.freeze([
    Object.freeze({
      model: "gpt-model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium"]),
      inputModalities: Object.freeze(["text"]),
    }),
  ]),
  nextCursor: null,
});

const ROUTING_CONFIGURATION = Object.freeze({
  schemaVersion: 1,
  configured: false,
  profileVersion: 0,
  configurationRevisionId: null,
  tiers: null,
  availability: null,
});

const PROJECT = Object.freeze({
  projectId: "00000000-0000-4000-8000-000000000861",
  projectVersion: 1,
  displayName: "workspace",
  workspace: Object.freeze({
    platform: "macos",
    absolutePath: "/Users/example/workspace",
    identityStatus: "unverified",
  }),
});

const PROJECT_CATALOG_PAGE = Object.freeze({
  schemaVersion: 1,
  projects: Object.freeze([PROJECT]),
  nextCursor: null,
});

const PROJECT_REGISTRATION = Object.freeze({
  schemaVersion: 1,
  status: "registered",
  project: PROJECT,
});

const PROJECT_ROUTING_BINDING = Object.freeze({
  projectId: PROJECT.projectId,
  bindingVersion: 1,
  profileId: "00000000-0000-4000-8000-000000000901",
  profileVersionAtBinding: 1,
  configurationRevisionIdAtBinding: "00000000-0000-4000-8000-000000000851",
});

const PROJECT_ROUTING_BINDING_STATUSES = Object.freeze({
  schemaVersion: 1,
  statuses: Object.freeze([
    Object.freeze({
      projectId: PROJECT.projectId,
      status: "default_bound",
      binding: PROJECT_ROUTING_BINDING,
    }),
  ]),
});

const PROJECT_ROUTING_BIND_RESULT = Object.freeze({
  schemaVersion: 1,
  status: "bound",
  binding: PROJECT_ROUTING_BINDING,
});

const PROJECT_TASK_CATALOG = Object.freeze({
  schemaVersion: 1,
  tasks: Object.freeze([]),
  nextCursor: null,
});

const PROJECT_TASK_CREATED = Object.freeze({
  schemaVersion: 1,
  status: "created",
  taskId: "00000000-0000-4000-8000-000000000913",
});

const PROJECT_TASK_DETAIL = Object.freeze({
  schemaVersion: 1,
  projectId: PROJECT.projectId,
  ownershipVersion: 1,
  taskId: PROJECT_TASK_CREATED.taskId,
  taskVersion: 1,
  title: "Persist Task",
  stage: "requirements_only",
  activeRequirement: Object.freeze({
    revisionId: "00000000-0000-4000-8000-000000000911",
    revisionNumber: 1,
    sourceText: "Persist the requirement without execution.",
    objective: "Persist the requirement without execution.",
    constraints: Object.freeze([]),
    acceptanceCriteria: Object.freeze([]),
  }),
  latestPlanRevisionId: null,
  candidatePlan: null,
  confirmedPlan: null,
  activeGraph: null,
});

const PROJECT_TASK_REVISED = Object.freeze({
  schemaVersion: 1,
  status: "revised",
  taskId: PROJECT_TASK_CREATED.taskId,
});

function request(method: string, params: unknown = {}): RpcRequest {
  return {
    kind: "request",
    wireVersion: BOOTSTRAP_WIRE_VERSION,
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    id: "request-1",
    method,
    params,
  } as RpcRequest;
}

function context(
  readAccountStatus: () => unknown,
  readModelCatalogPage: (params: unknown) => unknown = () => MODEL_CATALOG_PAGE,
): RpcDispatchContext {
  return {
    streamId: `${"A".repeat(21)}A`,
    uptimeMs: 1,
    closing: false,
    readAccountStatus,
    readModelCatalogPage,
    readProjectCatalogPage: () => PROJECT_CATALOG_PAGE,
    registerProject: () => PROJECT_REGISTRATION,
    readProjectRoutingBindingStatuses: () => PROJECT_ROUTING_BINDING_STATUSES,
    bindProjectDefaultRouting: () => PROJECT_ROUTING_BIND_RESULT,
    readProjectTaskCatalogPage: () => PROJECT_TASK_CATALOG,
    createProjectTask: () => PROJECT_TASK_CREATED,
    readProjectTaskDetail: () => PROJECT_TASK_DETAIL,
    reviseProjectTaskRequirement: () => PROJECT_TASK_REVISED,
    confirmProjectTaskCandidatePlan: () => ({
      schemaVersion: 1,
      status: "confirmed",
      taskId: PROJECT_TASK_DETAIL.taskId,
    }),
    materializeProjectTaskGraph: () => ({
      schemaVersion: 1,
      status: "materialized",
      taskId: PROJECT_TASK_DETAIL.taskId,
    }),
    readRoutingConfiguration: () => ROUTING_CONFIGURATION,
    setRoutingConfiguration: () => ROUTING_CONFIGURATION,
  };
}

describe("RPC dispatcher account status", () => {
  it("returns an exact validated snapshot only for the account method", () => {
    const readAccountStatus = vi.fn(() => ACCOUNT_STATUS);
    const dispatched = dispatchRpcRequest(request("account.status"), context(readAccountStatus));

    expect(dispatched).toMatchObject({
      envelope: { kind: "response", id: "request-1", result: ACCOUNT_STATUS },
      shutdownRequested: false,
    });
    expect(readAccountStatus).toHaveBeenCalledTimes(1);

    dispatchRpcRequest(request("system.health"), context(readAccountStatus));
    expect(readAccountStatus).toHaveBeenCalledTimes(1);
  });

  it("returns a stable unavailable error for absent, invalid, or throwing providers", () => {
    for (const readAccountStatus of [
      () => null,
      () => ({ ...ACCOUNT_STATUS, email: "private@example.com" }),
      () => {
        throw new Error("private provider detail");
      },
    ]) {
      const dispatched = dispatchRpcRequest(request("account.status"), context(readAccountStatus));
      expect(dispatched.envelope).toMatchObject({
        kind: "error",
        id: "request-1",
        error: {
          code: RPC_ERROR_CODES.unavailable,
          message: "The account status is unavailable.",
        },
      });
      expect(JSON.stringify(dispatched)).not.toContain("private");
    }
  });

  it("does not consult the provider while the connection is closing", () => {
    const readAccountStatus = vi.fn(() => ACCOUNT_STATUS);
    const dispatched = dispatchRpcRequest(request("account.status"), {
      ...context(readAccountStatus),
      closing: true,
    });

    expect(dispatched.envelope).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.unavailable },
    });
    expect(readAccountStatus).not.toHaveBeenCalled();
  });
});

describe("RPC dispatcher model catalog", () => {
  it("passes validated page parameters to the provider and validates the result", () => {
    const readModelCatalogPage = vi.fn(() => MODEL_CATALOG_PAGE);
    const params = { cursor: null, limit: 12 };
    const dispatched = dispatchRpcRequest(
      request("model.catalog_page", params),
      context(() => ACCOUNT_STATUS, readModelCatalogPage),
    );

    expect(dispatched).toMatchObject({
      envelope: { kind: "response", id: "request-1", result: MODEL_CATALOG_PAGE },
      shutdownRequested: false,
    });
    expect(readModelCatalogPage).toHaveBeenCalledWith(params);
  });

  it("returns a fixed unavailable error for an invalid or throwing catalog provider", () => {
    for (const readModelCatalogPage of [
      () => ({ ...MODEL_CATALOG_PAGE, internalModelId: "private-id" }),
      () => {
        throw new Error("private catalog detail");
      },
    ]) {
      const dispatched = dispatchRpcRequest(
        request("model.catalog_page", { cursor: null, limit: 12 }),
        context(() => ACCOUNT_STATUS, readModelCatalogPage),
      );
      expect(dispatched.envelope).toMatchObject({
        kind: "error",
        id: "request-1",
        error: {
          code: RPC_ERROR_CODES.unavailable,
          message: "The model catalog is unavailable.",
        },
      });
      expect(JSON.stringify(dispatched)).not.toContain("private");
    }
  });

  it("rejects invalid parameters before consulting the catalog provider", () => {
    const readModelCatalogPage = vi.fn(() => MODEL_CATALOG_PAGE);
    const dispatched = dispatchRpcRequest(
      request("model.catalog_page", { cursor: null, limit: 17 }),
      context(() => ACCOUNT_STATUS, readModelCatalogPage),
    );

    expect(dispatched.envelope).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.invalidParams },
    });
    expect(readModelCatalogPage).not.toHaveBeenCalled();
  });
});

describe("RPC dispatcher routing configuration", () => {
  it("serves validated reads and passes validated writes to the provider", () => {
    const readRoutingConfiguration = vi.fn(() => ROUTING_CONFIGURATION);
    const configured = {
      schemaVersion: 1,
      configured: true,
      profileVersion: 1,
      configurationRevisionId: "00000000-0000-4000-8000-000000000851",
      tiers: {
        fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
        standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
      },
      availability: {
        fast: "observed_available",
        standard: "observed_available",
        deep: "observed_available",
      },
    } as const;
    const setRoutingConfiguration = vi.fn(() => configured);
    const routingContext = {
      ...context(() => ACCOUNT_STATUS),
      readRoutingConfiguration,
      setRoutingConfiguration,
    };

    expect(
      dispatchRpcRequest(request("routing.configuration.get"), routingContext).envelope,
    ).toMatchObject({ kind: "response", result: ROUTING_CONFIGURATION });
    const params = {
      commandId: configured.configurationRevisionId,
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: configured.tiers,
    };
    expect(
      dispatchRpcRequest(request("routing.configuration.set", params), routingContext).envelope,
    ).toMatchObject({ kind: "response", result: configured });
    expect(setRoutingConfiguration).toHaveBeenCalledWith(params);
  });

  it("maps stale writes to a fixed conflict and all other provider failures to unavailable", () => {
    const base = context(() => ACCOUNT_STATUS);
    const params = {
      commandId: "00000000-0000-4000-8000-000000000851",
      expectedProfileVersion: 0,
      previousConfigurationRevisionId: null,
      tiers: {
        fast: { provider: "openai", model: "fast", reasoningEffort: "low" },
        standard: { provider: "openai", model: "standard", reasoningEffort: "medium" },
        deep: { provider: "openai", model: "deep", reasoningEffort: "high" },
      },
    };
    const conflict = dispatchRpcRequest(request("routing.configuration.set", params), {
      ...base,
      setRoutingConfiguration: () => {
        throw new RpcProviderError("conflict");
      },
    });
    expect(conflict.envelope).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.conflict, message: "The routing configuration changed." },
    });

    for (const routingContext of [
      { ...base, readRoutingConfiguration: () => ({ private: "detail" }) },
      {
        ...base,
        setRoutingConfiguration: () => {
          throw new Error("private detail");
        },
      },
    ]) {
      const method =
        routingContext.readRoutingConfiguration === base.readRoutingConfiguration
          ? "routing.configuration.set"
          : "routing.configuration.get";
      const dispatched = dispatchRpcRequest(
        request(method, method.endsWith("set") ? params : {}),
        routingContext,
      );
      expect(dispatched.envelope).toMatchObject({
        kind: "error",
        error: { code: RPC_ERROR_CODES.unavailable },
      });
      expect(JSON.stringify(dispatched)).not.toContain("private");
    }
  });

  it("rejects malformed writes before consulting the provider", () => {
    const setRoutingConfiguration = vi.fn(() => ROUTING_CONFIGURATION);
    const dispatched = dispatchRpcRequest(
      request("routing.configuration.set", { expectedProfileVersion: 0 }),
      { ...context(() => ACCOUNT_STATUS), setRoutingConfiguration },
    );
    expect(dispatched.envelope).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.invalidParams },
    });
    expect(setRoutingConfiguration).not.toHaveBeenCalled();
  });
});

describe("RPC dispatcher Project registry", () => {
  it("passes validated catalog and registration parameters to their providers", () => {
    const readProjectCatalogPage = vi.fn(() => PROJECT_CATALOG_PAGE);
    const registerProject = vi.fn(() => PROJECT_REGISTRATION);
    const catalogParams = { cursor: null, limit: 12 };
    const registerParams = {
      commandId: "00000000-0000-4000-8000-000000000862",
      projectId: PROJECT.projectId,
      displayName: PROJECT.displayName,
      workspace: {
        platform: PROJECT.workspace.platform,
        absolutePath: PROJECT.workspace.absolutePath,
      },
    };
    const base = context(() => ACCOUNT_STATUS);

    expect(
      dispatchRpcRequest(request("project.catalog_page", catalogParams), {
        ...base,
        readProjectCatalogPage,
      }),
    ).toMatchObject({ envelope: { kind: "response", result: PROJECT_CATALOG_PAGE } });
    expect(readProjectCatalogPage).toHaveBeenCalledWith(catalogParams);

    expect(
      dispatchRpcRequest(request("project.register", registerParams), {
        ...base,
        registerProject,
      }),
    ).toMatchObject({ envelope: { kind: "response", result: PROJECT_REGISTRATION } });
    expect(registerProject).toHaveBeenCalledWith(registerParams);
  });

  it("validates Project parameters and results and maps provider failures without path leaks", () => {
    const readProjectCatalogPage = vi.fn(() => PROJECT_CATALOG_PAGE);
    const registerProject = vi.fn(() => PROJECT_REGISTRATION);
    const base = context(() => ACCOUNT_STATUS);

    expect(
      dispatchRpcRequest(request("project.catalog_page", { cursor: null, limit: 13 }), {
        ...base,
        readProjectCatalogPage,
      }).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(readProjectCatalogPage).not.toHaveBeenCalled();

    for (const candidate of [
      { ...base, readProjectCatalogPage: () => ({ ...PROJECT_CATALOG_PAGE, private: true }) },
      {
        ...base,
        registerProject: () => {
          throw new RpcProviderError("conflict");
        },
      },
      {
        ...base,
        registerProject: () => {
          throw new Error("/private/secret/path");
        },
      },
    ]) {
      const method =
        candidate.readProjectCatalogPage === base.readProjectCatalogPage
          ? "project.register"
          : "project.catalog_page";
      const params =
        method === "project.catalog_page"
          ? { cursor: null, limit: 12 }
          : {
              commandId: "00000000-0000-4000-8000-000000000862",
              projectId: PROJECT.projectId,
              displayName: PROJECT.displayName,
              workspace: { platform: "macos", absolutePath: "/Users/example/workspace" },
            };
      const dispatched = dispatchRpcRequest(request(method, params), candidate);
      expect(dispatched.envelope).toMatchObject({ kind: "error" });
      expect(JSON.stringify(dispatched)).not.toContain("private");
      expect(JSON.stringify(dispatched)).not.toContain("secret");
    }

    expect(registerProject).not.toHaveBeenCalled();
  });
});

describe("RPC dispatcher Project routing binding", () => {
  const statusParams = { projectIds: [PROJECT.projectId] };
  const bindParams = {
    commandId: "00000000-0000-4000-8000-000000000862",
    projectId: PROJECT.projectId,
    expectedBindingVersion: 0,
    previousProfileId: null,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: "00000000-0000-4000-8000-000000000851",
  };

  it("passes validated status and binding inputs to their providers", () => {
    const readProjectRoutingBindingStatuses = vi.fn(() => PROJECT_ROUTING_BINDING_STATUSES);
    const bindProjectDefaultRouting = vi.fn(() => PROJECT_ROUTING_BIND_RESULT);
    const base = context(() => ACCOUNT_STATUS);

    expect(
      dispatchRpcRequest(request("project.routing_binding.status_batch", statusParams), {
        ...base,
        readProjectRoutingBindingStatuses,
      }).envelope,
    ).toMatchObject({ kind: "response", result: PROJECT_ROUTING_BINDING_STATUSES });
    expect(readProjectRoutingBindingStatuses).toHaveBeenCalledWith(statusParams);

    expect(
      dispatchRpcRequest(request("project.routing_binding.bind_default", bindParams), {
        ...base,
        bindProjectDefaultRouting,
      }).envelope,
    ).toMatchObject({ kind: "response", result: PROJECT_ROUTING_BIND_RESULT });
    expect(bindProjectDefaultRouting).toHaveBeenCalledWith(bindParams);
  });

  it("rejects malformed parameters before consulting providers", () => {
    const readProjectRoutingBindingStatuses = vi.fn(() => PROJECT_ROUTING_BINDING_STATUSES);
    const bindProjectDefaultRouting = vi.fn(() => PROJECT_ROUTING_BIND_RESULT);
    const base = context(() => ACCOUNT_STATUS);

    expect(
      dispatchRpcRequest(
        request("project.routing_binding.status_batch", {
          projectIds: [PROJECT.projectId, PROJECT.projectId],
        }),
        { ...base, readProjectRoutingBindingStatuses },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(readProjectRoutingBindingStatuses).not.toHaveBeenCalled();

    expect(
      dispatchRpcRequest(
        request("project.routing_binding.bind_default", {
          ...bindParams,
          previousProfileId: PROJECT_ROUTING_BINDING.profileId,
        }),
        { ...base, bindProjectDefaultRouting },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(bindProjectDefaultRouting).not.toHaveBeenCalled();
  });

  it("validates provider results and maps failures without leaking details", () => {
    const base = context(() => ACCOUNT_STATUS);
    const statusConflict = dispatchRpcRequest(
      request("project.routing_binding.status_batch", statusParams),
      {
        ...base,
        readProjectRoutingBindingStatuses: () => {
          throw new RpcProviderError("conflict");
        },
      },
    );
    expect(statusConflict.envelope).toMatchObject({
      kind: "error",
      error: {
        code: RPC_ERROR_CODES.conflict,
        message: "The Project routing binding status changed.",
      },
    });

    const conflict = dispatchRpcRequest(
      request("project.routing_binding.bind_default", bindParams),
      {
        ...base,
        bindProjectDefaultRouting: () => {
          throw new RpcProviderError("conflict");
        },
      },
    );
    expect(conflict.envelope).toMatchObject({
      kind: "error",
      error: {
        code: RPC_ERROR_CODES.conflict,
        message: "The Project routing binding changed.",
      },
    });

    for (const candidate of [
      dispatchRpcRequest(request("project.routing_binding.status_batch", statusParams), {
        ...base,
        readProjectRoutingBindingStatuses: () => {
          throw new Error("private storage detail");
        },
      }),
      dispatchRpcRequest(request("project.routing_binding.status_batch", statusParams), {
        ...base,
        readProjectRoutingBindingStatuses: () => ({
          ...PROJECT_ROUTING_BINDING_STATUSES,
          private: true,
        }),
      }),
      dispatchRpcRequest(request("project.routing_binding.bind_default", bindParams), {
        ...base,
        bindProjectDefaultRouting: () => {
          throw new Error("private storage detail");
        },
      }),
    ]) {
      expect(candidate.envelope).toMatchObject({
        kind: "error",
        error: { code: RPC_ERROR_CODES.unavailable },
      });
      expect(JSON.stringify(candidate)).not.toContain("private");
    }
  });
});

describe("RPC dispatcher Project Task methods", () => {
  const catalogParams = { projectId: PROJECT.projectId, cursor: null, limit: 12 };
  const createParams = {
    commandId: "00000000-0000-4000-8000-000000000911",
    ownershipCommandId: "00000000-0000-4000-8000-000000000912",
    taskId: PROJECT_TASK_CREATED.taskId,
    projectId: PROJECT.projectId,
    expectedProjectVersion: 1,
    expectedRoutingBindingVersion: 1,
    title: "Persist Task",
    sourceText: "Persist the requirement without execution.",
  };
  const detailParams = { projectId: PROJECT.projectId, taskId: PROJECT_TASK_CREATED.taskId };
  const reviseParams = {
    commandId: "00000000-0000-4000-8000-000000000914",
    projectId: PROJECT.projectId,
    taskId: PROJECT_TASK_CREATED.taskId,
    expectedTaskVersion: 1,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: PROJECT_TASK_DETAIL.activeRequirement.revisionId,
    sourceText: "Revise the persisted Requirement.",
  };
  const generateParams = {
    commandId: "00000000-0000-4000-8000-000000000915",
    projectId: PROJECT.projectId,
    taskId: PROJECT_TASK_CREATED.taskId,
    expectedProjectVersion: 1,
    expectedTaskVersion: 1,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: PROJECT_TASK_DETAIL.activeRequirement.revisionId,
    previousPlanRevisionId: null,
    expectedRoutingBindingVersion: 1,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: "00000000-0000-4000-8000-000000000916",
  };
  const confirmParams = {
    commandId: "00000000-0000-4000-8000-000000000917",
    projectId: PROJECT.projectId,
    taskId: PROJECT_TASK_CREATED.taskId,
    expectedTaskVersion: 2,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: PROJECT_TASK_DETAIL.activeRequirement.revisionId,
    candidatePlanRevisionId: generateParams.commandId,
  };
  const confirmed = {
    schemaVersion: 1 as const,
    status: "confirmed" as const,
    taskId: PROJECT_TASK_CREATED.taskId,
  };
  const graphParams = {
    commandId: "00000000-0000-4000-8000-000000000918",
    projectId: PROJECT.projectId,
    taskId: PROJECT_TASK_CREATED.taskId,
    expectedTaskVersion: 3,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: PROJECT_TASK_DETAIL.activeRequirement.revisionId,
    confirmedPlanRevisionId: confirmParams.commandId,
    previousGraphRevisionId: null,
  };
  const materialized = {
    schemaVersion: 1 as const,
    status: "materialized" as const,
    taskId: PROJECT_TASK_CREATED.taskId,
  };
  const manifestNodeId = "00000000-0000-4000-8000-000000000919";
  const manifestId = "00000000-0000-4000-8000-00000000091a";
  const generateManifestParams = {
    commandId: "00000000-0000-4000-8000-00000000091b",
    projectId: PROJECT.projectId,
    taskId: PROJECT_TASK_CREATED.taskId,
    nodeId: manifestNodeId,
    expectedProjectVersion: 1,
    expectedTaskVersion: 4,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: PROJECT_TASK_DETAIL.activeRequirement.revisionId,
    confirmedPlanRevisionId: confirmParams.commandId,
    graphRevisionId: graphParams.commandId,
    expectedManifestStateVersion: 0,
    previousManifestId: null,
    expectedRoutingBindingVersion: 1,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: generateParams.expectedConfigurationRevisionId,
  };
  const generatedManifest = {
    schemaVersion: 1 as const,
    status: "generated" as const,
    taskId: PROJECT_TASK_CREATED.taskId,
    nodeId: manifestNodeId,
  };
  const confirmManifestParams = {
    commandId: "00000000-0000-4000-8000-00000000091c",
    projectId: PROJECT.projectId,
    taskId: PROJECT_TASK_CREATED.taskId,
    nodeId: manifestNodeId,
    manifestId,
    expectedTaskVersion: 4,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: PROJECT_TASK_DETAIL.activeRequirement.revisionId,
    confirmedPlanRevisionId: confirmParams.commandId,
    graphRevisionId: graphParams.commandId,
    expectedManifestStateVersion: 1,
  };
  const confirmedManifest = {
    schemaVersion: 1 as const,
    status: "confirmed" as const,
    taskId: PROJECT_TASK_CREATED.taskId,
    nodeId: manifestNodeId,
  };

  it("awaits candidate Plan generation and maps its stable outcomes", async () => {
    const base = context(() => ACCOUNT_STATUS);
    const generated = {
      schemaVersion: 1 as const,
      status: "generated" as const,
      taskId: generateParams.taskId,
    };
    const provider = vi.fn(async () => generated);
    await expect(
      dispatchRpcRequestAsync(request("task.plan.generate_candidate", generateParams), {
        ...base,
        generateProjectTaskCandidatePlan: provider,
      }),
    ).resolves.toMatchObject({ envelope: { kind: "response", result: generated } });
    expect(provider).toHaveBeenCalledWith(generateParams);

    for (const [implementation, expectedCode] of [
      [
        async () => {
          throw new RpcProviderError("conflict");
        },
        RPC_ERROR_CODES.conflict,
      ],
      [
        async () => {
          throw new Error("private analysis failure");
        },
        RPC_ERROR_CODES.unavailable,
      ],
      [
        async () => {
          throw new Error("private operation analysis failure");
        },
        RPC_ERROR_CODES.unavailable,
      ],
      [async () => ({ private: true }), RPC_ERROR_CODES.unavailable],
    ] as const) {
      const result = await dispatchRpcRequestAsync(
        request("task.plan.generate_candidate", generateParams),
        { ...base, generateProjectTaskCandidatePlan: implementation },
      );
      expect(result.envelope).toMatchObject({
        kind: "error",
        error: { code: expectedCode },
      });
      expect(JSON.stringify(result)).not.toContain("private analysis failure");
    }
    expect(
      (await dispatchRpcRequestAsync(request("task.plan.generate_candidate", generateParams), base))
        .envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.unavailable } });
    expect(
      (
        await dispatchRpcRequestAsync(
          request("task.plan.generate_candidate", { ...generateParams, extra: true }),
          { ...base, generateProjectTaskCandidatePlan: provider },
        )
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(
      (
        await dispatchRpcRequestAsync(
          request("task.operation_manifest.generate_candidate", generateManifestParams),
          base,
        )
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.unavailable } });
  });

  it("awaits operation manifest generation and synchronously confirms a candidate", async () => {
    const base = context(() => ACCOUNT_STATUS);
    const generateProvider = vi.fn(async () => generatedManifest);
    await expect(
      dispatchRpcRequestAsync(
        request("task.operation_manifest.generate_candidate", generateManifestParams),
        { ...base, generateProjectTaskOperationManifest: generateProvider },
      ),
    ).resolves.toMatchObject({ envelope: { kind: "response", result: generatedManifest } });
    expect(generateProvider).toHaveBeenCalledWith(generateManifestParams);

    for (const [implementation, expectedCode] of [
      [
        async () => {
          throw new RpcProviderError("conflict");
        },
        RPC_ERROR_CODES.conflict,
      ],
      [async () => ({ private: true }), RPC_ERROR_CODES.unavailable],
    ] as const) {
      const result = await dispatchRpcRequestAsync(
        request("task.operation_manifest.generate_candidate", generateManifestParams),
        { ...base, generateProjectTaskOperationManifest: implementation },
      );
      expect(result.envelope).toMatchObject({
        kind: "error",
        error: { code: expectedCode },
      });
    }
    expect(
      (
        await dispatchRpcRequestAsync(
          request("task.operation_manifest.generate_candidate", {
            ...generateManifestParams,
            extra: true,
          }),
          { ...base, generateProjectTaskOperationManifest: generateProvider },
        )
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });

    const confirmProvider = vi.fn(() => confirmedManifest);
    expect(
      dispatchRpcRequest(
        request("task.operation_manifest.confirm_candidate", confirmManifestParams),
        { ...base, confirmProjectTaskOperationManifest: confirmProvider },
      ).envelope,
    ).toMatchObject({ kind: "response", result: confirmedManifest });
    expect(confirmProvider).toHaveBeenCalledWith(confirmManifestParams);
    expect(
      dispatchRpcRequest(
        request("task.operation_manifest.confirm_candidate", {
          ...confirmManifestParams,
          expectedManifestStateVersion: 0,
        }),
        { ...base, confirmProjectTaskOperationManifest: confirmProvider },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(
      dispatchRpcRequest(
        request("task.operation_manifest.confirm_candidate", confirmManifestParams),
        {
          ...base,
          confirmProjectTaskOperationManifest: () => {
            throw new RpcProviderError("conflict");
          },
        },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.conflict } });
    expect(
      dispatchRpcRequest(
        request("task.operation_manifest.confirm_candidate", confirmManifestParams),
        base,
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.unavailable } });
    expect(
      dispatchRpcRequest(
        request("task.operation_manifest.confirm_candidate", confirmManifestParams),
        {
          ...base,
          confirmProjectTaskOperationManifest: () => {
            throw new Error("private confirmation failure");
          },
        },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.unavailable } });
  });

  it("passes strict catalog, creation, detail, revision, and confirmation inputs to providers", () => {
    const readProjectTaskCatalogPage = vi.fn(() => PROJECT_TASK_CATALOG);
    const createProjectTask = vi.fn(() => PROJECT_TASK_CREATED);
    const base = context(() => ACCOUNT_STATUS);

    expect(
      dispatchRpcRequest(request("task.catalog_page", catalogParams), {
        ...base,
        readProjectTaskCatalogPage,
      }).envelope,
    ).toMatchObject({ kind: "response", result: PROJECT_TASK_CATALOG });
    expect(readProjectTaskCatalogPage).toHaveBeenCalledWith(catalogParams);

    expect(
      dispatchRpcRequest(request("task.create", createParams), {
        ...base,
        createProjectTask,
      }).envelope,
    ).toMatchObject({ kind: "response", result: PROJECT_TASK_CREATED });
    expect(createProjectTask).toHaveBeenCalledWith(createParams);

    const readProjectTaskDetail = vi.fn(() => PROJECT_TASK_DETAIL);
    expect(
      dispatchRpcRequest(request("task.detail", detailParams), {
        ...base,
        readProjectTaskDetail,
      }).envelope,
    ).toMatchObject({ kind: "response", result: PROJECT_TASK_DETAIL });
    expect(readProjectTaskDetail).toHaveBeenCalledWith(detailParams);

    const reviseProjectTaskRequirement = vi.fn(() => PROJECT_TASK_REVISED);
    expect(
      dispatchRpcRequest(request("task.requirement.revise", reviseParams), {
        ...base,
        reviseProjectTaskRequirement,
      }).envelope,
    ).toMatchObject({ kind: "response", result: PROJECT_TASK_REVISED });
    expect(reviseProjectTaskRequirement).toHaveBeenCalledWith(reviseParams);

    const confirmProjectTaskCandidatePlan = vi.fn(() => confirmed);
    expect(
      dispatchRpcRequest(request("task.plan.confirm_candidate", confirmParams), {
        ...base,
        confirmProjectTaskCandidatePlan,
      }).envelope,
    ).toMatchObject({ kind: "response", result: confirmed });
    expect(confirmProjectTaskCandidatePlan).toHaveBeenCalledWith(confirmParams);

    const materializeProjectTaskGraph = vi.fn(() => materialized);
    expect(
      dispatchRpcRequest(request("task.graph.materialize", graphParams), {
        ...base,
        materializeProjectTaskGraph,
      }).envelope,
    ).toMatchObject({ kind: "response", result: materialized });
    expect(materializeProjectTaskGraph).toHaveBeenCalledWith(graphParams);
  });

  it("rejects malformed Task parameters before consulting providers", () => {
    const readProjectTaskCatalogPage = vi.fn(() => PROJECT_TASK_CATALOG);
    const createProjectTask = vi.fn(() => PROJECT_TASK_CREATED);
    const readProjectTaskDetail = vi.fn(() => PROJECT_TASK_DETAIL);
    const reviseProjectTaskRequirement = vi.fn(() => PROJECT_TASK_REVISED);
    const confirmProjectTaskCandidatePlan = vi.fn(() => confirmed);
    const materializeProjectTaskGraph = vi.fn(() => materialized);
    const base = context(() => ACCOUNT_STATUS);
    expect(
      dispatchRpcRequest(request("task.catalog_page", { ...catalogParams, limit: 13 }), {
        ...base,
        readProjectTaskCatalogPage,
      }).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(
      dispatchRpcRequest(
        request("task.create", {
          ...createParams,
          ownershipCommandId: createParams.commandId,
        }),
        { ...base, createProjectTask },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(
      dispatchRpcRequest(
        request("task.graph.materialize", { ...graphParams, expectedTaskVersion: 0 }),
        { ...base, materializeProjectTaskGraph },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(
      dispatchRpcRequest(request("task.detail", { ...detailParams, extra: true }), {
        ...base,
        readProjectTaskDetail,
      }).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(
      dispatchRpcRequest(
        request("task.requirement.revise", { ...reviseParams, expectedTaskVersion: 0 }),
        { ...base, reviseProjectTaskRequirement },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(
      dispatchRpcRequest(
        request("task.plan.confirm_candidate", { ...confirmParams, expectedTaskVersion: 0 }),
        { ...base, confirmProjectTaskCandidatePlan },
      ).envelope,
    ).toMatchObject({ kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } });
    expect(readProjectTaskCatalogPage).not.toHaveBeenCalled();
    expect(createProjectTask).not.toHaveBeenCalled();
    expect(readProjectTaskDetail).not.toHaveBeenCalled();
    expect(reviseProjectTaskRequirement).not.toHaveBeenCalled();
    expect(confirmProjectTaskCandidatePlan).not.toHaveBeenCalled();
    expect(materializeProjectTaskGraph).not.toHaveBeenCalled();
  });

  it("maps Task conflicts and invalid provider results to stable public errors", () => {
    const base = context(() => ACCOUNT_STATUS);
    for (const [method, params, provider] of [
      ["task.catalog_page", catalogParams, "readProjectTaskCatalogPage"],
      ["task.create", createParams, "createProjectTask"],
      ["task.detail", detailParams, "readProjectTaskDetail"],
      ["task.requirement.revise", reviseParams, "reviseProjectTaskRequirement"],
      ["task.plan.confirm_candidate", confirmParams, "confirmProjectTaskCandidatePlan"],
      ["task.graph.materialize", graphParams, "materializeProjectTaskGraph"],
    ] as const) {
      const conflict = dispatchRpcRequest(request(method, params), {
        ...base,
        [provider]: () => {
          throw new RpcProviderError("conflict");
        },
      });
      expect(conflict.envelope).toMatchObject({
        kind: "error",
        error: { code: RPC_ERROR_CODES.conflict },
      });

      for (const implementation of [
        () => {
          throw new Error("private Task storage detail");
        },
        () => ({ private: true }),
      ]) {
        const unavailable = dispatchRpcRequest(request(method, params), {
          ...base,
          [provider]: implementation,
        });
        expect(unavailable.envelope).toMatchObject({
          kind: "error",
          error: { code: RPC_ERROR_CODES.unavailable },
        });
        expect(JSON.stringify(unavailable)).not.toContain("private Task storage detail");
      }
    }
  });
});

describe("RPC dispatcher execution admission", () => {
  const params = {
    activationId: "00000000-0000-4000-8000-000000000951",
    decisionId: "00000000-0000-4000-8000-000000000952",
    projectId: "00000000-0000-4000-8000-000000000953",
    taskId: "00000000-0000-4000-8000-000000000954",
    nodeId: "00000000-0000-4000-8000-000000000955",
    manifestId: "00000000-0000-4000-8000-000000000956",
    expectedProjectVersion: 1,
    expectedTaskVersion: 3,
    expectedOwnershipVersion: 1,
    previousRequirementRevisionId: "00000000-0000-4000-8000-000000000957",
    confirmedPlanRevisionId: "00000000-0000-4000-8000-000000000958",
    graphRevisionId: "00000000-0000-4000-8000-000000000959",
    expectedManifestStateVersion: 2,
    expectedRoutingBindingVersion: 1,
    expectedProfileVersion: 1,
    expectedConfigurationRevisionId: "00000000-0000-4000-8000-000000000960",
    userConfirmed: true,
  } as const;
  const result = {
    schemaVersion: 1,
    status: "denied",
    activationId: params.activationId,
    taskId: params.taskId,
    nodeId: params.nodeId,
    operationKinds: ["answer"],
    rejectionReason: "workspace_dirty",
    route: null,
    permission: null,
  } as const;

  it("dispatches asynchronously and validates the public result", async () => {
    const provider = vi.fn(async () => result);
    await expect(
      dispatchRpcRequestAsync(request("task.execution.activate", params), {
        ...context(() => ACCOUNT_STATUS),
        activateProjectTaskExecution: provider,
      }),
    ).resolves.toMatchObject({ envelope: { kind: "response", result } });
    expect(provider).toHaveBeenCalledWith(params);

    await expect(
      dispatchRpcRequestAsync(request("task.execution.activate", params), {
        ...context(() => ACCOUNT_STATUS),
        activateProjectTaskExecution: async () => ({ private: true }),
      }),
    ).resolves.toMatchObject({
      envelope: { kind: "error", error: { code: RPC_ERROR_CODES.unavailable } },
    });
  });

  it("maps missing providers, malformed parameters and provider failures", async () => {
    const base = context(() => ACCOUNT_STATUS);
    expect(
      dispatchRpcRequest(request("task.execution.activate", params), base).envelope,
    ).toMatchObject({
      kind: "error",
      error: { code: RPC_ERROR_CODES.unavailable },
    });
    await expect(
      dispatchRpcRequestAsync(request("task.execution.activate", { ...params, extra: true }), {
        ...base,
        activateProjectTaskExecution: vi.fn(),
      }),
    ).resolves.toMatchObject({
      envelope: { kind: "error", error: { code: RPC_ERROR_CODES.invalidParams } },
    });
    for (const failure of [new RpcProviderError("conflict"), new Error("private")]) {
      await expect(
        dispatchRpcRequestAsync(request("task.execution.activate", params), {
          ...base,
          activateProjectTaskExecution: async () => Promise.reject(failure),
        }),
      ).resolves.toMatchObject({
        envelope: {
          kind: "error",
          error: {
            code:
              failure instanceof RpcProviderError
                ? RPC_ERROR_CODES.conflict
                : RPC_ERROR_CODES.unavailable,
          },
        },
      });
    }
  });
});
