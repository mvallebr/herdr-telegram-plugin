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

  it("sync adds panes represented by known tabs to state", () => {
    const state = emptyState();
    state.known_tabs = {
      "workspace:tab-1": { label: "Pane One", thread_id: 42 },
    };
    const pane = {
      pane_id: "workspace:pane-1",
      label: "Pane One",
      agent: "opencode",
      tab_id: "workspace:tab-1",
      workspace_id: "workspace",
      status: "idle" as const,
    };
    const manager = new PaneManager({
      getAgents: () => [pane],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    manager.sync();

    expect(manager.mappings().get(42)).toMatchObject({
      pane_id: pane.pane_id,
      label: pane.label,
      agent: pane.agent,
    });
    expect(manager.state().known_tabs?.[pane.tab_id]).toEqual({
      label: pane.label,
      thread_id: 42,
    });
  });

  it("sync removes panes that are no longer present", () => {
    const state = emptyState();
    state.thread_mappings = {
      42: { pane_id: "workspace:pane-1", label: "Pane One", agent: "pi", created_at: "created" },
    };
    state.known_tabs = {
      "workspace:tab-1": { label: "Pane One", thread_id: 42 },
    };
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    const result = manager.sync();

    expect(result.removed).toEqual(["workspace:pane-1"]);
    expect(manager.mappings()).toEqual(new Map());
    expect(manager.state().known_tabs).toEqual({});
  });


  it("sync updates a pane label when it is renamed", () => {
    const state = emptyState();
    state.thread_mappings = {
      42: { pane_id: "workspace:pane-1", label: "Old Label", agent: "pi", created_at: "created" },
    };
    state.known_tabs = {
      "workspace:tab-1": { label: "Old Label", thread_id: 42 },
    };
    const manager = new PaneManager({
      getAgents: () => [{
        pane_id: "workspace:pane-1", label: "New Label", agent: "pi",
        tab_id: "workspace:tab-1", workspace_id: "workspace", status: "idle",
      }],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    const result = manager.sync();

    expect(result.renamed).toEqual(["workspace:pane-1"]);
    expect(manager.mappings().get(42)?.label).toBe("New Label");
    expect(manager.state().known_tabs?.["workspace:tab-1"]?.label).toBe("New Label");
  });


  it("sync persists the updated state", () => {
    const state = emptyState();
    state.thread_mappings = {
      42: { pane_id: "workspace:pane-1", label: "Pane One", agent: "pi", created_at: "created" },
    };
    const saveState = vi.fn();
    const manager = new PaneManager({
      getAgents: () => [{
        pane_id: "workspace:pane-1", label: "Pane One", agent: "pi",
        tab_id: "workspace:tab-1", workspace_id: "workspace", status: "idle",
      }],
      loadState: () => state,
      saveState,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    manager.sync();

    expect(saveState).toHaveBeenCalledOnce();
    expect(saveState).toHaveBeenCalledWith(state);
    expect(manager.mappings().get(42)?.created_at).toBe("created");
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
