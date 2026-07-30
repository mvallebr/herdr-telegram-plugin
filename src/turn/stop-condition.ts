/**
 * Stop-condition model for a single observe-loop turn.
 *
 * A turn is bounded by TWO independent gates that combine into one
 * boolean:
 *
 *   - a deadline (an absolute epoch-ms timestamp, or `null` meaning
 *     "always reached" — used for message-only turns whose real bound
 *     is "agent finished");
 *   - an optional "wait until idle" gate that further requires the pane
 *     to have been stable for `stabilityMs` since `lastChangeAt`.
 *
 * The combined formula is:
 *
 *   stop  <=>  deadline_reached  AND  ( NOT wait_until_idle  OR  is_idle )
 *
 * Why this shape:
 *   - "message only" → deadline=null (always reached) and waitUntilIdle=true:
 *     stop iff is_idle. Pure idle-based termination.
 *   - "follow only" → deadline set, waitUntilIdle=false:
 *     stop iff deadline reached. Idleness is ignored, the timer wins.
 *   - "follow + message" → deadline set, waitUntilIdle=true:
 *     stop iff deadline reached AND idle. The timer cannot fire on a
 *     busy agent; the agent cannot finish early once the timer is armed.
 *   - "/follow 0" → deadline=now, waitUntilIdle=false:
 *     stop is immediately true (the user said "fire when I say so").
 *
 * `lastChangeAt` is owned by the caller (the observe loop), which bumps
 * it whenever it observes a byte-level change in the pane snapshot.
 */
export interface StopState {
  /** Current epoch-ms clock reading. */
  now: number;
  /** Epoch-ms when the pane snapshot last changed byte-for-byte. */
  lastChangeAt: number;
  /** Required ms of pane stability before `isIdle` becomes true. */
  stabilityMs: number;
  /**
   * Absolute epoch-ms deadline. `null` is treated as "always reached"
   * and lets the formula collapse to a pure idle check.
   */
  deadline: number | null;
  /** When true, stop additionally requires `isIdle`. */
  waitUntilIdle: boolean;
}

/**
 * Whether the deadline gate has fired. `null` deadlines always pass —
 * this is the convention that lets a "message-only" turn terminate on
 * idleness alone without a sentinel timestamp.
 */
export function isDeadlineReached(state: StopState): boolean {
  return state.deadline === null || state.now >= state.deadline;
}

/**
 * Whether the pane has been stable for at least `stabilityMs`. Equality
 * (`>=`) is intentional so a frame at exactly the stability boundary
 * counts as idle.
 */
export function isIdle(state: StopState): boolean {
  return state.now - state.lastChangeAt >= state.stabilityMs;
}

/**
 * The single stop predicate every turn runs through each poll:
 *
 *   deadline_reached AND (NOT waitUntilIdle OR is_idle)
 *
 * Callers update `now` and `lastChangeAt` each iteration; `shouldStop`
 * stays pure so it is trivial to unit-test all five wiring combinations.
 */
export function shouldStop(state: StopState): boolean {
  return isDeadlineReached(state) && (!state.waitUntilIdle || isIdle(state));
}