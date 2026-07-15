import { describe, it, expect } from "vitest";
import { matchTopic, resolveOrphanTopics, seedKnownTabs, restoreKnownTabMappings } from "../src/mapping.js";
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
    const match = matchTopic(pane, topics);
    expect(match).toBe(140);
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
    const panes: PaneInfo[] = [];
    const topics: TopicInfo[] = [{ message_thread_id: 140, name: "orphan" }];
    const existing: Map<number, ThreadMapping> = new Map();
    expect(resolveOrphanTopics(panes, topics, existing)).toHaveLength(1);
  });

  it("returns empty when all topics match panes", () => {
    const panes: PaneInfo[] = [{
      pane_id: "w1:pZ", label: "Echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    }];
    const topics: TopicInfo[] = [{ message_thread_id: 140, name: "Echo" }];
    const existing: Map<number, ThreadMapping> = new Map([[140, { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "x" }]]);
    expect(resolveOrphanTopics(panes, topics, existing)).toHaveLength(0);
  });
});

describe("seedKnownTabs", () => {
  const makePane = (pane_id: string, tab_id: string, label: string): PaneInfo => ({
    pane_id, tab_id, label, agent: "pi", workspace_id: "w1", status: "idle",
  });

  it("populates known_tabs from thread_mappings for matching panes", () => {
    const map = new Map<number, ThreadMapping>([
      [10, { pane_id: "w1:pA", label: "Agent A", agent: "pi", created_at: "x" }],
      [20, { pane_id: "w1:pB", label: "Agent B", agent: "pi", created_at: "x" }],
    ]);
    const panes = [makePane("w1:pA", "w1:tA", "Agent A"), makePane("w1:pB", "w1:tB", "Agent B")];
    const result = seedKnownTabs(map, panes, {});
    expect(result).toEqual({
      "w1:tA": { label: "Agent A", thread_id: 10 },
      "w1:tB": { label: "Agent B", thread_id: 20 },
    });
  });

  it("skips panes with no matching mapping", () => {
    const map = new Map<number, ThreadMapping>([
      [10, { pane_id: "w1:pA", label: "Agent A", agent: "pi", created_at: "x" }],
    ]);
    const panes = [makePane("w1:pZ", "w1:tZ", "Unknown")];
    const result = seedKnownTabs(map, panes, {});
    expect(result).toEqual({});
  });

  it("preserves existing known_tabs entries", () => {
    const map = new Map<number, ThreadMapping>([
      [10, { pane_id: "w1:pA", label: "Agent A", agent: "pi", created_at: "x" }],
    ]);
    const panes = [makePane("w1:pA", "w1:tA", "Agent A")];
    const existing = { "w1:tB": { label: "Old B", thread_id: 99 } };
    const result = seedKnownTabs(map, panes, existing);
    expect(result["w1:tB"]).toEqual({ label: "Old B", thread_id: 99 });
    expect(result["w1:tA"]).toEqual({ label: "Agent A", thread_id: 10 });
  });

  it("does not overwrite already-seeded tab_ids", () => {
    const map = new Map<number, ThreadMapping>([
      [10, { pane_id: "w1:pA", label: "Agent A", agent: "pi", created_at: "x" }],
    ]);
    const panes = [makePane("w1:pA", "w1:tA", "Agent A Renamed")];
    const existing = { "w1:tA": { label: "Agent A", thread_id: 10 } };
    const result = seedKnownTabs(map, panes, existing);
    // Already-seeded entry is NOT overwritten (rename detection is the watcher's job)
    expect(result["w1:tA"]).toEqual({ label: "Agent A", thread_id: 10 });
  });
});

describe("restoreKnownTabMappings", () => {
  it("prefers the current known-tab topic over a stale mapping for the same pane", () => {
    const panes: PaneInfo[] = [{
      pane_id: "w1:pC", tab_id: "w1:tC", label: "Codex", agent: "codex", workspace_id: "w1", status: "idle",
    }];
    const previous = new Map<number, ThreadMapping>([
      [695, { pane_id: "w1:pC", label: "Codex", agent: "codex", created_at: "old" }],
      [775, { pane_id: "w1:pC", label: "Codex", agent: "codex", created_at: "new" }],
    ]);
    const restored = restoreKnownTabMappings(panes, { "w1:tC": { label: "Codex", thread_id: 775 } }, previous);
    expect([...restored.keys()]).toEqual([775]);
    expect(restored.get(775)?.pane_id).toBe("w1:pC");
  });
});
