import type { Logger } from "./logger.js";
import type { PaneAgent } from "./pane-agent.js";
import type { DaemonState, PaneInfo, PendingTopicDeletion, ThreadMapping } from "./types.js";

/**
 * Lifecycle hooks fired by `poll()` after `sync()` classifies each pane as
 * added / removed / renamed. Hooks MAY be async; the manager tracks every
 * returned promise in an in-flight set so callers like `/pair` or
 * `/reconcile` can `await paneManager.awaitInflight()` and observe the
 * resulting state (e.g. freshly created Telegram topic mappings) before
 * reporting back to the user.
 *
 * Returning `void` is allowed for hooks that complete synchronously.
 */
export interface PaneManagerHooks {
  onPaneAdded?: (paneId: string, generation?: number) => Promise<unknown> | void;
  /** The second argument contains every topic mapping removed during this sync, when any existed. */
  onPaneRemoved?: (paneId: string, threadIds?: number[]) => Promise<unknown> | void;
  onPaneRenamed?: (
    paneId: string,
    oldLabel: string,
    newLabel: string,
  ) => Promise<unknown> | void;
  onPendingTopicDeletion?: (threadId: number, deletion: PendingTopicDeletion) => Promise<unknown> | void;
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
  onStateChanged?: () => void;
  /** Number of consecutive empty herdr snapshots required before pruning. */
  emptySnapshotConfirmations?: number;
}

const scheduleRepeating = (fn: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(fn, intervalMs);
  return () => clearInterval(timer);
};

