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
