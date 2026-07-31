import { describe, expect, it, vi } from "vitest";
import { PaneManager } from "../src/pane-manager.js";
import type { PaneAgent } from "../src/pane-agent.js";
import type { DaemonState, ThreadMapping } from "../src/types.js";

const emptyState = (): DaemonState => ({
  authorized_chat_id: null,
  paired_at: null,
  thread_mappings: {},
});

describe("PaneManager", () => {
  it("returns the same pane agent for repeated calls with the same pane id", () => {
    const agentFactory = vi.fn(
      (paneId: string) => ({ paneId }) as unknown as PaneAgent,
    );
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory,
    });

    const first = manager.getPaneAgent("workspace:pane-1");
    const second = manager.getPaneAgent("workspace:pane-1");

    expect(first).toBe(second);
    expect(agentFactory).toHaveBeenCalledOnce();
  });

  it("returns the state loaded during construction", () => {
    const loadedState: DaemonState = {
      authorized_chat_id: 1234,
      paired_at: "2026-07-30T12:00:00.000Z",
      thread_mappings: {},
      known_topics: {
        42: { name: "Pane One", created_at: "2026-07-30T12:01:00.000Z" },
      },
      known_tabs: {
        "workspace:tab-1": { label: "Pane One", thread_id: 42 },
      },
      processed_update_ids: [7, 8],
    };
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => loadedState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    expect(manager.state()).toEqual(loadedState);
  });

  it("converts loaded thread mappings to a Map with numeric thread ids", () => {
    const firstMapping: ThreadMapping = {
      pane_id: "workspace:pane-1",
      label: "Pane One",
      agent: "opencode",
      created_at: "2026-07-30T12:01:00.000Z",
    };
    const secondMapping: ThreadMapping = {
      pane_id: "workspace:pane-2",
      label: "Pane Two",
      agent: "codex",
      created_at: "2026-07-30T12:02:00.000Z",
    };
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => ({
        authorized_chat_id: 1234,
        paired_at: "2026-07-30T12:00:00.000Z",
        thread_mappings: {
          42: firstMapping,
          84: secondMapping,
        },
      }),
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    expect(manager.mappings()).toEqual(
      new Map([
        [42, firstMapping],
        [84, secondMapping],
      ]),
    );
  });
});
