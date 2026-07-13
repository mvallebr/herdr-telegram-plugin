import { describe, it, expect } from "vitest";
import { matchTopic, resolveOrphanTopics, findMapping } from "../src/mapping.js";
import type { PaneInfo, TopicInfo, ThreadMapping } from "../src/types.js";

describe("matchTopic", () => {
  it("matches pane by label to topic by name (case-insensitive)", () => {
    const pane: PaneInfo = {
      pane_id: "w1:pZ", label: "Echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    };
    const topics: TopicInfo[] = [
      { message_thread_id: 140, name: "Echo" },
      { message_thread_id: 142, name: "Fjord" },
    ];
    expect(matchTopic(pane, topics)).toBe(140);
  });

  it("matches with different casing", () => {
    const pane: PaneInfo = {
      pane_id: "w1:pZ", label: "echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    };
    const topics: TopicInfo[] = [{ message_thread_id: 150, name: "ECHO" }];
    expect(matchTopic(pane, topics)).toBe(150);
  });

  it("returns undefined when no match", () => {
    const pane: PaneInfo = {
      pane_id: "w1:pZ", label: "Echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    };
    expect(matchTopic(pane, [])).toBeUndefined();
  });
});

describe("resolveOrphanTopics", () => {
  it("returns topics with no matching pane", () => {
    const topics: TopicInfo[] = [{ message_thread_id: 140, name: "orphan" }];
    expect(resolveOrphanTopics([], topics, new Map())).toHaveLength(1);
  });

  it("returns empty when all topics match panes", () => {
    const panes: PaneInfo[] = [{
      pane_id: "w1:pZ", label: "Echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    }];
    const topics: TopicInfo[] = [{ message_thread_id: 140, name: "Echo" }];
    const existing = new Map<number, ThreadMapping>();
    existing.set(140, { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "x" });
    expect(resolveOrphanTopics(panes, topics, existing)).toHaveLength(0);
  });
});

describe("findMapping", () => {
  it("returns mapping if exists", () => {
    const map = new Map<number, ThreadMapping>();
    map.set(140, { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "x" });
    expect(findMapping(140, map)?.pane_id).toBe("w1:pZ");
  });

  it("returns undefined if missing", () => {
    expect(findMapping(999, new Map())).toBeUndefined();
  });
});
