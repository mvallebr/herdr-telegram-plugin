import { describe, expect, it, vi } from "vitest";
import { PaneManager } from "../src/pane-manager.js";
import type { PaneAgent } from "../src/pane-agent.js";
import type { DaemonState, PaneInfo, ThreadMapping } from "../src/types.js";

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


  it("start syncs immediately and schedules recurring syncs", () => {
    const calls: string[] = [];
    let scheduledSync: (() => void) | undefined;
    const getAgents = vi.fn(() => {
      calls.push("sync");
      return [];
    });
    const scheduleRepeating = vi.fn(
      (fn: () => void, intervalMs: number) => {
        calls.push(`schedule:${intervalMs}`);
        scheduledSync = fn;
        return vi.fn();
      },
    );
    const manager = new PaneManager({
      getAgents,
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      scheduleRepeating,
    });

    manager.start();

    expect(calls).toEqual(["sync", "schedule:15000"]);
    scheduledSync?.();
    expect(getAgents).toHaveBeenCalledTimes(2);
  });

  it("stop clears the recurring sync timer", () => {
    const stopTimer = vi.fn();
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      scheduleRepeating: () => stopTimer,
    });
    manager.start();

    manager.stop();

    expect(stopTimer).toHaveBeenCalledOnce();
  });

  it("calls onPaneAdded with the pane id when a new pane appears", () => {
    let panes: PaneInfo[] = [];
    let runScheduledSync: () => void = () => undefined;
    const onPaneAdded = vi.fn();
    const manager = new PaneManager({
      getAgents: () => panes,
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneAdded },
      scheduleRepeating: (fn) => {
        runScheduledSync = fn;
        return vi.fn();
      },
    });
    manager.start();
    panes = [
      {
        pane_id: "workspace:pane-added",
        label: "Added Pane",
        agent: "pi",
        tab_id: "workspace:tab-added",
        workspace_id: "workspace",
        status: "idle",
      },
    ];

    runScheduledSync();

    expect(onPaneAdded).toHaveBeenCalledOnce();
    expect(onPaneAdded).toHaveBeenCalledWith("workspace:pane-added");
  });

  it("calls onPaneRemoved with the pane id when a pane disappears", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-removed",
      label: "Removed Pane",
      agent: "pi",
      tab_id: "workspace:tab-removed",
      workspace_id: "workspace",
      status: "idle",
    };
    let panes: PaneInfo[] = [pane];
    let runScheduledSync: () => void = () => undefined;
    const state = emptyState();
    state.thread_mappings = {
      42: {
        pane_id: pane.pane_id,
        label: pane.label,
        agent: pane.agent,
        created_at: "created",
      },
    };
    const onPaneRemoved = vi.fn();
    const manager = new PaneManager({
      getAgents: () => panes,
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneRemoved },
      scheduleRepeating: (fn) => {
        runScheduledSync = fn;
        return vi.fn();
      },
    });
    manager.start();
    panes = [];

    runScheduledSync();

    expect(onPaneRemoved).toHaveBeenCalledOnce();
    expect(onPaneRemoved).toHaveBeenCalledWith("workspace:pane-removed");
  });

  it("calls onPaneRenamed with the pane id and preserved labels", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-renamed",
      label: "Old Label",
      agent: "pi",
      tab_id: "workspace:tab-renamed",
      workspace_id: "workspace",
      status: "idle",
    };
    let panes: PaneInfo[] = [pane];
    let runScheduledSync: () => void = () => undefined;
    const state = emptyState();
    state.thread_mappings = {
      42: {
        pane_id: pane.pane_id,
        label: pane.label,
        agent: pane.agent,
        created_at: "created",
      },
    };
    const onPaneRenamed = vi.fn();
    const manager = new PaneManager({
      getAgents: () => panes,
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneRenamed },
      scheduleRepeating: (fn) => {
        runScheduledSync = fn;
        return vi.fn();
      },
    });
    manager.start();
    panes = [{ ...pane, label: "New Label" }];

    runScheduledSync();

    expect(onPaneRenamed).toHaveBeenCalledOnce();
    expect(onPaneRenamed).toHaveBeenCalledWith(
      "workspace:pane-renamed",
      "Old Label",
      "New Label",
    );
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

  it("healthCheck returns dead entries for threads whose chat action throws", async () => {
    const state = emptyState();
    state.known_tabs = {
      "workspace:tab-1": { label: "Pane One", thread_id: 42 },
      "workspace:tab-2": { label: "Pane Two", thread_id: 43 },
    };
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    const result = await manager.healthCheck({
      chatId: 1,
      sendChatAction: async (chatId, threadId) => {
        if (threadId === 42) {
          throw new Error("400: TOPIC_ID_INVALID");
        }
      },
    });

    expect(result.persisted).toBe(false);
    expect(result.dead).toEqual([
      { tabId: "workspace:tab-1", threadId: 42, label: "Pane One" },
    ]);
  });

  it("healthCheck treats a truthy error return as a dead entry", async () => {
    const state = emptyState();
    state.known_tabs = {
      "workspace:tab-1": { label: "Pane One", thread_id: 42 },
    };
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    const result = await manager.healthCheck({
      chatId: 7,
      sendChatAction: async () => ({ error: "TOPIC_ID_INVALID" }),
    });

    expect(result.persisted).toBe(false);
    expect(result.dead).toEqual([
      { tabId: "workspace:tab-1", threadId: 42, label: "Pane One" },
    ]);
  });

  it("healthCheck returns an empty dead list when every thread responds", async () => {
    const state = emptyState();
    state.known_tabs = {
      "workspace:tab-1": { label: "Pane One", thread_id: 42 },
      "workspace:tab-2": { label: "Pane Two", thread_id: 43 },
    };
    const sendChatAction = vi.fn(async () => undefined);
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    const result = await manager.healthCheck({
      chatId: 99,
      sendChatAction,
    });

    expect(result.persisted).toBe(false);
    expect(result.dead).toEqual([]);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    expect(sendChatAction).toHaveBeenCalledWith(99, 42);
    expect(sendChatAction).toHaveBeenCalledWith(99, 43);
  });

  it("restoreTopic updates known_tabs and thread_mappings", () => {
    const state = emptyState();
    state.known_tabs = {
      "workspace:tab-1": { label: "Old Label", thread_id: 42 },
    };
    state.thread_mappings = {
      42: {
        pane_id: "workspace:pane-1",
        label: "Old Label",
        agent: "pi",
        created_at: "2026-07-30T12:00:00.000Z",
      },
    };
    const saveState = vi.fn();
    const manager = new PaneManager({
      getAgents: () => [
        {
          pane_id: "workspace:pane-1",
          label: "Pane One",
          agent: "pi",
          tab_id: "workspace:tab-1",
          workspace_id: "workspace",
          status: "idle",
        },
      ],
      loadState: () => state,
      saveState,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    manager.restoreTopic("workspace:tab-1", 84, "Pane One");

    expect(manager.state().known_tabs?.["workspace:tab-1"]).toEqual({
      label: "Pane One",
      thread_id: 84,
    });
    expect(manager.state().thread_mappings[84]).toMatchObject({
      pane_id: "workspace:pane-1",
      label: "Pane One",
      agent: "pi",
    });
    expect(saveState).toHaveBeenCalledOnce();
  });
});
