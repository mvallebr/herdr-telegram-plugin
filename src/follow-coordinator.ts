/**
 * Owns "at most one output observer per pane" semantics for the daemon.
 *
 * Two output observers running on the same pane (one turn loop + one
 * follow loop, or two follow loops) poll the same source and emit to
 * the same Telegram thread, duplicating every Working tick and pane
 * delta. The coordinator prevents that by serialising loop starts per
 * pane.
 *
 * Scheduling model:
 *
 *   - When a /follow arrives while a loop is already active for the
 *     pane, the subscription is still recorded with `FollowManager`
 *     (so its timer is owned) but the actual follow loop is DEFERRED.
 *     The coordinator stores the threadId under `pendingFollowThreadId`.
 *
 *   - When the active loop finalises (turn idle/abort, follow timer,
 *     /unfollow), `finishLoop` checks the deferred entry. If the
 *     subscription is still active (`deps.hasFollow`), the coordinator
 *     fires `deps.startFollow(threadId)` to promote it.
 *
 *   - `/unfollow` cancels the active loop AND clears any deferred
 *     follow via `cancel`. It never aborts an in-flight TURN — turns
 *     are aborted through `TurnDispatcher.abort` from /stop.
 *
 * The observe-loop itself stays unchanged; this file only owns
 * scheduling glue. Source-agnostic — see `observe-loop.ts`.
 */
export type LoopKind = "turn" | "follow";

export interface FollowCoordinatorDeps {
  /**
   * Spawn the follow loop for the given threadId. Called from
   * `finishLoop` when a deferred follow should be promoted to an
   * active loop (the active loop just finalised and the subscription
   * is still alive). Implementations should re-check coordinator
   * state before spawning — a fast-path race could see a second
   * loop start between `finishLoop` clearing the state and the
   * `startFollow` callback returning.
   */
  startFollow: (threadId: number) => void;
  /**
   * Is the follow subscription for the given threadId still active?
   * The coordinator gates `startFollow` on this so /unfollow between
   * defer and finish doesn't accidentally re-spawn a loop for a
   * dropped subscription.
   */
  hasFollow: (threadId: number) => boolean;
}

interface Entry {
  /** Cancel fn for the active loop. Invoked by `cancel` when the
   *  active kind is `follow`. Never invoked by `cancel` for a turn —
   *  see the JSDoc on `cancel`. */
  cancel: (() => void) | null;
  kind: LoopKind | null;
  /** ThreadId of a follow deferred because a loop was already
   *  running. Consumed (and cleared) by `finishLoop`. */
  pendingFollowThreadId: number | null;
}

export class FollowCoordinator {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: FollowCoordinatorDeps) {}

  /**
   * Register a loop as active for the pane. Returns `false` if a loop
   * is already running for the pane — the caller should treat that
   * as "defer the work" rather than spawning a parallel observer.
   */
  beginLoop(paneId: string, kind: LoopKind, cancel: () => void): boolean {
    const e = this.entry(paneId);
    if (e.cancel !== null) return false;
    e.cancel = cancel;
    e.kind = kind;
    return true;
  }

  /**
   * Mark the active loop as finished. If a follow was deferred AND
   * the subscription is still active, the coordinator fires
   * `deps.startFollow(threadId)` to promote it.
   *
   * Always idempotent — calling on a pane with no active loop and no
   * deferred follow is a no-op.
   */
  finishLoop(paneId: string): void {
    const e = this.entry(paneId);
    e.cancel = null;
    e.kind = null;
    const tid = e.pendingFollowThreadId;
    e.pendingFollowThreadId = null;
    if (tid !== null && this.deps.hasFollow(tid)) {
      this.deps.startFollow(tid);
    }
  }

  /**
   * Record a /follow as deferred for the pane. The coordinator will
   * promote it via `deps.startFollow` when the active loop finishes
   * (and `deps.hasFollow` still returns true).
   */
  deferFollow(paneId: string, threadId: number): void {
    this.entry(paneId).pendingFollowThreadId = threadId;
  }

  /**
   * Cancel the active loop (if any) and clear any deferred follow.
   *
   * Only invokes the cancel function when the active kind is `follow`
   * — an in-flight turn is intentionally NOT aborted by /unfollow.
   * Turn aborts go through `TurnDispatcher.abort` from /stop.
   */
  cancel(paneId: string): void {
    const e = this.entry(paneId);
    if (e.kind === "follow" && e.cancel) {
      e.cancel();
    }
    e.cancel = null;
    e.kind = null;
    e.pendingFollowThreadId = null;
  }

  /** Is a loop currently active for the pane? */
  isActive(paneId: string): boolean {
    return this.entry(paneId).cancel !== null;
  }

  /** Is a deferred follow pending for the pane? */
  hasDeferredFollow(paneId: string): boolean {
    return this.entry(paneId).pendingFollowThreadId !== null;
  }

  /** Kind of the active loop, or `null` if none. */
  activeKind(paneId: string): LoopKind | null {
    return this.entry(paneId).kind;
  }

  private entry(paneId: string): Entry {
    let e = this.entries.get(paneId);
    if (!e) {
      e = { cancel: null, kind: null, pendingFollowThreadId: null };
      this.entries.set(paneId, e);
    }
    return e;
  }
}