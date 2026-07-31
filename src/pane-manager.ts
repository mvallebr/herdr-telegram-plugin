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

export interface UnpairArgs {
  deleteTopic: (chatId: number, threadId: number) => Promise<void>;
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
  >;
  /**
   * Pane ids already observed by this manager instance. Decouples "added"
   * detection from `thread_mappings`: on the first poll every pane is
   * reported as added, but once observed the pane is only reported as added
   * again after it has left and re-entered the seen set. Without this, a
   * pane whose add triggered an async topic-create callback that has not
   * yet written back its thread mapping would be re-reported as added on
   * every subsequent poll, causing the daemon to mint duplicate Telegram
   * topics.
   */
  private readonly seenPanes = new Set<string>();
  private currentState: DaemonState;
  private stopRepeating?: () => void;
  private paneAgentsAvailable = true;

  constructor(private readonly deps: PaneManagerDeps) {
    this.currentState = deps.loadState();
  }

  getPaneAgent(paneId: string): PaneAgent | undefined {
    if (!this.paneAgentsAvailable) return undefined;

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

  /**
   * Re-run the sync and emit lifecycle hooks once. Public so the daemon can
   * trigger an on-demand reconcile (e.g. on `/reconcile` or after `/pair`)
   * without depending on the periodic schedule.
   *
   * The recurring poll started by `start()` also goes through this method.
   *
   * Always reloads state from disk before syncing so concurrent daemon-side
   * mutations (e.g. `/pair` flipping `authorized_chat_id`, `/bind` adding a
   * manual mapping) are visible. Without this, the manager would overwrite
   * those changes with its stale in-memory snapshot on the next save.
   */
  poll(): SyncResult {
    this.currentState = this.deps.loadState();
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
    return result;
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

      // First time this pane id is seen, emit `added` and remember it.
      // Subsequent syncs are no-ops for `added` until the pane leaves and
      // drops out of the seen set.
      if (!this.seenPanes.has(pane.pane_id)) {
        added.push(pane.pane_id);
        this.seenPanes.add(pane.pane_id);
      }
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

    // Panes we previously saw but which are no longer present must be
    // emitted as `removed` and evicted from the seen set so a later
    // reappearance is reported as a fresh `added` again.
    for (const paneId of [...this.seenPanes]) {
      if (!currentPaneIds.has(paneId)) {
        removed.push(paneId);
        this.seenPanes.delete(paneId);
      }
    }

    // Drop stale mappings whose pane has disappeared; this is independent
    // of `removed` (driven by the seen set) so the two lists stay in sync.
    for (const [threadId, mapping] of [...mappings]) {
      if (!currentPaneIds.has(mapping.pane_id)) {
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

  async unpair(args: UnpairArgs): Promise<{ deleted: number }> {
    this.stop();
    const chatId = this.currentState.authorized_chat_id;

    const threadIds = new Set<number>();
    for (const threadId of Object.keys(this.currentState.known_topics ?? {})) {
      threadIds.add(Number(threadId));
    }
    for (const threadId of Object.keys(this.currentState.thread_mappings)) {
      threadIds.add(Number(threadId));
    }

    let deleted = 0;
    if (chatId !== null) {
      for (const threadId of threadIds) {
        try {
          await args.deleteTopic(chatId, threadId);
          deleted += 1;
        } catch {
          this.deps.logger?.warn("topic deletion failed during unpair", {
            threadId,
          });
        }
      }
    }

    this.markUnpaired();
    return { deleted };
  }

  markUnpaired(): void {
    this.paneAgents.clear();
    this.paneAgentsAvailable = false;
    this.seenPanes.clear();
    this.currentState.authorized_chat_id = null;
    this.currentState.paired_at = null;
    this.currentState.thread_mappings = {};
    this.currentState.known_topics = {};
    this.currentState.known_tabs = {};
    delete this.currentState.processed_update_ids;
    this.deps.saveState(this.currentState);
  }

  /**
   * Explicitly mark a pane id as "added" in the seen-set. Idempotent: a no-op
   * if the pane is already in the set. The daemon's `onPaneAdded` hook calls
   * this after a successful topic-create so the next `sync()` does not
   * re-emit the pane — mirroring what `restoreTopic` already implies (the
   * pane is now bound to a Telegram topic). Without this call, an external
   * eviction (e.g. `markUnpaired`, future code paths) could leave the pane
   * outside the seen-set and cause the daemon to mint a duplicate topic.
   */
  markAdded(paneId: string): void {
    this.seenPanes.add(paneId);
  }

  /**
   * Evict a pane id from the seen-set so the next `sync()` reports it as
   * added again. Used by the daemon when its `onPaneAdded` hook fails to
   * create the Telegram topic (e.g. transient Telegram error, invalid
   * thread id, or a thrown exception inside `restoreTopic`). Without this,
   * a pane whose first topic-create failed would be permanently stuck:
   * `sync()` would not re-emit it (so no retry) but no `known_tabs` entry
   * would exist either (so the user has no way to interact with it).
   */
  markFailedAdd(paneId: string): void {
    this.seenPanes.delete(paneId);
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
