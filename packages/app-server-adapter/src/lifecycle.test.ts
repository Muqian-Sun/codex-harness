import { describe, expect, it } from "vitest";

import { parseAppServerLifecycleNotification } from "./lifecycle.js";

describe("App Server recovery lifecycle notifications", () => {
  it("normalizes turn boundaries without exposing full turn content", () => {
    expect(
      parseAppServerLifecycleNotification("turn/started", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "inProgress",
          futureTurnField: { private: "not copied" },
        },
        futureNotificationField: true,
      }),
    ).toEqual({
      kind: "signal",
      signal: { type: "turn_started", threadId: "thread-1", turnId: "turn-1" },
    });

    const completed = parseAppServerLifecycleNotification("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          { id: "message-1", type: "agentMessage", text: "not copied" },
          { id: "compact-1", type: "contextCompaction", encrypted: "not copied" },
          { id: "compact-1", type: "contextCompaction" },
        ],
        status: "interrupted",
        error: { message: "not copied" },
      },
    });
    expect(completed).toEqual({
      kind: "signal",
      signal: {
        type: "turn_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "interrupted",
        contextCompactionItemIds: ["compact-1"],
      },
    });
    expect(JSON.stringify(completed)).not.toContain("not copied");
  });

  it("normalizes context compaction item start and completion", () => {
    expect(
      parseAppServerLifecycleNotification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1_750_000_000_000,
        item: { id: "compact-1", type: "contextCompaction", future: true },
      }),
    ).toEqual({
      kind: "signal",
      signal: {
        type: "context_compaction_started",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "compact-1",
      },
    });
    const completed = parseAppServerLifecycleNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1_750_000_000_001,
      item: { id: "compact-1", type: "contextCompaction" },
    });
    expect(completed).toEqual({
      kind: "signal",
      signal: {
        type: "context_compaction_completed",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "compact-1",
      },
    });
    expect(completed.kind === "signal" && Object.isFrozen(completed.signal)).toBe(true);
  });

  it("validates non-compaction item envelopes without producing recovery signals", () => {
    expect(
      parseAppServerLifecycleNotification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: { id: "message-1", type: "agentMessage", text: "hello" },
      }),
    ).toEqual({ kind: "validated_non_signal" });
  });

  it("rejects malformed known lifecycle messages with no input disclosure", () => {
    const malformed = parseAppServerLifecycleNotification("turn/completed", {
      threadId: "private-thread-id",
      turn: { id: "turn-1", items: [], status: "inProgress" },
    });
    expect(malformed).toEqual({ kind: "invalid" });
    expect(JSON.stringify(malformed)).not.toContain("private-thread-id");
    expect(
      parseAppServerLifecycleNotification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: -1,
        item: { id: "compact-1", type: "contextCompaction" },
      }),
    ).toEqual({ kind: "invalid" });

    class TurnParams {
      threadId = "thread-1";
      turn = { id: "turn-1", items: [], status: "inProgress" };
    }
    expect(parseAppServerLifecycleNotification("turn/started", new TurnParams())).toEqual({
      kind: "invalid",
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parseAppServerLifecycleNotification("turn/started", cyclic)).toEqual({
      kind: "invalid",
    });
  });

  it("does not treat unknown or deprecated notifications as recovery authority", () => {
    expect(parseAppServerLifecycleNotification("future/event", {})).toEqual({
      kind: "unrecognized",
    });
    expect(
      parseAppServerLifecycleNotification("thread/compacted", {
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toEqual({ kind: "unrecognized" });
  });
});
