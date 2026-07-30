/**
 * Single observe loop: poll a pane, emit Working stamps and pane deltas,
 * finish when the active stop condition is met.
 *
 * Used by both Working mode (turn ends on idle) and Follow mode (turn
 * ends on a timer or /unfollow). Stop conditions and output shape are
 * supplied per-call so callers can swap them mid-run.
 */
import type { TelegramClient } from "./telegram-client.js";
import type { Config } from "./config.js";
import { stripStatusBar } from "./wait-loop.js";
import type { AgentCommunicator } from "./agent-sessions.js";

// --- Stop conditions -------------------------------------------------------

export interface IdleStopCondition {
  kind: "idle";
  /** Min ms of pane stability (no byte change) before declaring done. */
  stabilityMs: number;
}

export interface FollowStopCondition {
  kind: "follow";
  /** When the timer fires (ms epoch), or `null` for "no timer" (stop on /unfollow). */
  expiresAt: () => number | null;
  /** Optional callback fired the moment the loop sees the timer expire. */
  onExpired?: () => void;
}

export type ObserveStopCondition = IdleStopCondition | FollowStopCondition;

export function isIdle(c: ObserveStopCondition): c is IdleStopCondition {
  return c.kind === "idle";
}

// --- Output formatter ------------------------------------------------------

export interface ObserveFinalSource {
  /** Why did this loop end? */
  source: "idle" | "follow-timeout" | "signal-abort";
}

export interface ObserveOutputFormatter {
  workingTick: (ctx: { elapsedSec: number; followExpiresInMs?: number }) => string;
  paneDelta: (delta: string) => string;
  finalMessage: (final: string, ctx: ObserveFinalSource) => string;
  /** Custom message used when the follow timer expires naturally. */
  expiredMessage?: () => string;
  /** Custom message used when the signal aborts the loop. */
  abortedMessage?: () => string;
  /** Inline keyboard attached to Working ticks. May vary to surface follow state. */
  workingKeyboard?: () => unknown;
  /** Inline keyboard attached to the final/expired/aborted message. */
  finalKeyboard?: () => unknown;
}

// --- Public entry point ----------------------------------------------------

