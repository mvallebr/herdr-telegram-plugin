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

export interface DeadTopic {
  tabId: string;
  threadId: number;
  label: string;
}

export interface HealthCheckResult {
  dead: DeadTopic[];
  /** Always false — `healthCheck` never persists. The daemon owns persistence. */
  persisted: false;
}

export interface HealthCheckArgs {
  chatId: number;
  /**
   * Caller-supplied Telegram ping. Resolves to a falsy value when the thread
   * is alive and either throws or resolves to a truthy error value when the
   * thread is dead (e.g. `TOPIC_ID_INVALID`).
   */
  sendChatAction: (chatId: number, threadId: number) => Promise<unknown>;
}

export interface PaneManagerDeps {
  getAgents: () => PaneInfo[];
  loadState: () => DaemonState;
  saveState: (state: DaemonState) => void;
  agentFactory: (paneId: string) => PaneAgent;
  hooks?: PaneManagerHooks;
  logger?: Logger;
  intervalMs?: number;
  scheduleRepeating?: (fn: () => void, intervalMs: number) => () => void;
}

const scheduleRepeating = (fn: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(fn, intervalMs);
  return () => clearInterval(timer);
};

export class PaneManager {
  private readonly paneAgents = new Map<string, PaneAgent>();
  private readonly renamedLabels = new Map<
    string,
    { oldLabel: string; newLabel: string }
  >();
  private readonly currentState: DaemonState;
  private stopRepeating?: () => void;

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

  start(): void {
    this.poll();
    this.stopRepeating = (this.deps.scheduleRepeating ?? scheduleRepeating)(
      () => this.poll(),
      this.deps.intervalMs ?? 15_000,
    );
  }

  stop(): void {
    this.stopRepeating?.();
    this.stopRepeating = undefined;
  }

  private poll(): void {
    const result = this.sync();
    for (const paneId of result.added) {
      this.deps.hooks?.onPaneAdded?.(paneId);
    }
    for (const paneId of result.removed) {
      this.deps.hooks?.onPaneRemoved?.(paneId);
    }
    for (const paneId of result.renamed) {
      const labels = this.renamedLabels.get(paneId);
      if (labels) {
        this.deps.hooks?.onPaneRenamed?.(
          paneId,
          labels.oldLabel,
          labels.newLabel,
        );
      }
    }
  }

  sync(): SyncResult {
    this.renamedLabels.clear();
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
        this.renamedLabels.set(pane.pane_id, {
          oldLabel,
          newLabel: pane.label,
        });
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

  /**
   * Ping every known Telegram topic through the caller-supplied
   * `sendChatAction`. Threads that throw or resolve to a truthy error are
   * reported as dead so the daemon can recreate them.
   *
   * Does NOT touch Telegram directly and does NOT persist state — the daemon
   * drives both side effects after deciding what to do with `dead`.
   */
  async healthCheck(args: HealthCheckArgs): Promise<HealthCheckResult> {
    const knownTabs = this.currentState.known_tabs ?? {};
    const entries = Object.entries(knownTabs);

    const settled = await Promise.all(
      entries.map(async ([tabId, entry]): Promise<DeadTopic | null> => {
        try {
          const result = await args.sendChatAction(args.chatId, entry.thread_id);
          if (result) {
            return { tabId, threadId: entry.thread_id, label: entry.label };
          }
          return null;
        } catch {
          return { tabId, threadId: entry.thread_id, label: entry.label };
        }
      }),
    );

    return {
      dead: settled.filter((entry): entry is DeadTopic => entry !== null),
      persisted: false,
    };
  }

  /**
   * Record a freshly-created Telegram topic in both `known_tabs` and
   * `thread_mappings`. Called by the daemon after `createForumTopic` succeeds
   * for a tab reported as dead by `healthCheck`.
   *
   * Persists state immediately so the new mapping survives a restart.
   */
  restoreTopic(tabId: string, threadId: number, label: string): void {
    const knownTabs = this.currentState.known_tabs ?? {};
    knownTabs[tabId] = { label, thread_id: threadId };
    this.currentState.known_tabs = knownTabs;

    const panes = this.deps.getAgents();
    const pane = panes.find((candidate) => candidate.tab_id === tabId);
    const mapping: ThreadMapping = {
      pane_id: pane?.pane_id ?? tabId,
      label,
      agent: pane?.agent ?? "unknown",
      created_at: new Date().toISOString(),
    };
    this.currentState.thread_mappings[threadId] = mapping;
    this.deps.saveState(this.currentState);
  }
}
