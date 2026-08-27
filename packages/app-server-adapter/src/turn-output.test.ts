import { describe, expect, it } from "vitest";

import { parseAppServerTurnOutputNotification } from "./turn-output.js";

describe("App Server turn output notifications", () => {
  it("projects only completed agent message fields", () => {
    const parsed = parseAppServerTurnOutputNotification("item/completed", {
      completedAtMs: 1_750_000_000_000,
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-1",
        type: "agentMessage",
        text: '{"kind":"candidate"}',
        phase: "final_answer",
        memoryCitation: { private: "not copied" },
      },
      future: { private: "not copied" },
    });

    expect(parsed).toEqual({
      kind: "signal",
      signal: {
        type: "agent_message",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        phase: "final_answer",
        text: '{"kind":"candidate"}',
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("not copied");
    expect(parsed.kind === "signal" && Object.isFrozen(parsed.signal)).toBe(true);
  });

  it("supports providers that omit message phase", () => {
    expect(
      parseAppServerTurnOutputNotification("item/completed", {
        completedAtMs: 0,
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "message-1", type: "agentMessage", text: "{}" },
      }),
    ).toEqual({
      kind: "signal",
      signal: {
        type: "agent_message",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        phase: null,
        text: "{}",
      },
    });
  });

  it("projects command and file evidence while leaving passive items unrecognized", () => {
    expect(parseAppServerTurnOutputNotification("warning", {})).toEqual({
      kind: "unrecognized",
    });
    expect(
      parseAppServerTurnOutputNotification("item/completed", {
        completedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "pnpm test",
          commandActions: [],
          cwd: "/workspace",
          status: "completed",
          exitCode: 0,
          durationMs: 10,
          aggregatedOutput: "passed",
        },
      }),
    ).toEqual({
      kind: "signal",
      signal: {
        type: "command_execution",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "pnpm test",
        cwd: "/workspace",
        status: "completed",
        exitCode: 0,
        durationMs: 10,
        aggregatedOutput: "passed",
      },
    });
    expect(
      parseAppServerTurnOutputNotification("item/completed", {
        completedAtMs: 2,
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "file-1",
          type: "fileChange",
          status: "completed",
          changes: [
            { path: "src/index.ts", diff: "diff", kind: { type: "update", move_path: null } },
          ],
        },
      }),
    ).toEqual({
      kind: "signal",
      signal: {
        type: "file_change",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-1",
        status: "completed",
        changes: [
          {
            path: "src/index.ts",
            changeKind: "update",
            movePath: null,
            diff: "diff",
          },
        ],
      },
    });
    expect(
      parseAppServerTurnOutputNotification("item/completed", {
        completedAtMs: 3,
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reasoning-1", type: "reasoning" },
      }),
    ).toEqual({ kind: "unrecognized" });
  });

  it("classifies non-passive tool items as forbidden", () => {
    expect(
      parseAppServerTurnOutputNotification("item/completed", {
        completedAtMs: 3,
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "web-1", type: "webSearch" },
      }),
    ).toEqual({
      kind: "signal",
      signal: {
        type: "forbidden_item",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "web-1",
        itemType: "webSearch",
      },
    });
  });

  it("rejects malformed known agent messages without disclosure", () => {
    expect(
      parseAppServerTurnOutputNotification("item/completed", {
        item: { id: "message-1", type: "agentMessage" },
      }),
    ).toEqual({ kind: "invalid" });

    const malformed = parseAppServerTurnOutputNotification("item/completed", {
      completedAtMs: 1,
      threadId: "private-thread",
      turnId: "turn-1",
      item: { id: "message-1", type: "agentMessage", text: 42 },
    });
    expect(malformed).toEqual({ kind: "invalid" });
    expect(JSON.stringify(malformed)).not.toContain("private-thread");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parseAppServerTurnOutputNotification("item/completed", cyclic)).toEqual({
      kind: "invalid",
    });
  });
});
