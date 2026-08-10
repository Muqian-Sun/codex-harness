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
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        phase: null,
        text: "{}",
      },
    });
  });

  it("leaves other notifications and completed item kinds unrecognized", () => {
    expect(parseAppServerTurnOutputNotification("warning", {})).toEqual({
      kind: "unrecognized",
    });
    expect(
      parseAppServerTurnOutputNotification("item/completed", {
        completedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution", private: "not copied" },
      }),
    ).toEqual({ kind: "unrecognized" });
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
