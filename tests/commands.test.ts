import { describe, it, expect } from "vitest";
import { formatAgentList, formatStatus } from "../src/commands.js";
import type { PaneInfo, ThreadMapping } from "../src/types.js";

describe("formatAgentList", () => {
  it("formats agents with status", () => {
    const panes: PaneInfo[] = [
      { pane_id: "w1:pZ", label: "Echo", agent: "pi", tab_id: "tZ", workspace_id: "w1", status: "idle" },
    ];
    const map = new Map<number, ThreadMapping>();
    map.set(140, { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "x" });

    const result = formatAgentList(panes, map);
    expect(result).toContain("Echo");
    expect(result).toContain("pi");
    expect(result).toContain("140");
  });
});

describe("formatStatus", () => {
  it("includes uptime and counts", () => {
    const result = formatStatus({
      uptime: "10s",
      paired: true,
      panesCount: 3,
    });
    expect(result).toContain("10s");
    expect(result).toContain("panes: 3");
  });
});
