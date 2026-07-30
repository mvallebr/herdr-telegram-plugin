import type { Config } from "./config.js";
import type { TelegramClient } from "./telegram-client.js";
import { sendText, readPane, getAgentInfo } from "./herdr-client.js";
import type { AgentCommunicator } from "./agent-sessions.js";
import { createAgentCommunicator } from "./agent-sessions.js";
// Re-export legacy wait-loop output-format helpers from output-format.ts
// so callers that import from wait-loop keep working.
export {
  cleanPaneOutput,
  stripStatusBar,
  isNaturalLanguageLine,
  extractResponseSince,
  extractScreenResponse,
  extractScreenDelta,
} from "./output-format.js";

export function shouldThrottle(lastSentAt: number, throttleMs: number): boolean {
  return Date.now() - lastSentAt < throttleMs;
}

export function formatElapsed(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitLoopDeps {
  sendText: (paneId: string, text: string) => void;
  readPane: (paneId: string, lines: number) => string;
  sendMessage: (chatId: number, threadId: number, text: string, opts?: { disable_notification?: boolean }) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultWaitLoopDeps: WaitLoopDeps = {
  sendText,
  readPane,
  sendMessage: async () => { throw new Error("sendMessage not provided — pass a TelegramClient to runAgentTurn"); },
  sleep,
  now: () => Date.now(),
};

export interface RunAgentTurnOptions {
  maxOutputLines?: number;
  /** Test override. Production uses telegram.progress_interval_ms. */
  pollIntervalMs?: number;
  stabilityWindowMs?: number;
  deps?: Partial<WaitLoopDeps>;
  /** Optional AbortSignal. When aborted, the polling loop bails out and
   *  emits whatever was last captured as the final response, so the queue
   *  can release and queued messages can proceed. Used by /stop. */
  signal?: AbortSignal;
  /** Whether the thread currently has an active follow subscription. The
   *  Working and Final keyboards toggle between "Unfollow" and "Follow
   *  5m / 30m" based on this. */
  hasFollow?: boolean;
  /** Optional test override for the AgentCommunicator. If not provided,
   *  a production communicator is created with getAgentInfo + readPane. */
  communicator?: AgentCommunicator;
}

/**
 * Composition root for one Telegram turn. Submits the prompt to the pane,
 * polls for stability, and emits Telegram Working ticks + a final response.
 *
 * After PR #10 the engine is `runObserveLoop` with an `idle` stop condition
 * and a Working-style output formatter. The legacy wrappers (ScreenScrape,
 * codex/pi/omp adapters) are no longer wired in here — the observe loop
 * polls the pane directly and tracks stability via byte-level diffs.
 */
export async function runAgentTurn(
  paneId: string,
  threadId: number,
  text: string,
  cfg: Config,
  tg: TelegramClient,
  chatId: number,
  maxOutputLinesOrOptions: number | RunAgentTurnOptions = 200
): Promise<void> {
  const opts = typeof maxOutputLinesOrOptions === "number" ? { maxOutputLines: maxOutputLinesOrOptions } : maxOutputLinesOrOptions;
  const stabilityMs = opts.stabilityWindowMs ?? cfg.stabilityWindowMs;
  const maxOutputLines = opts.maxOutputLines ?? 1_000;

  // Submit the prompt immediately — pass-through to the pane.
  (opts.deps?.sendText ?? sendText)(paneId, text);

  // Use the injected communicator (tests) or create a production one.
  const communicator =
    opts.communicator ?? createAgentCommunicator({
      paneId,
      getAgentInfo,
      readPane,
      agentPaths: cfg.agentPaths,
      opencodeReadOptions: {
        includeTools: cfg.opencodeIncludeTools,
        includeThoughts: cfg.opencodeIncludeThoughts,
      },
    });

  // Lazily require to avoid the spawnSync cost when tests inject mocks.
  const { runObserveLoop } = await import("./observe-loop.js");
  // Inline import to avoid a circular dep at module load.
  const { workingKeyboard, finalKeyboard } = await import("./keyboards.js");
  await runObserveLoop({
    paneId,
    threadId,
    cfg,
    tg,
    chatId,
    maxOutputLines,
    signal: opts.signal,
    stopCondition: { kind: "idle", stabilityMs },
    output: {
      workingTick: ({ elapsedSec, followExpiresInMs }) =>
        followExpiresInMs === undefined
          ? `⏳ Working (${formatElapsed(elapsedSec)}).`
          : `⏳ Working (${formatElapsed(elapsedSec)}, follow expires in ${formatExpiresIn(followExpiresInMs)}).`,
      paneDelta: (delta) => delta,
      finalMessage: (text) => `✅ (${formatElapsed(0)}):\n\n${text}`,
      workingKeyboard: () => workingKeyboard(threadId, opts.hasFollow ?? false),
      finalKeyboard: () => finalKeyboard(threadId, opts.hasFollow ?? false),
    },
    communicator,
    deps: {
      sendMessage: (c, t, text, opts2) => tg.sendMessage(c, t, text, opts2),
      sleep: opts.deps?.sleep ?? sleep,
      now: opts.deps?.now ?? (() => Date.now()),
    },
  });
}

/** Format ms for the `follow expires in Ym Zs` suffix. */
export function formatExpiresIn(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Subscribe to pane updates until the follow subscription expires or is
 * cancelled. Each pane change emits a delta. Working ticks fire on the
 * same cadence as a normal turn (every progressIntervalMs) and now carry
 * the `, follow expires in Ym Zs` suffix when the subscription has a
 * timer; manual-mode follow (timeout=0) shows just `Working (Xs).` like a
 * turn.
 *
 * After PR #10 this is a thin wrapper over `runObserveLoop` with the
 * `follow` stop condition. The follow timer is supplied as a closure so
 * that user messages can `touch(threadId)` and push the deadline out;
 * manual /unfollow closes the subscription externally and the loop bails
 * on the next tick via the same deadline check.
 */
export async function runAgentFollowLoop(opts: {
  paneId: string;
  threadId: number;
  cfg: Config;
  tg: TelegramClient;
  chatId: number;
  /** Returns the current expiration deadline (ms epoch) or `null` for
   *  manual mode. The caller owns the underlying subscription and may
   *  `touch(threadId)` to push the deadline out. */
  expiresAt: () => number | null;
  /** Optional callback invoked the moment the timer fires. */
  onExpired?: () => void;
  /** Optional AbortSignal — when aborted, the loop bails immediately. */
  signal?: AbortSignal;
  deps?: Partial<WaitLoopDeps>;
  /** Whether the thread has an active follow subscription. The Working
   *  and Final keyboards surface "Unfollow" based on this. */
  hasFollow?: boolean;
  /** Optional test override for the AgentCommunicator. */
  communicator?: AgentCommunicator;
}): Promise<void> {
  const { runObserveLoop } = await import("./observe-loop.js");
  const { workingKeyboard, finalKeyboard } = await import("./keyboards.js");
  const hasFollow = opts.hasFollow ?? true;
  const communicator =
    opts.communicator ?? createAgentCommunicator({
      paneId: opts.paneId,
      getAgentInfo,
      readPane,
      agentPaths: opts.cfg.agentPaths,
      opencodeReadOptions: {
        includeTools: opts.cfg.opencodeIncludeTools,
        includeThoughts: opts.cfg.opencodeIncludeThoughts,
      },
    });
  await runObserveLoop({
    paneId: opts.paneId,
    threadId: opts.threadId,
    cfg: opts.cfg,
    tg: opts.tg,
    chatId: opts.chatId,
    maxOutputLines: 4_000,
    signal: opts.signal,
    stopCondition: {
      kind: "follow",
      expiresAt: opts.expiresAt,
      onExpired: opts.onExpired,
    },
    output: {
      workingTick: ({ elapsedSec, followExpiresInMs }) =>
        followExpiresInMs === undefined
          ? `⏳ Working (${formatElapsed(elapsedSec)}).`
          : `⏳ Working (${formatElapsed(elapsedSec)}, follow expires in ${formatExpiresIn(followExpiresInMs)}).`,
      paneDelta: (delta) => delta,
      finalMessage: (text) => `🟢 Follow ended.\n\n${text}`,
      expiredMessage: () => "⏱️ Subscription expired — /follow to listen again.",
      abortedMessage: () => "👋 Follow cancelled.",
      workingKeyboard: () => workingKeyboard(opts.threadId, hasFollow),
      finalKeyboard: () => finalKeyboard(opts.threadId, hasFollow),
    },
    communicator,
    deps: {
      sendMessage: (c, t, text, opts2) => opts.deps?.sendMessage?.(c, t, text, opts2) ?? opts.tg.sendMessage(c, t, text, opts2),
      sleep: opts.deps?.sleep ?? sleep,
      now: opts.deps?.now ?? (() => Date.now()),
    },
  });
}
