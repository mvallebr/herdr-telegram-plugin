import { describe, it, expect } from "vitest";
import type { PaneInfo } from "../src/types.js";

/**
 * Pure function extracted from watcher.ts: classify herdr panes against
 * known_tabs to determine what changed.  No API calls — just the detection
 * logic that the watcher loop runs.
 */
export function classifyTabChanges(
  panes: PaneInfo[],
  knownTabs: Record<string, { label: string; thread_id: number }>
) {
  const added: string[] = [];
  const renamed: string[] = [];
  const removed: string[] = [];
  const currentIds = new Set(panes.map((p) => p.tab_id));

  for (const pane of panes) {
    const existing = knownTabs[pane.tab_id];
    if (!existing) {
      added.push(pane.tab_id);
    } else if (existing.label !== pane.label) {
      renamed.push(pane.tab_id);
    }
  }

  // Detect removed (in knownTabs but not in current panes)
  for (const tabId of Object.keys(knownTabs)) {
    if (!currentIds.has(tabId)) {
      removed.push(tabId);
    }
  }

  return { added, renamed, removed };
}

const makePane = (overrides: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id: "w1:pX",
  tab_id: "w1:tX",
  label: "Test",
  agent: "pi",
  workspace_id: "w1",
  status: "idle",
  ...overrides,
});

describe("classifyTabChanges", () => {
  it("detects new tabs", () => {
    const panes = [makePane({ tab_id: "w1:tA", label: "Agent A" })];
    const result = classifyTabChanges(panes, {});
    expect(result.added).toEqual(["w1:tA"]);
    expect(result.renamed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("detects renamed tabs", () => {
    const panes = [makePane({ tab_id: "w1:tA", label: "New Name" })];
    const known = { "w1:tA": { label: "Old Name", thread_id: 10 } };
    const result = classifyTabChanges(panes, known);
    expect(result.renamed).toEqual(["w1:tA"]);
    expect(result.added).toEqual([]);
  });

  it("detects removed tabs", () => {
    const known = { "w1:tA": { label: "Agent A", thread_id: 10 } };
    const result = classifyTabChanges([], known);
    expect(result.removed).toEqual(["w1:tA"]);
    expect(result.added).toEqual([]);
  });

  it("no changes when tabs match", () => {
    const panes = [makePane({ tab_id: "w1:tA", label: "Agent A" })];
    const known = { "w1:tA": { label: "Agent A", thread_id: 10 } };
    const result = classifyTabChanges(panes, known);
    expect(result.added).toEqual([]);
    expect(result.renamed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("handles mixed new + renamed + removed", () => {
    const panes = [
      makePane({ tab_id: "w1:tA", label: "A" }),
      makePane({ tab_id: "w1:tB", label: "B Renamed" }),
    ];
    const known = {
      "w1:tB": { label: "B", thread_id: 10 },
      "w1:tC": { label: "C", thread_id: 11 },
    };
    const result = classifyTabChanges(panes, known);
    expect(result.added).toEqual(["w1:tA"]);
    expect(result.renamed).toEqual(["w1:tB"]);
    expect(result.removed).toEqual(["w1:tC"]);
  });
});
