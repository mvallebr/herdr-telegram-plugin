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

  it("adopts persisted mappings on the first sync without reporting them as added", () => {
    const state = emptyState();
    state.thread_mappings = {
      42: {
        pane_id: "workspace:persisted",
        label: "Old Persisted Label",
        agent: "pi",
        created_at: "created",
      },
    };
    state.known_tabs = {
      "workspace:tab-persisted": { label: "Old Persisted Label", thread_id: 42 },
    };
    const persisted: PaneInfo = {
      pane_id: "workspace:persisted",
      label: "Persisted Label",
      agent: "pi",
      tab_id: "workspace:tab-persisted",
      workspace_id: "workspace",
      status: "idle",
    };
    const fresh: PaneInfo = {
      pane_id: "workspace:fresh",
      label: "Fresh Pane",
      agent: "pi",
      tab_id: "workspace:tab-fresh",
      workspace_id: "workspace",
      status: "idle",
    };
    const onPaneAdded = vi.fn();
    const manager = new PaneManager({
      getAgents: () => [persisted, fresh],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneAdded },
    });

    const result = manager.poll();

    expect(result.added).toEqual([fresh.pane_id]);
    expect(onPaneAdded).toHaveBeenCalledOnce();
    expect(onPaneAdded).toHaveBeenCalledWith(fresh.pane_id);
    expect(manager.mappings().get(42)).toMatchObject({
      pane_id: persisted.pane_id,
      label: persisted.label,
      agent: persisted.agent,
    });
    expect(manager.state().known_tabs?.[persisted.tab_id]).toEqual({
      label: persisted.label,
      thread_id: 42,
    });
  });

  it("sync removes panes that are no longer present", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-1",
      label: "Pane One",
      agent: "pi",
      tab_id: "workspace:tab-1",
      workspace_id: "workspace",
      status: "idle",
    };
    let panes: PaneInfo[] = [pane];
    const state = emptyState();
    state.thread_mappings = {
      42: { pane_id: pane.pane_id, label: pane.label, agent: pane.agent, created_at: "created" },
    };
    state.known_tabs = {
      "workspace:tab-1": { label: pane.label, thread_id: 42 },
    };
    const manager = new PaneManager({
      getAgents: () => panes,
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // Seed the seen set with the known pane so a subsequent disappearance
    // is reported as `removed` (the seen set is the source of truth for
    // dedup — a pane that was never observed cannot be "removed").
    manager.sync();
    panes = [];
    const result = manager.sync();

    expect(result.removed).toEqual(["workspace:pane-1"]);
    expect(manager.mappings()).toEqual(new Map());
    expect(manager.state().known_tabs).toEqual({});
  });


  it("sync reports every current pane as added on the first sync", () => {
    const paneA: PaneInfo = {
      pane_id: "workspace:pane-a",
      label: "Pane A",
      agent: "pi",
      tab_id: "workspace:tab-a",
      workspace_id: "workspace",
      status: "idle",
    };
    const paneB: PaneInfo = {
      pane_id: "workspace:pane-b",
      label: "Pane B",
      agent: "pi",
      tab_id: "workspace:tab-b",
      workspace_id: "workspace",
      status: "idle",
    };
    const manager = new PaneManager({
      getAgents: () => [paneA, paneB],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    const result = manager.sync();

    expect(result.added).toEqual(["workspace:pane-a", "workspace:pane-b"]);
    expect(result.removed).toEqual([]);
    expect(result.renamed).toEqual([]);
  });


  it("second sync returns empty added/removed/renamed when nothing changed", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-stable",
      label: "Stable Pane",
      agent: "pi",
      tab_id: "workspace:tab-stable",
      workspace_id: "workspace",
      status: "idle",
    };
    const manager = new PaneManager({
      getAgents: () => [pane],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // First sync discovers the pane; result.added must include it exactly
    // once. This is the precondition for the seen-set dedup to matter.
    const first = manager.sync();
    expect(first.added).toEqual(["workspace:pane-stable"]);
    expect(first.removed).toEqual([]);
    expect(first.renamed).toEqual([]);

    // Second sync with no pane churn must report zero of every kind of
    // change — otherwise the daemon would re-fire onPaneAdded and mint a
    // duplicate Telegram topic for the same pane.
    const second = manager.sync();
    expect(second.added).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(second.renamed).toEqual([]);
  });


  it("a pane that disappeared is reported as removed and removed from the seen set", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-transient",
      label: "Transient Pane",
      agent: "pi",
      tab_id: "workspace:tab-transient",
      workspace_id: "workspace",
      status: "idle",
    };
    let panes: PaneInfo[] = [pane];
    const manager = new PaneManager({
      getAgents: () => panes,
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // Seed the seen set with the transient pane.
    manager.sync();

    // Pane disappears between syncs.
    panes = [];
    const removalResult = manager.sync();
    expect(removalResult.removed).toEqual(["workspace:pane-transient"]);
    expect(removalResult.added).toEqual([]);
    expect(removalResult.renamed).toEqual([]);

    // Idempotence: with no current panes and the pane evicted from the
    // seen set, a second empty sync must not re-emit the removal.
    const idle = manager.sync();
    expect(idle.added).toEqual([]);
    expect(idle.removed).toEqual([]);
    expect(idle.renamed).toEqual([]);
  });


  it("a pane that reappears after removal is reported as added again", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-flapping",
      label: "Flapping Pane",
      agent: "pi",
      tab_id: "workspace:tab-flapping",
      workspace_id: "workspace",
      status: "idle",
    };
    let panes: PaneInfo[] = [pane];
    const manager = new PaneManager({
      getAgents: () => panes,
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // 1. Initial appearance.
    const initial = manager.sync();
    expect(initial.added).toEqual(["workspace:pane-flapping"]);

    // 2. Pane leaves — must be reported as removed.
    panes = [];
    const gone = manager.sync();
    expect(gone.removed).toEqual(["workspace:pane-flapping"]);

    // 3. Pane comes back — must be reported as added again, proving that
    //    the disappearance cleared it from the seen set.
    panes = [pane];
    const reappeared = manager.sync();
    expect(reappeared.added).toEqual(["workspace:pane-flapping"]);
    expect(reappeared.removed).toEqual([]);
    expect(reappeared.renamed).toEqual([]);

    // 4. Steady state — the re-added pane is once again ignored.
    const stable = manager.sync();
    expect(stable.added).toEqual([]);
    expect(stable.removed).toEqual([]);
    expect(stable.renamed).toEqual([]);
  });


  it("markFailedAdd evicts the pane from the seen-set so the next sync re-emits it", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-retry",
      label: "Retry Pane",
      agent: "pi",
      tab_id: "workspace:tab-retry",
      workspace_id: "workspace",
      status: "idle",
    };
    const manager = new PaneManager({
      getAgents: () => [pane],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // 1. Initial sync discovers the pane and adds it to the seen-set.
    const initial = manager.sync();
    expect(initial.added).toEqual(["workspace:pane-retry"]);

    // 2. The daemon's onPaneAdded hook fails to create a Telegram topic
    //    (e.g. transient network error) and calls markFailedAdd to undo
    //    the seen-set entry. With no mapping persisted, the pane would
    //    otherwise be stuck: not re-emitted by sync, not bound in
    //    known_tabs. The eviction is what unblocks the retry.
    manager.markFailedAdd("workspace:pane-retry");

    // 3. Next sync must re-emit the pane as added. The earlier poll
    //    flushed no mapping (hook threw before restoreTopic), so the
    //    pane genuinely is new from the manager's point of view.
    const retry = manager.sync();
    expect(retry.added).toEqual(["workspace:pane-retry"]);
    expect(retry.removed).toEqual([]);
    expect(retry.renamed).toEqual([]);

    // 4. After the retry the pane is once again in the seen-set; further
    //    syncs are no-ops for `added` until the pane actually disappears.
    const stable = manager.sync();
    expect(stable.added).toEqual([]);
    expect(stable.removed).toEqual([]);
  });


  it("markFailedAdd on a pane that never existed is a safe no-op", () => {
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // Calling markFailedAdd with an unknown id must not throw. The seen-
    // set is the source of truth for which panes have been observed; an
    // id that was never added cannot be evicted, and that's fine.
    expect(() => manager.markFailedAdd("workspace:ghost")).not.toThrow();

    // And a subsequent sync still finds nothing.
    const result = manager.sync();
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });


  it("markAdded is a no-op for subsequent syncs (does not double-add)", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-marked",
      label: "Marked Pane",
      agent: "pi",
      tab_id: "workspace:tab-marked",
      workspace_id: "workspace",
      status: "idle",
    };
    const manager = new PaneManager({
      getAgents: () => [pane],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // 1. Initial sync adds the pane to the seen-set.
    const initial = manager.sync();
    expect(initial.added).toEqual(["workspace:pane-marked"]);

    // 2. Daemon's onPaneAdded hook succeeds and calls markAdded
    //    (defensive — sync already put it in the seen-set).
    manager.markAdded("workspace:pane-marked");

    // 3. Calling markAdded twice more must NOT cause the pane to be
    //    re-emitted. The seen-set is idempotent: duplicate `added`
    //    events would mint duplicate Telegram topics.
    manager.markAdded("workspace:pane-marked");
    manager.markAdded("workspace:pane-marked");

    const stable = manager.sync();
    expect(stable.added).toEqual([]);
    expect(stable.removed).toEqual([]);
    expect(stable.renamed).toEqual([]);
  });


  it("markAdded after markFailedAdd still results in exactly one added event per sync", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-bounce",
      label: "Bounce Pane",
      agent: "pi",
      tab_id: "workspace:tab-bounce",
      workspace_id: "workspace",
      status: "idle",
    };
    const manager = new PaneManager({
      getAgents: () => [pane],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // Round 1: pane appears.
    expect(manager.sync().added).toEqual(["workspace:pane-bounce"]);

    // Hook fails → daemon evicts from the seen-set.
    manager.markFailedAdd("workspace:pane-bounce");

    // Hook re-runs (maybe a retry within the same poll tick) and
    // succeeds this time. It calls markAdded to confirm the seen-set
    // entry. From the manager's point of view the pane is now "added
    // this round" — the next sync must NOT re-emit it.
    manager.markAdded("workspace:pane-bounce");

    expect(manager.sync().added).toEqual([]);
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
      84: {
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
    expect(onPaneRemoved).toHaveBeenCalledWith("workspace:pane-removed", [42, 84]);
  });

  it("calls onPaneRemoved without a thread id when the pane has no mapping", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-unmapped",
      label: "Unmapped Pane",
      agent: "pi",
      tab_id: "workspace:tab-unmapped",
      workspace_id: "workspace",
      status: "idle",
    };
    let panes: PaneInfo[] = [pane];
    const onPaneRemoved = vi.fn();
    const manager = new PaneManager({
      getAgents: () => panes,
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneRemoved },
    });

    manager.poll();
    panes = [];
    manager.poll();

    expect(onPaneRemoved).toHaveBeenCalledWith("workspace:pane-unmapped", undefined);
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

  it("queues a replaced mapping for deletion before deduplicating it", async () => {
    const state = emptyState();
    state.authorized_chat_id = 7;
    state.thread_mappings = {
      42: { pane_id: "workspace:pane-1", label: "Old", agent: "pi", created_at: "created" },
    };
    const deleted = vi.fn(async (_threadId: number) => undefined);
    const manager = new PaneManager({
      getAgents: () => [{ pane_id: "workspace:pane-1", label: "Pane", agent: "pi", tab_id: "tab", workspace_id: "w", status: "idle" }],
      loadState: () => state, saveState: (next) => Object.assign(state, structuredClone(next)),
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPendingTopicDeletion: async (id, deletion) => { await deleted(id); manager.completeTopicDeletion(id, deletion.chat_id); } },
    });

    manager.restoreTopic("tab", 84, "Pane");
    expect(manager.state().pending_topic_deletions?.[42]).toEqual({ pane_id: "workspace:pane-1", chat_id: 7 });
    manager.poll();
    await manager.awaitInflight();
    expect(deleted).toHaveBeenCalledWith(42);
    expect(manager.state().pending_topic_deletions).toBeUndefined();
  });

  it("preserves dedup deletion when each load returns a fresh state snapshot", async () => {
    const state = emptyState();
    state.authorized_chat_id = 7;
    state.thread_mappings = {
      42: { pane_id: "workspace:pane-1", label: "Old", agent: "pi", created_at: "created" },
    };
    let persisted = structuredClone(state);
    const deleteTopic = vi.fn(async () => { throw new Error("temporary Telegram failure"); });
    const manager = new PaneManager({
      getAgents: () => [{ pane_id: "workspace:pane-1", label: "Pane", agent: "pi", tab_id: "tab", workspace_id: "w", status: "idle" }],
      loadState: () => structuredClone(persisted),
      saveState: (next) => { persisted = structuredClone(next); },
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPendingTopicDeletion: async (id, deletion) => {
        try { await deleteTopic(id); } catch { /* remains retryable */ }
        // The next poll is the retry; this hook deliberately does not confirm.
        expect(deletion.chat_id).toBe(7);
      } },
    });

    manager.restoreTopic("tab", 84, "Pane");
    expect(persisted.pending_topic_deletions?.[42]).toEqual({ pane_id: "workspace:pane-1", chat_id: 7 });

    manager.poll();
    await manager.awaitInflight();
    manager.poll();
    await manager.awaitInflight();
    expect(deleteTopic).toHaveBeenCalledTimes(2);
    expect(persisted.pending_topic_deletions?.[42]).toBeDefined();
  });

  it("removes legacy and composite pending keys without confusing same thread ids across chats", () => {
    const state = emptyState();
    state.pending_topic_deletions = {
      "7:42": { pane_id: "pane-a", chat_id: 7 },
      "8:42": { pane_id: "pane-b", chat_id: 8 },
    };
    const manager = new PaneManager({ getAgents: () => [], loadState: () => state, saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent });

    manager.completeTopicDeletion(42, 7);
    expect(manager.state().pending_topic_deletions).toEqual({ "8:42": { pane_id: "pane-b", chat_id: 8 } });
    manager.completeTopicDeletion(42, 8);
    expect(manager.state().pending_topic_deletions).toBeUndefined();
  });

  it("serializes removal behind an in-flight add and a re-add", async () => {
    const pane: PaneInfo = { pane_id: "pane-lock", label: "Lock", agent: "pi", tab_id: "tab-lock", workspace_id: "w", status: "idle" };
    let panes: PaneInfo[] = [pane];
    let release!: () => void;
    const addGate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const manager = new PaneManager({ getAgents: () => panes, loadState: emptyState, saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneAdded: async () => { events.push("add-start"); await addGate; events.push("add-end"); }, onPaneRemoved: () => { events.push("remove"); } },
    });
    manager.poll();
    panes = [];
    manager.poll();
    panes = [pane];
    manager.poll();
    expect(events).toEqual(["add-start"]);
    release();
    await manager.awaitInflight();
    expect(events).toEqual(["add-start", "add-end", "remove", "add-start", "add-end"]);
  });

  it("invalidates every observed pane generation when unpaired", () => {
    const pane: PaneInfo = { pane_id: "pane-unpair-generation", label: "Pane", agent: "pi", tab_id: "tab", workspace_id: "w", status: "idle" };
    const manager = new PaneManager({ getAgents: () => [pane], loadState: emptyState, saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent });
    manager.poll();
    const generation = manager.paneAddGeneration(pane.pane_id);
    expect(manager.isPaneAddCurrent(pane.pane_id, generation)).toBe(true);
    manager.markUnpaired();
    expect(manager.isPaneAddCurrent(pane.pane_id, generation)).toBe(false);
  });

  it("invalidates a cached pane agent generation before clearing the cache", () => {
    const state = emptyState();
    const manager = new PaneManager({
      getAgents: () => [], loadState: () => state, saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });
    const paneId = "pane-cached-only";
    manager.getPaneAgent(paneId);
    const generation = manager.paneAddGeneration(paneId);
    manager.markUnpaired();
    expect(manager.isPaneAddCurrent(paneId, generation)).toBe(false);
  });

  it("unpair deletes every bot-owned topic exactly once", async () => {
    const state = emptyState();
    state.authorized_chat_id = 1234;
    state.known_topics = {
      42: { name: "Known only", created_at: "created" },
      84: { name: "Known and mapped", created_at: "created" },
    };
    state.thread_mappings = {
      84: {
        pane_id: "workspace:pane-1",
        label: "Known and mapped",
        agent: "pi",
        created_at: "created",
      },
      126: {
        pane_id: "workspace:pane-2",
        label: "Mapped only",
        agent: "pi",
        created_at: "created",
      },
    };
    const deleteTopic = vi.fn(async () => undefined);
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    const result = await manager.unpair({ deleteTopic });

    expect(result).toEqual({ deleted: 3 });
    expect(deleteTopic.mock.calls).toEqual([
      [1234, 42],
      [1234, 84],
      [1234, 126],
    ]);
  });

  it("unpair persists empty state", async () => {
    const state: DaemonState = {
      authorized_chat_id: 1234,
      paired_at: "2026-07-30T12:00:00.000Z",
      thread_mappings: {
        42: {
          pane_id: "workspace:pane-1",
          label: "Pane One",
          agent: "pi",
          created_at: "created",
        },
      },
      known_topics: {
        42: { name: "Pane One", created_at: "created" },
      },
      known_tabs: {
        "workspace:tab-1": { label: "Pane One", thread_id: 42 },
      },
      processed_update_ids: [7, 8],
    };
    let persisted: DaemonState | undefined;
    const saveState = vi.fn((saved: DaemonState) => {
      persisted = structuredClone(saved);
    });
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    await manager.unpair({ deleteTopic: async () => undefined });

    const emptyUnpairedState: DaemonState = {
      authorized_chat_id: null,
      paired_at: null,
      thread_mappings: {},
      known_topics: {},
      known_tabs: {},
    };
    expect(manager.state()).toEqual(emptyUnpairedState);
    expect(persisted).toEqual(emptyUnpairedState);
    expect(saveState).toHaveBeenCalledOnce();
  });

  it("unpair stops polling", async () => {
    const state = emptyState();
    state.authorized_chat_id = 1234;
    const stopTimer = vi.fn();
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      scheduleRepeating: () => stopTimer,
    });
    manager.start();

    await manager.unpair({ deleteTopic: async () => undefined });

    expect(stopTimer).toHaveBeenCalledOnce();
  });

  it("markUnpaired resets and persists state without deleting topics", () => {
    const state: DaemonState = {
      authorized_chat_id: 1234,
      paired_at: "2026-07-30T12:00:00.000Z",
      thread_mappings: {
        42: {
          pane_id: "workspace:pane-1",
          label: "Pane One",
          agent: "pi",
          created_at: "created",
        },
      },
      known_topics: {
        42: { name: "Pane One", created_at: "created" },
      },
      known_tabs: {
        "workspace:tab-1": { label: "Pane One", thread_id: 42 },
      },
    };
    const saveState = vi.fn();
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    manager.markUnpaired();

    expect(manager.state()).toEqual({
      authorized_chat_id: null,
      paired_at: null,
      thread_mappings: {},
      known_topics: {},
      known_tabs: {},
    });
    expect(saveState).toHaveBeenCalledOnce();
  });

  it("does not return pane agents after unpair", async () => {
    const state = emptyState();
    state.authorized_chat_id = 1234;
    const agentFactory = vi.fn(
      (paneId: string) => ({ paneId }) as unknown as PaneAgent,
    );
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory,
    });
    expect(manager.getPaneAgent("workspace:pane-1")).toBeDefined();

    await manager.unpair({ deleteTopic: async () => undefined });

    expect(manager.getPaneAgent("workspace:pane-1")).toBeUndefined();
    expect(agentFactory).toHaveBeenCalledOnce();
  });

  it("markPaired followed by getPaneAgent creates an agent", () => {
    // Sanity: the fresh-from-constructor state already has
    // `paneAgentsAvailable = true`, so this is mostly a regression guard
    // for callers that build a manager then immediately
    // markPaired + getPaneAgent (the daemon's /pair path is one such
    // caller — it constructs the manager before pairing, so the flag is
    // already true here, but we want the flag to stay true after the
    // explicit call).
    const agentFactory = vi.fn(
      (paneId: string) => ({ paneId }) as unknown as PaneAgent,
    );
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory,
    });

    manager.markPaired(1234);

    const agent = manager.getPaneAgent("workspace:pane-1");
    expect(agent).toBeDefined();
    expect(agentFactory).toHaveBeenCalledOnce();
    expect(agentFactory).toHaveBeenCalledWith("workspace:pane-1");
    expect(manager.state().authorized_chat_id).toBe(1234);
  });

  it("markPaired stores the chatId and persists state", () => {
    const saveState = vi.fn();
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: emptyState,
      saveState,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    manager.markPaired(9876);

    expect(manager.state().authorized_chat_id).toBe(9876);
    expect(saveState).toHaveBeenCalledOnce();
    expect(saveState).toHaveBeenCalledWith(manager.state());
  });

  it("markPaired reloads paired_at written by the pairing transaction", () => {
    let persisted = emptyState();
    const pairingTimestamp = "2026-08-24T22:00:00.000Z";
    let saved!: DaemonState;
    const manager = new PaneManager({
      getAgents: () => [],
      // Return independent snapshots: a shared object would make this a
      // false positive even if markPaired saved its stale constructor state.
      loadState: () => structuredClone(persisted),
      saveState: (next) => { saved = structuredClone(next); persisted = structuredClone(next); },
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    // Model updatePairing's separate transaction after construction.
    persisted = { ...structuredClone(persisted), authorized_chat_id: 42, paired_at: pairingTimestamp };
    manager.markPaired(42);
    expect(saved.paired_at).toBe(pairingTimestamp);
    expect(saved.paired_at).not.toBeNull();
  });

  it("rejects a stale add after unpair and allows only one topic on reentry", async () => {
    const pane: PaneInfo = { pane_id: "pane-reentry", label: "Reentry", agent: "pi", tab_id: "tab-reentry", workspace_id: "w", status: "idle" };
    let panes: PaneInfo[] = [pane];
    let release!: () => void;
    const pendingAdd = new Promise<void>((resolve) => { release = resolve; });
    const createdTopics: number[] = [];
    const manager = new PaneManager({
      getAgents: () => panes,
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: {
        onPaneAdded: async (paneId) => {
          const generation = manager.paneAddGeneration(paneId);
          await pendingAdd;
          if (!manager.isPaneAddCurrent(paneId, generation)) return;
          createdTopics.push(createdTopics.length + 1);
          manager.restoreTopic(pane.tab_id, createdTopics.at(-1)!, pane.label);
        },
      },
    });

    manager.poll();
    manager.markUnpaired();
    manager.markPaired(7);
    panes = [pane];
    manager.poll();
    release();
    await manager.awaitInflight();

    expect(createdTopics).toHaveLength(1);
    expect(manager.mappings()).toEqual(new Map([[1, expect.objectContaining({ pane_id: pane.pane_id })]]));
  });

  it("bounds confirmed deletion memory and allows evicted keys to retry", async () => {
    const manager = new PaneManager({
      getAgents: () => [], loadState: emptyState, saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });
    const deleteTopic = vi.fn(async () => undefined);

    for (let threadId = 1; threadId <= 256; threadId++) {
      expect(await manager.deleteTopicOnce(threadId, deleteTopic, 9)).toBe(true);
    }
    // The bounded cache retains recent confirmations but cannot grow forever.
    expect(await manager.deleteTopicOnce(256, deleteTopic, 9)).toBe(false);
    expect(await manager.deleteTopicOnce(1, deleteTopic, 9)).toBe(true);
    expect(deleteTopic).toHaveBeenCalledTimes(257);
  });

  it("markPaired after markUnpaired restores getPaneAgent (regression for /pair after /unpair)", async () => {
    // This is the actual bug repro. After /unpair, paneAgentsAvailable is
    // false and getPaneAgent returns undefined. If markPaired does not
    // flip the flag back, the next /pair would still return undefined and
    // /last would silently break. The test exercises the exact sequence:
    // unpair → markPaired → getPaneAgent.
    const state = emptyState();
    state.authorized_chat_id = 1234;
    const agentFactory = vi.fn(
      (paneId: string) => ({ paneId }) as unknown as PaneAgent,
    );
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory,
    });

    // Healthy: a paired manager hands out agents.
    expect(manager.getPaneAgent("workspace:pane-1")).toBeDefined();

    // /unpair blocks new agent creation.
    await manager.unpair({ deleteTopic: async () => undefined });
    expect(manager.getPaneAgent("workspace:pane-1")).toBeUndefined();
    expect(agentFactory).toHaveBeenCalledOnce();

    // /pair must restore the ability to mint agents. The pane id is the
    // same as before — we want a fresh agent from the factory, not a
    // cached undefined.
    manager.markPaired(1234);
    const agent = manager.getPaneAgent("workspace:pane-1");
    expect(agent).toBeDefined();
    expect(agentFactory).toHaveBeenCalledTimes(2);
    expect(agentFactory).toHaveBeenLastCalledWith("workspace:pane-1");
    expect(manager.state().authorized_chat_id).toBe(1234);
  });

  it("reports each pane once when pairing again after unpair cleared state", () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-repair",
      label: "Repair Pane",
      agent: "pi",
      tab_id: "workspace:tab-repair",
      workspace_id: "workspace",
      status: "idle",
    };
    const onPaneAdded = vi.fn();
    const manager = new PaneManager({
      getAgents: () => [pane],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneAdded },
    });

    manager.markUnpaired();
    manager.markPaired(1234);
    const result = manager.poll();

    expect(result.added).toEqual([pane.pane_id]);
    expect(onPaneAdded).toHaveBeenCalledOnce();
    expect(onPaneAdded).toHaveBeenCalledWith(pane.pane_id);
  });

  it("markPaired is idempotent — calling it twice does not produce duplicate agents", () => {
    const agentFactory = vi.fn(
      (paneId: string) => ({ paneId }) as unknown as PaneAgent,
    );
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: emptyState,
      saveState: () => undefined,
      agentFactory,
    });

    manager.markPaired(1234);
    manager.markPaired(1234);

    const first = manager.getPaneAgent("workspace:pane-1");
    const second = manager.getPaneAgent("workspace:pane-1");
    expect(first).toBe(second);
    expect(agentFactory).toHaveBeenCalledOnce();
  });

  it("unpair continues after an already-deleted topic and counts successful deletions", async () => {
    const state = emptyState();
    state.authorized_chat_id = 1234;
    state.known_topics = {
      42: { name: "Already gone", created_at: "created" },
      84: { name: "Still present", created_at: "created" },
    };
    const deleteTopic = vi.fn(async (_chatId: number, threadId: number) => {
      if (threadId === 42) throw new Error("TOPIC_ID_INVALID");
    });
    const manager = new PaneManager({
      getAgents: () => [],
      loadState: () => state,
      saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    const result = await manager.unpair({ deleteTopic });

    expect(deleteTopic.mock.calls).toEqual([
      [1234, 42],
      [1234, 84],
    ]);
    expect(result).toEqual({ deleted: 1 });
    expect(manager.state().authorized_chat_id).toBeNull();
  });

  describe("awaitInflight", () => {
    it("resolves immediately when no hooks are tracked", async () => {
      const manager = new PaneManager({
        getAgents: () => [],
        loadState: emptyState,
        saveState: () => undefined,
        agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      });

      // No poll() has fired any hooks; awaitInflight must not block.
      await expect(manager.awaitInflight()).resolves.toBeUndefined();
    });

    it("waits for an async onPaneAdded hook to settle before resolving", async () => {
      let resolveHook!: () => void;
      const hookSettled = new Promise<void>((r) => { resolveHook = r; });
      const onPaneAdded = vi.fn(async (_paneId: string) => {
        await hookSettled;
      });
      const pane: PaneInfo = {
        pane_id: "workspace:pane-async",
        label: "Async Pane",
        agent: "pi",
        tab_id: "workspace:tab-async",
        workspace_id: "workspace",
        status: "idle",
      };
      const manager = new PaneManager({
        getAgents: () => [pane],
        loadState: emptyState,
        saveState: () => undefined,
        agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
        hooks: { onPaneAdded },
      });

      manager.poll();

      // The hook has been invoked but awaits our manual `resolveHook()`.
      // `awaitInflight()` must NOT resolve yet — otherwise the daemon's
      // "/pair" reply would be sent before the topic is created.
      let inflightResolved = false;
      const inflight = manager.awaitInflight().then(() => {
        inflightResolved = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(inflightResolved).toBe(false);
      expect(onPaneAdded).toHaveBeenCalledOnce();

      // Settle the hook; awaitInflight must now resolve.
      resolveHook();
      await hookSettled;
      await inflight;
      expect(inflightResolved).toBe(true);
    });

    it("resolves even when a tracked hook rejects", async () => {
      // Run the failing hook promise in the open and immediately attach
      // a no-op `.catch` so Vitest's unhandled-rejection tracker does not
      // trip while we drive the assertion. The manager still observes the
      // settle via its own `track()` plumbing.
      const hookCall = vi.fn(async (_paneId: string) => {
        throw new Error("telegram exploded");
      });
      const pane: PaneInfo = {
        pane_id: "workspace:pane-fail",
        label: "Failing Pane",
        agent: "pi",
        tab_id: "workspace:tab-fail",
        workspace_id: "workspace",
        status: "idle",
      };
      const manager = new PaneManager({
        getAgents: () => [pane],
        loadState: emptyState,
        saveState: () => undefined,
        agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
        hooks: { onPaneAdded: hookCall },
      });

      manager.poll();
      // The hook was invoked but its returned promise rejects. awaitInflight
      // must NOT propagate that rejection — otherwise the daemon's /pair
      // handler would crash. The hook itself owns the error logging; the
      // manager only tracks settle/drain semantics here.
      await expect(manager.awaitInflight()).resolves.toBeUndefined();
      // Drain the rejection locally to avoid Vitest unhandled-rejection noise.
      await hookCall.mock.results[0].value.catch(() => undefined);
      expect(hookCall).toHaveBeenCalledOnce();
    });

    it("drains hook work fired across multiple polls", async () => {
      let panes: PaneInfo[] = [];
      let resolveFirst!: () => void;
      const firstSettled = new Promise<void>((r) => { resolveFirst = r; });
      let firstSeen = false;
      const onPaneAdded = vi.fn(async (paneId: string) => {
        if (!firstSeen && paneId === "workspace:pane-first") {
          firstSeen = true;
          await firstSettled;
        }
      });
      const manager = new PaneManager({
        getAgents: () => panes,
        loadState: emptyState,
        saveState: () => undefined,
        agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
        hooks: { onPaneAdded },
      });

      panes = [
        {
          pane_id: "workspace:pane-first",
          label: "First",
          agent: "pi",
          tab_id: "workspace:tab-first",
          workspace_id: "workspace",
          status: "idle",
        },
      ];
      manager.poll();

      // Poll again with a second pane while the first hook is still
      // in-flight. awaitInflight() must drain BOTH.
      panes = [
        ...panes,
        {
          pane_id: "workspace:pane-second",
          label: "Second",
          agent: "pi",
          tab_id: "workspace:tab-second",
          workspace_id: "workspace",
          status: "idle",
        },
      ];
      manager.poll();

      expect(onPaneAdded).toHaveBeenCalledTimes(2);

      // Settle the first; awaitInflight must then resolve (the second
      // hook was synchronous).
      resolveFirst();
      await firstSettled;
      await manager.awaitInflight();
    });
  });

  it("persists removed topic ids until deletion is confirmed and retries them", async () => {
    const pane: PaneInfo = {
      pane_id: "workspace:p-durable", label: "Durable", agent: "pi",
      tab_id: "workspace:t-durable", workspace_id: "workspace", status: "idle",
    };
    const state = emptyState();
    state.authorized_chat_id = 7;
    state.thread_mappings = { 42: { pane_id: pane.pane_id, label: pane.label, agent: pane.agent, created_at: "created" } };
    let panes: PaneInfo[] = [pane];
    const deleteTopic = vi.fn(async () => { throw new Error("temporary Telegram failure"); });
    const manager = new PaneManager({
      getAgents: () => panes, loadState: () => state, saveState: (next) => Object.assign(state, structuredClone(next)),
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneRemoved: async (_id, ids) => { for (const id of ids ?? []) await deleteTopic(7, id); } },
    });

    manager.poll();
    panes = [];
    manager.poll();
    await manager.awaitInflight();
    expect(manager.state().pending_topic_deletions?.[42]).toMatchObject({ pane_id: pane.pane_id, chat_id: 7 });

    await manager.unpair({ deleteTopic });
    expect(deleteTopic).toHaveBeenCalledWith(7, 42);
  });

  it("keeps a known topic in the durable deletion queue when unpair deletion fails", async () => {
    const state = emptyState();
    state.authorized_chat_id = 7;
    state.known_topics = { 99: { name: "orphan", created_at: "created" } };
    let persisted: DaemonState | undefined;
    const manager = new PaneManager({
      getAgents: () => [], loadState: () => state,
      saveState: (next) => { persisted = structuredClone(next); },
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
    });

    await manager.unpair({ deleteTopic: async () => { throw new Error("temporary failure"); } });

    expect(persisted?.pending_topic_deletions?.[99]).toEqual({ pane_id: "unknown", chat_id: 7 });
    expect(manager.state().pending_topic_deletions?.[99]).toEqual({ pane_id: "unknown", chat_id: 7 });
  });

  it("invalidates an add generation when a pane disappears before its hook settles", async () => {
    const pane: PaneInfo = {
      pane_id: "workspace:pane-generation", label: "Generation", agent: "pi",
      tab_id: "workspace:tab-generation", workspace_id: "workspace", status: "idle",
    };
    let panes: PaneInfo[] = [pane];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let generation = -1;
    const manager = new PaneManager({
      getAgents: () => panes, loadState: emptyState, saveState: () => undefined,
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneAdded: async (paneId) => {
        generation = manager.paneAddGeneration(paneId);
        await blocked;
      } },
    });

    manager.poll();
    panes = [];
    manager.poll();
    expect(manager.isPaneAddCurrent(pane.pane_id, generation)).toBe(false);
    release();
    await manager.awaitInflight();
  });

  it("does not discard persisted mappings on an empty first snapshot", () => {
    const state = emptyState();
    state.thread_mappings = { 42: { pane_id: "workspace:persisted", label: "Persisted", agent: "pi", created_at: "created" } };
    let panes: PaneInfo[] = [];
    const manager = new PaneManager({
      getAgents: () => panes, loadState: () => state, saveState: (next) => Object.assign(state, structuredClone(next)),
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      hooks: { onPaneAdded: vi.fn() },
    });

    expect(manager.poll()).toEqual({ added: [], removed: [], renamed: [] });
    panes = [{ pane_id: "workspace:persisted", label: "Persisted", agent: "pi", tab_id: "workspace:t", workspace_id: "workspace", status: "idle" }];
    expect(manager.poll().added).toEqual([]);
    expect(manager.mappings().get(42)?.pane_id).toBe("workspace:persisted");
  });

  it("prunes on the second confirmed empty snapshot when configured for two", () => {
    const state = emptyState();
    state.thread_mappings = { 42: { pane_id: "persisted", label: "Persisted", agent: "pi", created_at: "created" } };
    let panes: PaneInfo[] = [];
    const manager = new PaneManager({
      getAgents: () => panes, loadState: () => structuredClone(state), saveState: (next) => Object.assign(state, structuredClone(next)),
      agentFactory: (paneId) => ({ paneId }) as unknown as PaneAgent,
      emptySnapshotConfirmations: 2,
    });
    manager.poll();
    expect(manager.mappings().get(42)).toBeDefined();
    manager.poll();
    expect(manager.mappings()).toEqual(new Map());
  });
});