export interface ObserveLoopDeps {
  sendMessage: (
    chatId: number,
    threadId: number,
    text: string,
    opts?: { disable_notification?: boolean; reply_markup?: unknown }
  ) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface RunObserveLoopOptions {
  paneId: string;
  threadId: number;
  cfg: Config;
  tg: TelegramClient;
  chatId: number;
  stopCondition: ObserveStopCondition;
  output: ObserveOutputFormatter;
  signal?: AbortSignal;
  maxOutputLines?: number;
  communicator: AgentCommunicator;
  deps: ObserveLoopDeps;
}

export async function runObserveLoop(opts: RunObserveLoopOptions): Promise<void> {
  const { communicator, deps } = opts;
  const maxLines = opts.maxOutputLines ?? 4_000;
  const tickMs = opts.cfg.progressIntervalMs;

  let lastSnapshot = readSnapshot(opts.paneId, maxLines, communicator);
  // Tracks the most recent non-empty delta we emitted. When the agent
  // finishes by clearing the pane (a common pattern in pi/codex), the
  // post-clean snapshot is empty, but the actual response is what we
  // already emitted as a delta. The final message falls back to this
  // so the user sees a non-empty Final.
  let lastDeltaText = "";
  let lastChangeAt = deps.now();
  const startedAt = lastChangeAt;

  while (true) {
    if (opts.signal?.aborted) {
      await finalize(opts, deps, lastSnapshot, "signal-abort", lastDeltaText);
      return;
    }

    await deps.sleep(tickMs);
    if (opts.signal?.aborted) {
      await finalize(opts, deps, lastSnapshot, "signal-abort", lastDeltaText);
      return;
    }

    const current = readSnapshot(opts.paneId, maxLines, communicator);
    const elapsedSec = Math.floor((deps.now() - startedAt) / 1000);

    // A pane clear (e.g. agent redraw) is a real change, but the agent
    // has stopped emitting new content. Treat clears as 'not working' so
    // the stability window can elapse naturally.
    if (current !== lastSnapshot && current.trim().length > 0) {
      lastChangeAt = deps.now();
    }

    // Working tick — every iteration, no matter what.
    const followExpiresInMs =
      opts.stopCondition.kind === "follow"
        ? computeFollowExpiresInMs(opts.stopCondition, deps.now())
        : undefined;
    await deps.sendMessage(
      opts.chatId,
      opts.threadId,
      opts.output.workingTick({ elapsedSec, followExpiresInMs }),
      {
        disable_notification: true,
        reply_markup: opts.output.workingKeyboard?.(),
      },
    );

    // Pane change — emit a delta on its own message. We compute a byte-level
    // diff so long, no-op periods do not produce duplicate output.
    if (current !== lastSnapshot && current.trim().length > 0) {
      const deltaText = current.startsWith(lastSnapshot)
        ? current.slice(lastSnapshot.length).replace(/^\n+/, "")
        : `…(pane scrolled)…\n${current.slice(-Math.min(3000, current.length))}`;
      if (deltaText.length > 0) {
        const bounded = deltaText.length > 3000 ? `…\n${deltaText.slice(-3000)}` : deltaText;
        await deps.sendMessage(
          opts.chatId,
          opts.threadId,
          opts.output.paneDelta(bounded),
          {
            reply_markup: opts.output.workingKeyboard?.(),
          },
        );
        lastDeltaText = bounded;
      }
      lastSnapshot = current;
    }

    // Stop condition checks.
    if (opts.stopCondition.kind === "idle") {
      const stabilityMs = opts.stopCondition.stabilityMs;
      if (deps.now() - lastChangeAt >= stabilityMs) {
        await finalize(opts, deps, lastSnapshot, "idle", lastDeltaText);
        return;
      }
    } else if (opts.stopCondition.kind === "follow") {
      const expiresAt = opts.stopCondition.expiresAt();
      if (expiresAt !== null && deps.now() >= expiresAt) {
        opts.stopCondition.onExpired?.();
        await finalize(opts, deps, lastSnapshot, "follow-timeout", lastDeltaText);
        return;
      }
    }
  }
}

async function finalize(
  opts: RunObserveLoopOptions,
  deps: ObserveLoopDeps,
  lastSnapshot: string,
  source: ObserveFinalSource["source"],
  fallback: string = "",
): Promise<void> {
  // Prefer the last delta we emitted: the user has already seen it on
  // Telegram, the Final message just confirms the turn ended. Falling
  // back to the raw pane snapshot only when no delta was ever emitted
  // (e.g. the pane was already populated before the turn started), and
  // truncating to 3000 chars to stay within Telegram's 4096-char limit
  // once we prepend headers/footers.
  let finalPayload: string;
  if (fallback.trim().length > 0) {
    finalPayload = fallback;
  } else if (lastSnapshot.trim().length > 0) {
    finalPayload = lastSnapshot.length > 3000
      ? "…\n" + lastSnapshot.slice(-3000)
      : lastSnapshot;
  } else {
    finalPayload = "";
  }
  let text: string;
  if (source === "follow-timeout") {
    text = opts.output.expiredMessage?.() ?? opts.output.finalMessage(finalPayload, { source });
  } else if (source === "signal-abort") {
    text = opts.output.abortedMessage?.() ?? opts.output.finalMessage(finalPayload, { source });
  } else {
    text = opts.output.finalMessage(finalPayload, { source });
  }
  await deps.sendMessage(opts.chatId, opts.threadId, text, {
    reply_markup: opts.output.finalKeyboard?.(),
  });
}

function readSnapshot(paneId: string, maxLines: number, communicator: AgentCommunicator): string {
  try {
    return stripStatusBar(communicator.getAgentOutput(maxLines));
  } catch {
    return "";
  }
}

function computeFollowExpiresInMs(c: FollowStopCondition, now: number): number | undefined {
  const v = c.expiresAt();
  return v === null ? undefined : Math.max(0, v - now);
}
