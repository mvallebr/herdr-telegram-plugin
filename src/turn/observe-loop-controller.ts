/**
 * ObserveLoopController — Task 3 of the PaneAgent refactor.
 *
 * Replaces the ad-hoc observe-loop function with a stateful controller
 * that:
 *
 *   - owns ONE observe loop per pane (at most one active),
 *   - reads unseen output via AgentCommunicator.getNewOutput() (NOT its
 *     own diff state — the communicator owns `sentTail`),
 *   - chunks unseen content into delta events via chunkForTelegram,
 *   - emits bare `working` ticks when the pane is unchanged, on the
 *     cadence supplied by `progressIntervalMs`,
 *   - evaluates the stop condition via `shouldStop(state)` from
 *     ./stop-condition.ts,
 *   - emits a single `final` event on stop, preferring the most recent
 *     emitted delta and falling back to communicator.getLatestOutput()
 *     (truncated to MAX_CHUNK_TOTAL) when no delta was ever emitted.
 *
 * The controller is TELEGRAM-AGNOSTIC: it never speaks to Telegram. The
 * daemon receives OutputEvents and decides how to format / send them.
 *
 * Event types:
 *
 *   { type: "working"; text: string }
 *     — bare heartbeat; emitted only on iterations where no unseen
 *       content was observed. NEVER co-emitted with a delta event in
 *       the same iteration (chunks carry their own working-suffix when
 *       formatWorkingSuffix returns non-empty).
 *
 *   { type: "delta"; text: string }
 *     — one chunk of unseen content, possibly including a working
 *       suffix injected by formatDelta. Multiple deltas may fire in
 *       one iteration when chunkForTelegram splits unseen > MAX_CHUNK_TOTAL.
 *
 *   { type: "final"; text: string; reason: "idle" | "deadline" | "aborted" }
 *     — terminal event. The loop never emits more events after this.
 *
 * Lifecycle:
 *
 *   const c = new ObserveLoopController(deps);
 *   c.updateDeadline(nowMs);     // optional — set before/after start
 *   c.markUserInput();           // optional — enables waitUntilIdle gate
 *   const done = c.start();      // kick off the polling loop
 *   c.abort("aborted");          // request graceful stop; final fires
 *   await done;                  // (or await c.done)
 */
import type { AgentCommunicator } from "../agent-sessions.js";
import {
  chunkForTelegram,
  MAX_CHUNK_TOTAL,
} from "../output-diff.js";
import { shouldStop, type StopState } from "./stop-condition.js";

/**
 * Discriminated union of every event the controller emits.
 * The daemon maps these to Telegram actions.
 */
export type OutputEvent =
  | { type: "working"; text: string }
  | { type: "delta"; text: string }
  | { type: "final"; text: string; reason: "idle" | "deadline" | "aborted" };

/**
 * Construction-time dependencies. All are required except the three
 * formatter callbacks, which have sensible defaults.
 */
export interface ObserveLoopControllerDeps {
  /** Source of unseen / latest output. Must already be constructed
   *  (use createAgentCommunicator in production code, AgentCommunicator
   *  directly in tests). */
  communicator: AgentCommunicator;
  /** Sink for OutputEvents. The controller never formats for Telegram
   *  — formatting is the daemon's job. */
  emit: (event: OutputEvent) => void;
  /** Wall-clock-paced sleep. Production: real `setTimeout`. Tests: a
   *  queued-resolve fake so the loop is deterministic. */
  sleep: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in epoch ms. Tests pass a fake. */
  now: () => number;
  /** Cadence at which the controller polls the communicator and emits
   *  bare working ticks when there is no unseen content. */
  progressIntervalMs: number;
  /** Required ms of pane stability before isIdle() returns true. */
  stabilityMs: number;
  /**
   * Optional. Build the trailing working-suffix embedded in each
   * chunked delta via chunkForTelegram. Default: "" — chunks carry no
   * suffix and the consumer is responsible for any visual indicator.
   */
  formatWorkingSuffix?: (elapsedMs: number) => string;
  /**
   * Optional. Transform a chunked delta before emission. Receives the
   * chunk text (already split by chunkForTelegram with the
   * formatWorkingSuffix suffix appended) and the elapsed ms. Default:
   * identity. Use to inject Telegram markup, pane-id prefixes, etc.
   */
  formatDelta?: (chunk: string, elapsedMs: number) => string;
  /**
   * Optional. Build the bare working tick text. Default:
   * `"⏳ Working (Xs)."` using `Math.floor(elapsedMs / 1000)`.
   */
  formatWorkingTick?: (elapsedMs: number) => string;
}

