/**
 * Dispatch turns without blocking Telegram polling. The Module keeps one
 * ordered queue per pane, while distinct panes run independently.
 */
export class TurnDispatcher {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(paneId: string, turn: () => Promise<void>): void {
    const previous = this.tails.get(paneId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(turn);
    this.tails.set(paneId, next);
    void next.finally(() => {
      if (this.tails.get(paneId) === next) this.tails.delete(paneId);
    }).catch(() => undefined);
  }
}
