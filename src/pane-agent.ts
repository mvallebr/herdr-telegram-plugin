/**
 * PaneAgent — Task 4 of the PaneAgent refactor.
 *
 * One PaneAgent per Herdr pane. Owns:
 *   - exactly one AgentCommunicator (read + write side of the pane),
 *   - at most one ObserveLoopController (the polling loop that emits
 *     `working` / `delta` / `final` events to the daemon).
 *
 * The public surface maps directly to Telegram intents:
 *
 *   - handleMessage  → "user sent text in a bound topic"
 *   - enableFollow   → "/follow [minutes]"
 *   - disableFollow  → "/unfollow"
 *   - stop           → "/stop"
 *   - getLastOutput  → "/last"  (must not consume diff state)
 *   - dispose        → daemon shutdown
 *
 * Single-loop invariant
 * ---------------------
 * `this.loop` holds the active controller or null. Every entry point
 * (handleMessage / enableFollow) consults it before deciding whether
 * to start a new controller or mutate the existing one. The controller
 * is auto-cleared (set back to null) on its `done` promise resolution,
 * so a fresh message after a finalised turn starts a brand-new
 * controller — exactly the behaviour we want for /last + new-message
 * sequences.
 *
 * Stop-condition wiring
 * ---------------------
 * The daemon's intent flows through the ObserveLoopController's two
 * gates (deadline + waitUntilIdle) via these calls:
 *
 *   - `handleMessage`:  start loop with deadline=null, markUserInput.
 *                       (Existing loop: markUserInput; deadline untouched.)
 *   - `enableFollow`:   start loop with deadline=now+ms, NO markUserInput.
 *                       (Existing loop: updateDeadline(deadline).)
 *   - `disableFollow`:  updateDeadline(null). waitUntilIdle is preserved
 *                       so the loop's stop formula collapses naturally:
 *                         - follow-only then /unfollow: deadline=null +
 *                           waitUntilIdle=false → stop immediately.
 *                         - message then /unfollow:    deadline=null +
 *                           waitUntilIdle=true  → stop on idle.
 *
 * Telegram-agnostic
 * -----------------
 * PaneAgent never imports Telegram types or the grammy client. All
 * output flows through `emit(OutputEvent)`; the daemon receives these
 * and decides how to format / send them. This keeps the unit-testable
 * surface free of network dependencies.
 */
import type { AgentCommunicator } from "./agent-sessions.js";
import type { Config } from "./config.js";
import {
  ObserveLoopController,
  type ObserveLoopControllerDeps,
  type OutputEvent,
} from "./turn/observe-loop-controller.js";

/**
 * Optional construction-time dependencies. All three are injectable
 * for tests; production code lets them default. None are required.
 *
 *   - sleep:           wall-clock-paced sleep for the loop's poll cadence.
 *                      Defaults to a setTimeout-based promise.
 *   - now:             monotonic-ish epoch-ms clock.
 *                      Defaults to Date.now.
 *   - createController: factory for ObserveLoopController instances.
 *                      Tests inject a counting factory to assert the
 *                      single-loop invariant. Defaults to `new`.
 */
export interface PaneAgentDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  createController?: (
    deps: ObserveLoopControllerDeps,
  ) => ObserveLoopController;
}

export interface PaneAgentOptions {
  /** Pane id this agent coordinates. Stored for diagnostics / logs. */
  paneId: string;
  /** Read+write side of the pane (selected-once reader + sendInput). */
  communicator: AgentCommunicator;
  /** Sink for OutputEvents. The agent never formats for Telegram. */
  emit: (event: OutputEvent) => void;
  /** Loop cadence + stability window come from cfg. */
  config: Config;
  /** Optional. Production leaves this unset. */
  deps?: PaneAgentDeps;
}

/**
 * Per-pane coordinator. Construct one per pane the daemon tracks.
 *
 * Lifecycle:
 *
 *   const agent = new PaneAgent({ paneId, communicator, emit, config });
 *   agent.handleMessage("hello");
 *   agent.enableFollow(Date.now() + 30 * 60_000);
 *   agent.disableFollow();
 *   agent.getLastOutput();
 *   agent.stop();
 *   agent.dispose();          // permanent shutdown
 */
export class PaneAgent {
  private loop: ObserveLoopController | null = null;

  constructor(private readonly opts: PaneAgentOptions) {
    // opts.paneId is currently passed for diagnostics / log enrichment.
    // PaneAgent only needs it implicitly via the communicator, but
    // keeping it on the constructor surface matches the spec and gives
    // future log lines a stable identity.
    void this.opts.paneId;
  }