/** Suffix prepended when the snapshot is truncated for the final payload. */
const ELLIPSIS_PREFIX = "…\n";

/**
 * One ObserveLoopController owns ONE polling loop. start() is idempotent;
 * a second call returns the same promise. updateDeadline / markUserInput
 * / abort can be called before OR after start() — they mutate the same
 * fields the loop reads on each iteration.
 */
export class ObserveLoopController {
  private readonly communicator: AgentCommunicator;
  private readonly emit: (event: OutputEvent) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly progressIntervalMs: number;
  private readonly stabilityMs: number;
  private readonly formatWorkingSuffix: (elapsedMs: number) => string;
  private readonly formatDelta: (chunk: string, elapsedMs: number) => string;
  private readonly formatWorkingTick: (elapsedMs: number) => string;

  /**
   * Stop-condition gates. `deadline=null` means "always reached" (used
   * for message-only turns whose real bound is the agent settling).
   * `waitUntilIdle=false` means the idle check is ignored (used for
   * follow-only turns whose real bound is the timer).
   *
   * Defaults: `null` + `false`. PaneAgent is expected to call
   * updateDeadline / markUserInput to install the right gate before
   * start() — running with the defaults would finalise on the first
   * poll, which is never what callers want.
   */
  private deadline: number | null = null;
  private waitUntilIdle: boolean = false;

  /**
   * Abort latch. When non-null, the loop short-circuits to the final
   * event with reason="aborted". Stored as an object so the type
   * matches the spec; the actual reason is always "aborted" today.
   */
  private aborted: { reason: "aborted" } | null = null;

  /** Cached run promise so start() is idempotent. */
  private started: Promise<void> | null = null;
  /** Resolver for the public `done` promise. */
  private resolveDone!: () => void;

  /** Resolves when the polling loop exits (after the final event). */
  readonly done: Promise<void>;

  constructor(deps: ObserveLoopControllerDeps) {
    this.communicator = deps.communicator;
    this.emit = deps.emit;
    this.sleep = deps.sleep;
    this.now = deps.now;
    this.progressIntervalMs = deps.progressIntervalMs;
    this.stabilityMs = deps.stabilityMs;
    this.formatWorkingSuffix = deps.formatWorkingSuffix ?? (() => "");
    this.formatDelta = deps.formatDelta ?? ((chunk) => chunk);
    this.formatWorkingTick =
      deps.formatWorkingTick ??
      ((elapsedMs) => `⏳ Working (${Math.floor(elapsedMs / 1000)}s).`);
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /**
   * Start the polling loop. Idempotent: a second call returns the same
   * promise. The promise resolves once the loop has emitted its final
   * event (idle / deadline / aborted).
   *
   * The very first action inside the loop is a single
   * `communicator.getNewOutput()` call which seeds the communicator's
   * baseline. No event is emitted for that seed — the user has been
   * watching the pane live and replaying would duplicate content.
   */
  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.run();
    return this.started;
  }

  /**
   * Update the deadline gate. `null` means "always reached" so the
   * formula collapses to a pure idle check. Safe to call before or
   * after start(); the new value is picked up on the next iteration.
   */
  updateDeadline(deadline: number | null): void {
    this.deadline = deadline;
  }

  /**
   * Whether the deadline gate is currently armed.
   */
  hasDeadline(): boolean {
    return this.deadline !== null;
  }

  /**
   * A user message arrived during this turn. Toggles the idle gate on
   * so the loop drains once the agent settles — even if a follow
   * deadline is armed. Idempotent: calling twice is the same as once.
   */
  markUserInput(): void {
    this.waitUntilIdle = true;
  }

  /**
   * Request a graceful stop. The current sleep is awaited so we don't
   * abandon a half-finalised iteration; the loop then short-circuits
   * to the final event with reason="aborted". The reason parameter
   * exists for forward compatibility but the only legal value today
   * is "aborted".
   */
  abort(reason: "aborted" = "aborted"): void {
    this.aborted = { reason };
  }

