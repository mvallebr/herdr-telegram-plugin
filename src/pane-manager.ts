import type { Logger } from "./logger.js";
import type { PaneAgent } from "./pane-agent.js";
import type { DaemonState, PaneInfo, ThreadMapping } from "./types.js";

export interface PaneManagerHooks {
  onPaneAdded?: (paneId: string) => void;
  onPaneRemoved?: (paneId: string) => void;
  onPaneRenamed?: (
    paneId: string,
    oldLabel: string,
    newLabel: string,
  ) => void;
}

export interface SyncResult {
  added: string[];
  removed: string[];
  renamed: string[];
}

export interface PaneManagerDeps {
  getAgents: () => PaneInfo[];
  loadState: () => DaemonState;
  saveState: (state: DaemonState) => void;
  agentFactory: (paneId: string) => PaneAgent;
  hooks?: PaneManagerHooks;
  logger?: Logger;
}

export class PaneManager {
  private readonly paneAgents = new Map<string, PaneAgent>();
  private readonly currentState: DaemonState;

  constructor(private readonly deps: PaneManagerDeps) {
    this.currentState = deps.loadState();
  }

  getPaneAgent(paneId: string): PaneAgent | undefined {
    let agent = this.paneAgents.get(paneId);
    if (!agent) {
      agent = this.deps.agentFactory(paneId);
      this.paneAgents.set(paneId, agent);
    }
    return agent;
  }

  state(): DaemonState {
    return this.currentState;
  }

  sync(): SyncResult {
    const panes = this.deps.getAgents();
    const knownTabs = this.currentState.known_tabs ?? {};
    this.currentState.known_tabs = knownTabs;

    const mappings = new Map<number, ThreadMapping>(
      Object.entries(this.currentState.thread_mappings).map(([threadId, mapping]) => [
        Number(threadId),
        mapping,
      ]),
    );
    const currentPaneIds = new Set(panes.map((pane) => pane.pane_id));
    const added: string[] = [];
    const removed: string[] = [];
    const renamed: string[] = [];

    for (const pane of panes) {
      const existingEntry = [...mappings.entries()].find(
        ([, mapping]) => mapping.pane_id === pane.pane_id,
      );
      const knownTab = knownTabs[pane.tab_id];
      const threadId = existingEntry?.[0] ?? knownTab?.thread_id;
      const oldLabel = existingEntry?.[1].label ?? knownTab?.label;

      if (!existingEntry) added.push(pane.pane_id);
      if (oldLabel !== undefined && oldLabel !== pane.label) {
        renamed.push(pane.pane_id);
      }

      if (threadId !== undefined) {
        const previous = existingEntry?.[1];
        mappings.set(threadId, {
          pane_id: pane.pane_id,
          label: pane.label,
          agent: pane.agent,
          created_at: previous?.created_at ?? new Date().toISOString(),
        });
        knownTabs[pane.tab_id] = { label: pane.label, thread_id: threadId };
      }
    }

    for (const [threadId, mapping] of mappings) {
      if (!currentPaneIds.has(mapping.pane_id)) {
        removed.push(mapping.pane_id);
        mappings.delete(threadId);
      }
    }
    const currentTabIds = new Set(panes.map((pane) => pane.tab_id));
    for (const tabId of Object.keys(knownTabs)) {
      if (!currentTabIds.has(tabId)) delete knownTabs[tabId];
    }

    this.currentState.thread_mappings = Object.fromEntries(mappings);
    this.deps.saveState(this.currentState);
    return { added, removed, renamed };
  }

  mappings(): Map<number, ThreadMapping> {
    const mappings = new Map<number, ThreadMapping>();
    for (const [threadId, mapping] of Object.entries(
      this.currentState.thread_mappings,
    )) {
      mappings.set(Number(threadId), mapping);
    }
    return mappings;
  }
}
