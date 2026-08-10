import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "00000000-0000-4000-8000-000000000891";
const hooks = vi.hoisted(() => ({
  cursor: 0,
  setters: [vi.fn(), vi.fn(), vi.fn()],
  values: [] as unknown[],
}));

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor;
    hooks.cursor += 1;
    return [hooks.values[index] ?? initial, hooks.setters[index]];
  },
}));

import { ProjectRegistryPanel } from "./bootstrap-screen.js";

const PROJECTS = {
  projects: [
    {
      projectId: PROJECT_ID,
      projectVersion: 1 as const,
      displayName: "workspace",
      workspace: {
        platform: "macos" as const,
        absolutePath: "/Users/example/workspace",
        identityStatus: "unverified" as const,
      },
    },
  ],
  hasMore: false,
};

function findBindingButton(root: unknown): Readonly<{ props: Record<string, unknown> }> {
  const queue = [root];
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const props = (candidate as { props?: Record<string, unknown> }).props;
    if (props !== undefined) {
      if (props["data-project-routing-bind"] === PROJECT_ID) {
        return { props };
      }
      const children = props.children;
      queue.push(...(Array.isArray(children) ? children : [children]));
    }
  }
  throw new Error("binding button was not rendered");
}

function renderPanel(bindingState: unknown = undefined) {
  hooks.cursor = 0;
  hooks.values = ["idle", undefined, bindingState];
  return ProjectRegistryPanel({
    projects: PROJECTS,
    projectRoutingBindings: {
      bindings: [{ projectId: PROJECT_ID, status: "unbound", bindingVersion: null }],
    },
    routingConfigured: true,
  });
}

beforeEach(() => {
  for (const setter of hooks.setters) {
    setter.mockReset();
  }
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "codexHarness");
});

describe("Project routing binding interaction", () => {
  it("serializes local submissions and publishes stable success or unavailable state", async () => {
    const bindProjectToDefaultRouting = vi.fn(async () => ({ status: "bound" as const }));
    Object.assign(globalThis, {
      codexHarness: {
        bindProjectToDefaultRouting,
        chooseProjectWorkspace: vi.fn(),
      },
    });

    const successButton = findBindingButton(renderPanel());
    await (successButton.props.onClick as () => Promise<void>)();
    expect(hooks.setters[2]).toHaveBeenNthCalledWith(1, {
      status: "binding",
      projectId: PROJECT_ID,
    });
    expect(hooks.setters[2]).toHaveBeenNthCalledWith(2, {
      status: "bound",
      projectId: PROJECT_ID,
    });

    bindProjectToDefaultRouting.mockRejectedValueOnce(new Error("contained"));
    const failureButton = findBindingButton(renderPanel());
    await (failureButton.props.onClick as () => Promise<void>)();
    expect(hooks.setters[2]).toHaveBeenLastCalledWith({
      status: "unavailable",
      projectId: PROJECT_ID,
    });

    const pendingButton = findBindingButton(
      renderPanel({ status: "binding", projectId: PROJECT_ID }),
    );
    await (pendingButton.props.onClick as () => Promise<void>)();
    expect(bindProjectToDefaultRouting).toHaveBeenCalledTimes(2);
  });
});