  /**
   * True when an observe loop is currently running. Public so the
   * daemon (and tests) can inspect liveness without polling internals.
   */
  isLoopActive(): boolean {
    return this.loop !== null;
  }

  /**
   * A user message arrived. Always forwards the input to the pane.
   * If no loop is active, starts one with deadline=null and
   * waitUntilIdle=true (idle-based stop). If a loop is already active
   * (turn in flight, follow in flight, …), just marks waitUntilIdle on
   * it — the deadline gate (if any) is preserved untouched so a
   * follow timer keeps ticking through user messages.
   */
  handleMessage(text: string): void {
    this.opts.communicator.sendInput(text);
    if (this.loop) {
      this.loop.markUserInput();
      return;
    }
    this.startLoop({ deadline: null, waitUntilIdle: true });
  }

  /**
   * Enable follow mode. When no loop is active, starts one with
   * `deadline` and waitUntilIdle=false (timer-only stop — the pane
   * does not have to settle for the loop to end). When a loop is
   * already active, just updates the deadline. The waitUntilIdle
   * flag is left as-is so a /follow that arrives mid-message still
   * honours the "wait for idle" gate on the message turn.
   */
  enableFollow(deadline: number): void {
    if (this.loop) {
      this.loop.updateDeadline(deadline);
      return;
    }
    this.startLoop({ deadline, waitUntilIdle: false });
  }

  /**
   * Disable follow mode. Clears the deadline gate. The loop is kept
   * alive (a final iteration is still needed to emit the final event
   * with the right reason). waitUntilIdle is preserved, so:
   *   - follow-only then /unfollow → waitUntilIdle=false, deadline=null
   *     → stop on the next iteration.
   *   - message then /unfollow     → waitUntilIdle=true,  deadline=null
   *     → stop on the next idle window.
   * No-op when no loop is active.
   */
  disableFollow(): void {
    if (!this.loop) return;
    this.loop.updateDeadline(null);
  }

  /**
   * Abort the active loop. The controller will emit a final event with
   * reason="aborted" and resolve its done promise. We clear this.loop
   * synchronously so a subsequent handleMessage / enableFollow starts
   * a fresh controller without waiting for the abort to land.
   * No-op when no loop is active.
   */
  stop(): void {
    if (!this.loop) return;
    const loop = this.loop;
    this.loop = null;
    loop.abort();
    // The done.then auto-clear hook below is now a no-op (this.loop
    // already points elsewhere), but we let it run for symmetry with
    // the dispose path.
    void loop.done;
  }

  /**
   * Read-only peek for `/last`. Returns whatever the underlying reader
   * reports RIGHT NOW without mutating diff state — a subsequent
   * observe-loop tick still sees what was visible to /last as
   * "unseen" if it changed since. Forwarded to the communicator's
   * `getLatestOutput()` so the AgentCommunicator owns the policy.
   */
  getLastOutput(): string {
    return this.opts.communicator.getLatestOutput();
  }

  /**
   * Permanently shut this PaneAgent down. Aborts the active loop (if
   * any) and clears internal state. After dispose, the agent must
   * not be reused — the daemon's typical pattern is one agent per
   * pane and dispose() only at daemon shutdown.
   */
  dispose(): void {
    if (!this.loop) return;
    const loop = this.loop;
    this.loop = null;
    loop.abort();
    void loop.done;
  }

  /**
   * Internal: construct + start a new ObserveLoopController with the
   * configured gates, register an auto-clear hook on its done promise,
   * and install it as the active loop.
   *
   * The auto-clear hook only clears `this.loop` if it still points to
   * this controller — a stop()/dispose() that already nulled it leaves
   * the hook as a harmless no-op.
   */
  private startLoop(opts: {
    deadline: number | null;
    waitUntilIdle: boolean;
  }): void {
    const factory =
      this.opts.deps?.createController ??
      ((d: ObserveLoopControllerDeps) => new ObserveLoopController(d));
    const sleep =
      this.opts.deps?.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.opts.deps?.now ?? Date.now;

    const controller = factory({
      communicator: this.opts.communicator,
      emit: this.opts.emit,
      sleep,
      now,
      progressIntervalMs: this.opts.config.progressIntervalMs,
      stabilityMs: this.opts.config.stabilityWindowMs,
    });
    controller.updateDeadline(opts.deadline);
    if (opts.waitUntilIdle) controller.markUserInput();
    controller.start();
    // Auto-clear when the loop finalises. Use the captured reference so
    // a stale callback can't clobber a fresh loop started after stop().
    controller.done.then(() => {
      if (this.loop === controller) {
        this.loop = null;
      }
    });
    this.loop = controller;
  }
}