/** Keep duplicate-delete suppression bounded; thread ids are untrusted history. */
const MAX_CONFIRMED_DELETIONS = 200;

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
  /**
   * Promises returned by hooks fired from the most recent `poll()` (and
   * any polls that have not yet had their hooks drain). Removed on settle.
   * Used by `awaitInflight()` so the `/pair` and `/reconcile` handlers can
   * wait for the daemon's `onPaneAdded` hook — which calls
   * `tg.createForumTopic` and then `restoreTopic` — to write its mapping
   * into state before the handler reports "Reconciled: N panes mapped."
   * Without this, the count was snapshotted before the hooks completed
   * and read as zero.
   */
  private readonly inFlightHooks = new Set<Promise<unknown>>();
  /** Thread mappings evicted by the most recent sync, retained for removal hooks. */
  private readonly removedThreadIds = new Map<string, number[]>();
  private readonly paneGenerations = new Map<string, number>();
  private readonly inFlightDeletions = new Set<string | number>();
  private readonly confirmedDeletions = new Set<string | number>();
  private readonly paneLocks = new Map<string, Promise<void>>();
  private currentState: DaemonState;
  private stopRepeating?: () => void;
  private paneAgentsAvailable = true;
  private hasPolled = false;
  private emptySnapshotStreak = 0;

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
   *
   * Hooks are tracked via `track()` so `awaitInflight()` can wait for them
   * to settle. Callers that want to observe side effects of the hook (e.g.
   * the daemon's `onPaneAdded` writing a `thread_mappings` entry via
   * `restoreTopic`) must `await` `awaitInflight()` before reading state.
   */
  poll(): SyncResult {
    this.currentState = this.deps.loadState();
    const pendingBeforeSync = new Set(Object.keys(this.currentState.pending_topic_deletions ?? {}));
    const result = this.sync();
    for (const threadId of pendingBeforeSync) {
      // If this poll also discovered the mapping as removed, the removal
      // hook owns the first deletion attempt. Avoid racing it with the
      // durable-queue hook (a successful delete would otherwise be sent
      // twice); a failed attempt leaves the queue for the next poll.
      if ([...this.removedThreadIds.values()].some((ids) => ids.includes(this.pendingThreadId(threadId)))) continue;
      const deletion = this.currentState.pending_topic_deletions?.[threadId];
      if (deletion) {
        this.track(this.deps.hooks?.onPendingTopicDeletion?.(this.pendingThreadId(threadId), deletion));
      }
    }
    for (const paneId of result.added) {
      this.track(this.withPaneLock(paneId, () =>
        // Keep the original one-argument hook contract; hooks can obtain the
        // generation atomically through paneAddGeneration before awaiting.
        this.deps.hooks?.onPaneAdded?.(paneId)));
    }
    for (const paneId of result.removed) {
      const threadIds = this.removedThreadIds.get(paneId);
      this.track(this.withPaneLock(paneId, () =>
        this.deps.hooks?.onPaneRemoved?.(paneId, threadIds)));
    }
    for (const paneId of result.renamed) {
      const labels = this.renamedLabels.get(paneId);
      if (labels) {
        this.track(
          this.deps.hooks?.onPaneRenamed?.(
            paneId,
            labels.oldLabel,
            labels.newLabel,
          ),
        );
      }
    }
    return result;
  }

  /** Serialize add/remove work for one pane. A pane may disappear and be
   * recreated while Telegram is still creating its old topic. */
  private withPaneLock(paneId: string, work: () => Promise<unknown> | void): Promise<void> {
    const previous = this.paneLocks.get(paneId);
    let next: Promise<void>;
    if (previous) {
      next = previous.catch(() => undefined).then(() => work()).then(() => undefined);
      this.paneLocks.set(paneId, next);
      void next.then(() => {
        if (this.paneLocks.get(paneId) === next) this.paneLocks.delete(paneId);
      }, () => {
        if (this.paneLocks.get(paneId) === next) this.paneLocks.delete(paneId);
      });
      return next;
    } else {
      try {
        const result = work();
        // Do not retain an already-completed synchronous hook as a lock. This
        // keeps lifecycle callbacks observable synchronously while async add /
        // remove work still forms a real queue.
        if (!result || typeof (result as Promise<unknown>).then !== "function") return Promise.resolve();
        next = Promise.resolve(result).then(() => undefined);
      } catch (error) {
        next = Promise.reject(error);
      }
    }
    this.paneLocks.set(paneId, next);
    void next.then(() => {
      if (this.paneLocks.get(paneId) === next) this.paneLocks.delete(paneId);
    }, () => {
      if (this.paneLocks.get(paneId) === next) this.paneLocks.delete(paneId);
    });
    return next;
  }

  /**
   * Register a hook promise so `awaitInflight()` can observe it. The promise
   * is removed from the in-flight set when it settles (success OR failure)
   * so transient hook errors do not block subsequent awaits.
   *
   * The rejection is consumed here on purpose: the manager only owns the
   * "are hooks done?" question. Surfacing hook errors to its callers would
   * risk crashes in innocent contexts (e.g. the recurring 15-second poll,
   * or the `/pair` reply path) for failures the hook itself is already
   * responsible for logging. The daemon's `onPaneAdded`/`onPaneRemoved`/
   * `onPaneRenamed` already wrap their bodies in try/catch and call
   * `markFailedAdd` on transient Telegram failures, so this consumer is
   * only the "last line of defence" against an unhandled rejection.
   */
  private track(promise: Promise<unknown> | void | undefined): void {
    if (!promise) return;
    this.inFlightHooks.add(promise);
    promise
      .catch(() => undefined)
      .finally(() => {
        this.inFlightHooks.delete(promise);
      });
  }

  /**
   * Resolve once every hook fired by `poll()` since the last `awaitInflight()`
   * call has settled. Used by `/pair` and `/reconcile` to ensure that
   * `tg.createForumTopic` + `restoreTopic` work initiated by the daemon's
   * `onPaneAdded` hook has written its `thread_mappings` entry before the
   * reply "Reconciled: N panes mapped." is sent. Without this, the count
   * was snapshotted against stale state and read as zero even though the
   * hook was about to mint the new topics a moment later.
   *
   * Loops in case hooks enqueue more hook work (rare but possible if a
   * hook calls `poll()` itself). Resolves immediately if no hooks are
   * currently in flight.
   */
  async awaitInflight(): Promise<void> {
    while (this.inFlightHooks.size > 0) {
      const snapshot = [...this.inFlightHooks];
      await Promise.allSettled(snapshot);
    }
  }

  sync(): SyncResult {
    this.renamedLabels.clear();
    this.removedThreadIds.clear();
    const panes = this.deps.getAgents();
    const knownTabs = this.currentState.known_tabs ?? {};
    this.currentState.known_tabs = knownTabs;

    const mappings = new Map<number, ThreadMapping>(
      Object.entries(this.currentState.thread_mappings).map(([threadId, mapping]) => [
        Number(threadId),
        mapping,
      ]),
    );
    // An empty first snapshot is also what herdr exposes during a transient
    // restart/unavailability. Never turn that unconfirmed snapshot into data
    // loss; a later non-empty snapshot can adopt these mappings normally.
    const emptyConfirmations = this.deps.emptySnapshotConfirmations ?? 1;
    if (panes.length === 0 && (mappings.size > 0 || Object.keys(knownTabs).length > 0)) {
      this.emptySnapshotStreak += 1;
    } else if (panes.length > 0) {
      this.emptySnapshotStreak = 0;
    }
    const preserveUnconfirmedEmpty = panes.length === 0 &&
      (!this.hasPolled || (emptyConfirmations > 1 && this.emptySnapshotStreak < emptyConfirmations)) &&
      (mappings.size > 0 || Object.keys(knownTabs).length > 0);
    if (preserveUnconfirmedEmpty) {
      for (const mapping of mappings.values()) this.seenPanes.add(mapping.pane_id);
      this.hasPolled = true;
      return { added: [], removed: [], renamed: [] };
    }
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

      // A mapping loaded from state means this pane was already paired before
      // this manager instance started. Adopt it into the in-memory seen set,
      // but do not emit `added`: doing so would make the daemon create a
      // duplicate Telegram topic after every restart. Panes without a
      // persisted mapping are genuinely new and still go through the add
      // hook. Subsequent syncs are no-ops for `added` until a pane leaves and
      // drops out of the seen set.
      if (!this.seenPanes.has(pane.pane_id)) {
        if (threadId === undefined) added.push(pane.pane_id);
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
        this.paneGenerations.set(paneId, (this.paneGenerations.get(paneId) ?? 0) + 1);
        removed.push(paneId);
        this.seenPanes.delete(paneId);
      }
    }

    // Drop stale mappings whose pane has disappeared; this is independent
    // of `removed` (driven by the seen set) so the two lists stay in sync.
    for (const [threadId, mapping] of [...mappings]) {
      if (!currentPaneIds.has(mapping.pane_id)) {
        // Capture the id before evicting the mapping. poll() emits the hook
        // after this cleanup, so looking in currentState from the hook would
        // otherwise lose the only reference to the Telegram topic.
        const removedThreadIds = this.removedThreadIds.get(mapping.pane_id) ?? [];
        removedThreadIds.push(threadId);
        this.removedThreadIds.set(mapping.pane_id, removedThreadIds);
        this.setPendingDeletion(threadId, {
          pane_id: mapping.pane_id,
          chat_id: this.currentState.authorized_chat_id ?? 0,
        });
        mappings.delete(threadId);
      }
    }
    const currentTabIds = new Set(panes.map((pane) => pane.tab_id));
    for (const tabId of Object.keys(knownTabs)) {
      if (!currentTabIds.has(tabId)) delete knownTabs[tabId];
    }

    this.currentState.thread_mappings = Object.fromEntries(mappings);
    this.deps.saveState(this.currentState);
    this.deps.onStateChanged?.();
    this.hasPolled = true;
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
    for (const [key, deletion] of Object.entries(this.currentState.pending_topic_deletions ?? {})) {
      if (deletion.chat_id === chatId || chatId === null) {
        threadIds.add(this.pendingThreadId(key));
      }
    }

    let deleted = 0;
    if (chatId !== null) {
      for (const threadId of threadIds) {
        try {
          const pending = this.findPendingDeletion(threadId, chatId);
          if (!pending) {
            const mapping = this.currentState.thread_mappings[threadId];
            this.currentState.pending_topic_deletions ??= {};
            this.setPendingDeletion(threadId, {
              pane_id: mapping?.pane_id ?? "unknown",
              chat_id: chatId,
            });
          }
          await args.deleteTopic(pending?.chat_id ?? chatId, threadId);
          deleted += 1;
          this.removePendingDeletion(threadId, chatId);
        } catch (err) {
          // Telegram reports an already removed topic as an error. It is
          // nevertheless a successful end state for our durable queue.
          if (this.isMissingTopicError(err)) {
            this.removePendingDeletion(threadId, chatId);
          } else {
            // The id was not previously in the durable queue (for example it
            // came only from known_topics). Persist the materialized entry so
            // a failed unpair cannot lose the topic after markUnpaired.
            this.deps.saveState(this.currentState);
          }
          this.deps.logger?.warn("topic deletion failed during unpair", {
            threadId,
          });
        }
      }
    }

    this.markUnpaired();
    return { deleted };
  }

  private isMissingTopicError(err: unknown): boolean {
    return /TOPIC_ID_INVALID|message thread.*not found|topic.*not found/i.test(String(err));
  }

  markUnpaired(): void {
    // Capture cached agents before clearing them: their pane ids are part of
    // the generation invalidation boundary for in-flight add hooks.
    const invalidatedPanes = new Set([
      ...this.paneGenerations.keys(),
      ...this.seenPanes,
      ...this.paneAgents.keys(),
    ]);
    this.paneAgents.clear();
    this.paneAgentsAvailable = false;
    this.seenPanes.clear();
    for (const paneId of invalidatedPanes) {
      this.paneGenerations.set(paneId, (this.paneGenerations.get(paneId) ?? 0) + 1);
    }
    this.currentState.authorized_chat_id = null;
    this.currentState.paired_at = null;
    this.currentState.thread_mappings = {};
    this.currentState.known_topics = {};
    this.currentState.known_tabs = {};
    if (Object.keys(this.currentState.pending_topic_deletions ?? {}).length === 0) {
      delete this.currentState.pending_topic_deletions;
    }
    delete this.currentState.processed_update_ids;
    this.deps.saveState(this.currentState);
  }

  /**
   * Inverse of `markUnpaired`: re-enable pane-agent creation and remember
   * the chat that just authorized the bridge. The daemon's `/pair` handler
   * MUST call this before `poll()` — otherwise the `paneAgentsAvailable`
   * gate left behind by a previous `markUnpaired` would silently make
   * `getPaneAgent()` return undefined, breaking every command that routes
   * a thread back to its pane (e.g. `/last`).
   *
   * Does NOT touch `paired_at`: the daemon sets that via `updatePairing`
   * before invoking this method, and the next `poll()` reloads state from
   * disk so the paired-at timestamp survives. Does NOT pre-populate
   * `paneAgents` either — that is the lazy job of `getPaneAgent()` so a
   * fresh pairing only pays the cost for panes that are actually used.
   */
  markPaired(chatId: number): void {
    // The daemon persists paired_at before calling this method. Reloading is
    // essential: saving the constructor snapshot here used to erase it.
    this.currentState = this.deps.loadState();
    this.paneAgentsAvailable = true;
    this.currentState.authorized_chat_id = chatId;
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

  isPaneAddCurrent(paneId: string, generation: number): boolean {
    return (this.paneGenerations.get(paneId) ?? 0) === generation && this.seenPanes.has(paneId);
  }

  paneAddGeneration(paneId: string): number {
    return this.paneGenerations.get(paneId) ?? 0;
  }

  async deleteTopicOnce(threadId: number, deleteTopic: (threadId: number) => Promise<void>, chatId?: number): Promise<boolean> {
    const key = chatId === undefined ? threadId : `${chatId}:${threadId}`;
    if (this.confirmedDeletions.has(key)) return false;
    if (this.inFlightDeletions.has(key)) return false;
    this.inFlightDeletions.add(key);
    try {
      await deleteTopic(threadId);
      this.rememberConfirmedDeletion(key);
      return true;
    } finally { this.inFlightDeletions.delete(key); }
  }

  pendingDeletionsForPane(paneId: string, chatId?: number): Array<[number, PendingTopicDeletion]> {
    return Object.entries(this.currentState.pending_topic_deletions ?? {})
      .filter(([, deletion]) => deletion.pane_id === paneId && (chatId === undefined || deletion.chat_id === chatId))
      .map(([threadId, deletion]) => [this.pendingThreadId(threadId), deletion]);
  }

  private pendingKey(threadId: number, chatId: number): string | number {
    const queue = this.currentState.pending_topic_deletions ?? {};
    const legacy = queue[threadId];
    if (!legacy || legacy.chat_id === chatId) return threadId;
    return `${chatId}:${threadId}`;
  }
  private pendingThreadId(key: string): number {
    const match = key.match(/:(\d+)$/);
    return match ? Number(match[1]) : Number(key);
  }
  private findPendingDeletion(threadId: number, chatId: number): PendingTopicDeletion | undefined {
    const queue = this.currentState.pending_topic_deletions ?? {};
    return queue[`${chatId}:${threadId}`] ?? (queue[threadId]?.chat_id === chatId ? queue[threadId] : undefined);
  }
  private setPendingDeletion(threadId: number, deletion: PendingTopicDeletion): void {
    this.currentState.pending_topic_deletions ??= {};
    this.currentState.pending_topic_deletions[this.pendingKey(threadId, deletion.chat_id)] = deletion;
  }

  completeTopicDeletion(threadId: number, chatId?: number): void {
    const latest = this.deps.loadState();
    const queue = latest.pending_topic_deletions;
    if (!queue) return;
    const keys = Object.keys(queue).filter((candidate) =>
      this.pendingThreadId(candidate) === threadId &&
      (chatId === undefined || queue[candidate].chat_id === chatId));
    if (keys.length === 0) return;
    for (const key of keys) delete queue[key];
    for (const key of keys) this.rememberConfirmedDeletion(chatId === undefined ? threadId : `${chatId}:${threadId}`);
    if (Object.keys(queue).length === 0) {
      delete latest.pending_topic_deletions;
    }
    this.currentState = latest;
    this.deps.saveState(latest);
    this.deps.onStateChanged?.();
  }

  /** Persist an orphaned topic for retry even when the bridge is unpaired. */
  queueTopicDeletion(threadId: number, paneId: string, chatId: number): void {
    const latest = this.deps.loadState();
    this.currentState = latest;
    this.confirmedDeletions.delete(`${chatId}:${threadId}`);
    this.setPendingDeletion(threadId, { pane_id: paneId, chat_id: chatId });
    this.deps.saveState(this.currentState);
    this.deps.onStateChanged?.();
  }

  private removePendingDeletion(threadId: number, chatId?: number): void {
    const queue = this.currentState.pending_topic_deletions;
    if (!queue) return;
    for (const key of Object.keys(queue)) {
      if (this.pendingThreadId(key) === threadId && (chatId === undefined || queue[key].chat_id === chatId)) {
        delete queue[key];
        this.rememberConfirmedDeletion(chatId === undefined ? threadId : `${chatId}:${threadId}`);
      }
    }
    if (this.currentState.pending_topic_deletions &&
      Object.keys(this.currentState.pending_topic_deletions).length === 0) {
      delete this.currentState.pending_topic_deletions;
    }
  }

  private rememberConfirmedDeletion(key: string | number): void {
    this.confirmedDeletions.add(key);
    while (this.confirmedDeletions.size > MAX_CONFIRMED_DELETIONS) {
      const oldest = this.confirmedDeletions.values().next().value as string | number | undefined;
      if (oldest === undefined) break;
      this.confirmedDeletions.delete(oldest);
    }
  }

  /**
   * Record a freshly-created Telegram topic in both `known_tabs` and
   * `thread_mappings`. Called by the daemon after `createForumTopic` succeeds
   * for a tab reported as dead by `healthCheck`.
   *
   * Persists state immediately so the new mapping survives a restart.
   */
  restoreTopic(tabId: string, threadId: number, label: string): void {
    const latest = this.deps.loadState();
    const knownTabs = latest.known_tabs ?? {};
    knownTabs[tabId] = { label, thread_id: threadId };
    latest.known_tabs = knownTabs;

    const panes = this.deps.getAgents();
    const pane = panes.find((candidate) => candidate.tab_id === tabId);
    const mapping: ThreadMapping = {
      pane_id: pane?.pane_id ?? tabId,
      label,
      agent: pane?.agent ?? "unknown",
      created_at: new Date().toISOString(),
    };
    latest.thread_mappings ??= {};
    // Work exclusively on the freshly loaded state. `setPendingDeletion`
    // writes through currentState, and writing it before assigning `latest`
    // loses the queue when loadState returns a new object (as production does).
    this.currentState = latest;
    // A duplicate mapping is never valid: remove older bindings for this pane
    // before installing the replacement. Keep their Telegram topics durable
    // until deletion is confirmed; otherwise dedup silently leaks them.
    for (const [id, existing] of Object.entries(latest.thread_mappings)) {
      if (existing.pane_id === mapping.pane_id && Number(id) !== threadId) {
        this.setPendingDeletion(Number(id), {
          pane_id: existing.pane_id,
          chat_id: latest.authorized_chat_id ?? 0,
        });
        delete latest.thread_mappings[Number(id)];
      }
    }
    latest.thread_mappings[threadId] = mapping;
    this.currentState = latest;
    this.deps.saveState(latest);
  }
}
