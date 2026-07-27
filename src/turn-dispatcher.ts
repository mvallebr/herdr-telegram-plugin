/**
 * Dispatch turns without blocking Telegram polling. PR #10 flipped the
 * model from "queue of turns per pane" to "at most one active turn per
 * pane". A new text message arriving while a turn is already running
 * does NOT enqueue another turn — the caller is expected to forward it
 * directly to the pane (pass-through). A turn finalises when its
 * observe-loop closes (idle stop, follow timer expiry, /stop abort).
 *
 * The dispatcher only owns:
 *  - the active-turn Promise (so callers can `await` the previous turn
 *    ending before scheduling a new one),
 *  - an AbortController per pane for /stop, and
 *  - a `setFollowReset` hook so message:text handlers can push the
 *    follow deadline forward without going through the dispatcher.
 */
export class TurnDispatcher {
  /** Promise of the currently running turn per pane, or undefined. */
  private readonly actives = new Map<string, Promise<void>>();
  /** AbortController per pane so /stop can interrupt the active turn. */
  private readonly controllers = new Map<string, AbortController>();

  /** Start a turn for the pane. Rejects if a turn is already running;
   *  callers must check `isBusy` first or wait for `waitForIdle`. */
  async start(paneId: string, fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.actives.has(paneId)) {
      throw new Error(`Turn already running for pane ${paneId}`);
    }
    const controller = new AbortController();
    this.controllers.set(paneId, controller);
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await fn(controller.signal);
      } finally {
        if (this.controllers.get(paneId) === controller) {
          this.controllers.delete(paneId);
        }
        if (this.actives.get(paneId) === promise) {
          this.actives.delete(paneId);
        }
      }
    })();
    this.actives.set(paneId, promise);
    return promise;
  }

  /** Wait for the current turn (if any) to finish. Resolves immediately
   *  if no turn is running. Used by message:text handlers that want to
   *  schedule a fresh turn after the previous one closes. */
  async waitForIdle(paneId: string): Promise<void> {
    const active = this.actives.get(paneId);
    if (!active) return;
    try {
      await active;
    } catch {
      // Swallow — start() handles its own errors.
    }
  }

  /** Read-only check used by reactions (/status) to hint at partiality. */
  isBusy(paneId: string): boolean {
    return this.actives.has(paneId);
  }

  /** Abort the currently active turn. Returns true if a turn was
   *  signalled; false if no turn was running or the signal had already
   *  fired. */
  abort(paneId: string): boolean {
    const controller = this.controllers.get(paneId);
    if (!controller) return false;
    if (controller.signal.aborted) return false;
    controller.abort();
    return true;
  }
}