  /**
   * Core loop. See the file header for the per-iteration semantics.
   * The `try/finally` guarantees the public `done` promise resolves
   * even if the run throws (the error is re-thrown after resolving).
   */
  private async run(): Promise<void> {
    try {
      // Baseline seed: one call to the communicator returns "" because
      // it's the first call (and seeds `sentTail`). We deliberately do
      // NOT treat this as an emission — historical content must never
      // be replayed as "new".
      const seeded = this.communicator.getNewOutput();
      void seeded; // baseline; intentionally ignored

      const startedAt = this.now();
      // lastChangeAt anchors the stability window. It is bumped every
      // time we observe unseen content; left untouched while the pane
      // is stable so the stability window can elapse.
      let lastChangeAt = startedAt;
      // lastDeltaText remembers the most recent non-empty chunk we
      // emitted as a delta. The final payload falls back to this when
      // the pane goes idle — it's the most recent content the user has
      // already seen on Telegram and acts as a durable recap.
      let lastDeltaText = "";

      while (true) {
        await this.sleep(this.progressIntervalMs);

        // Honour an abort that arrived during the sleep.
        if (this.aborted) {
          this.emitFinal("aborted", lastDeltaText);
          return;
        }

        const now = this.now();
        const elapsedMs = now - startedAt;
        const unseen = this.communicator.getNewOutput();

        if (unseen.length > 0) {
          // Chunk via chunkForTelegram. The suffix comes from
          // formatWorkingSuffix (empty by default). Each chunk is
          // formatted independently and emitted as its own delta event.
          // We do NOT also emit a bare working tick this iteration —
          // the chunks carry the cadence.
          const suffix = this.formatWorkingSuffix(elapsedMs);
          const chunks = chunkForTelegram(unseen, suffix);
          for (const chunk of chunks) {
            const text = this.formatDelta(chunk, elapsedMs);
            this.emit({ type: "delta", text });
            // Remember the raw chunk (without formatDelta wrapping) as
            // the fallback Final payload — this matches the original
            // observe-loop behaviour where the user has already seen
            // the post-formatDelta text on Telegram, so it is the most
            // semantically stable fallback.
            lastDeltaText = chunk;
          }
          lastChangeAt = now;
        } else {
          // No new content this iteration — emit exactly one bare
          // working tick. The progress interval drives the cadence.
          this.emit({
            type: "working",
            text: this.formatWorkingTick(elapsedMs),
          });
        }

        // Stop-condition check. We evaluate AFTER emission so the
        // caller sees one last "you're done" tick worth of output
        // before the final.
        const state: StopState = {
          now,
          lastChangeAt,
          stabilityMs: this.stabilityMs,
          deadline: this.deadline,
          waitUntilIdle: this.waitUntilIdle,
        };
        if (shouldStop(state)) {
          // Distinguish "idle" vs "deadline" in the final reason. The
          // single rule: if waitUntilIdle is true, the idle gate was
          // required, so the reason is "idle". Otherwise the timer
          // forced the stop and the reason is "deadline". This is
          // consistent across message-only, follow-only, follow+message
          // and unfollow scenarios.
          const reason: "idle" | "deadline" = this.waitUntilIdle
            ? "idle"
            : "deadline";
          this.emitFinal(reason, lastDeltaText);
          return;
        }
      }
    } finally {
      // Resolve the public done promise regardless of how the loop
      // exited (clean stop, abort, or thrown error). The awaiter on
      // `done` is therefore guaranteed to settle.
      this.resolveDone();
    }
  }

  /**
   * Build and emit the single terminal event.
   *
   * Payload rule:
   *   1. Prefer `lastDeltaText` if non-blank — the user has already
   *      seen this content as a delta; the Final is a durable recap.
   *   2. Otherwise call communicator.getLatestOutput() — a readback
   *      that does NOT mutate diff state.
   *   3. Truncate the fallback to MAX_CHUNK_TOTAL with an ellipsis
   *      prefix so Telegram never sees an over-long message.
   *
   * The function does not return; the caller is expected to follow
   * the emit with `return` from run().
   */
  private emitFinal(
    reason: "idle" | "deadline" | "aborted",
    lastDeltaText: string,
  ): void {
    let text: string;
    if (lastDeltaText.trim().length > 0) {
      text = lastDeltaText;
    } else {
      const latest = this.communicator.getLatestOutput();
      if (latest.trim().length > 0) {
        text =
          latest.length > MAX_CHUNK_TOTAL
            ? ELLIPSIS_PREFIX +
              latest.slice(-(MAX_CHUNK_TOTAL - ELLIPSIS_PREFIX.length))
            : latest;
      } else {
        text = "";
      }
    }
    this.emit({ type: "final", text, reason });
  }
}