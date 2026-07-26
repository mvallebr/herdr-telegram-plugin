/**
 * Dispatch turns without blocking Telegram polling. The Module keeps one
 * ordered queue per pane, while distinct panes run independently.
 */
export class TurnDispatcher {
  private readonly tails = new Map<string, Promise<void>>();
  /** One AbortController per pane lets /stop interrupt the currently
   *  running turn and force a final, releasing the queue. Callers
   *  (daemon.ts) are expected to invoke attachAbortController() right
   *  after enqueue() for each turn. If a controller is left behind from
   *  a previous turn and no fresh one is set, abort() may fire against a
   *  stale signal — this is intentional so that /stop is always robust. */
  private readonly controllers = new Map<string, AbortController>();

  enqueue(paneId: string, turn: () => Promise<void>): void {
    const previous = this.tails.get(paneId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(turn);
    this.tails.set(paneId, next);
    void next.finally(() => {
      if (this.tails.get(paneId) === next) this.tails.delete(paneId);
    }).catch(() => undefined);
  }

  /** Attach an AbortController so the currently enqueued turn for `paneId`
   *  can be aborted by external callers (e.g. /stop). The wrapper-callers
   *  (daemon.ts) are expected to invoke this exactly once per enqueue. */
  attachAbortController(paneId: string, controller: AbortController): void {
    this.controllers.set(paneId, controller);
  }

  /** Abort the turn currently running for `paneId`. Returns true if there
   *  was an in-flight turn that has been signalled, false otherwise. The
   *  queue itself is not cleared — pending turns queued after the
   *  currently active one will still run in order once the active one
   *  finalizes. */
  abort(paneId: string): boolean {
    const controller = this.controllers.get(paneId);
    if (!controller) return false;
    if (controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  /** Read-only check used by read-only commands (e.g. /last) to hint that
   *  the snapshot may be partial. Does not mutate dispatcher state. */
  isBusy(paneId: string): boolean {
    return this.tails.has(paneId);
  }
}
