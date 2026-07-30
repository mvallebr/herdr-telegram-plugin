/**
 * Single observe loop: poll a pane, emit Working stamps and cumulative
 * pane deltas, finish when the active stop condition is met.
 *
 * Used by both Working mode (turn ends on idle) and Follow mode (turn
 * ends on a timer or /unfollow). Stop conditions and output shape are
 * supplied per-call so callers can swap them mid-run.
 *
 * CUMULATIVE DELIVERY (since PR #11):
 *
 *   The reader returns a snapshot string on every poll. Instead of
 *   computing byte-level deltas against the previous snapshot (which
 *   breaks when the structured source window slides or the scrape
 *   reader returns a scrolled-tail prefix), we maintain a rolling
 *   `sentTail` of the last SENT_TAIL_MAX chars we actually emitted.
 *
 *   On the FIRST poll we seed sentTail with the snapshot's tail and
 *   emit nothing — historical content is never replayed. On every
 *   later poll we derive only the UNSEEN suffix:
 *
 *     1. Find the latest occurrence of sentTail inside the snapshot.
 *        Anything after it (slice past the match) is new.
 *     2. If sentTail is not fully present (e.g. the structured
 *        reader's 50-message window slid off the head), find the
 *        largest k such that `snapshot.startsWith(sentTail.slice(-k))`.
 *        Anything after those first k chars is new.
 *     3. If neither matches, the previous content cannot be anchored
 *        safely — emit nothing (the user already saw it; emit a
 *        `(pane scrolled)` placeholder would risk duplication).
 *
 *   When new content exists, it is split into Telegram-friendly
 *   chunks whose TOTAL size (including the trailing Working marker)
 *   never exceeds MAX_CHUNK_TOTAL. Each chunk ends with
 *   `\n\n⏳ Working (Xs).`. While chunks are emitting, the polling
 *   poll emits no separate bare Working tick.
 *
 *   When no new content exists (snapshot unchanged), the poll emits
 *   exactly one bare Working tick — same cadence as before.
 *
 *   Source-AGNOSTIC: the loop never inspects the snapshot shape; it
 *   receives strings and applies the same overlap-and-chunk algorithm.
 *   Scrape readers and cumulative SQLite readers both flow through it.
 */
import type { TelegramClient } from "./telegram-client.js";
import type { Config } from "./config.js";
import type { AgentCommunicator } from "./agent-sessions.js";

// --- Tuning constants -----------------------------------------------------

/** Last N chars of delivered content the loop remembers for overlap. */
export const SENT_TAIL_MAX = 10_000;

/** Hard cap on a single Telegram message body, including its Working tail. */
export const MAX_CHUNK_TOTAL = 3_000;

/**
 * Max length of the final payload sent to Telegram (same limit as chunk total).
 */
const MAX_FINAL_PAYLOAD = MAX_CHUNK_TOTAL;

/** Prefix prepended when the snapshot is truncated for the final payload. */
const ELLIPSIS_PREFIX = "…\n";

// --- Stop conditions ------------------------------------------------------

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

// --- Output formatter -----------------------------------------------------

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

// --- Public entry point ---------------------------------------------------

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

  // Seed phase: read once and remember the trailing SENT_TAIL_MAX chars as
  // the rolling baseline. We DO NOT emit anything for the baseline — the
  // existing pane content is what the user has been watching live, so
  // replaying it would duplicate prior output.
  const initialSnapshot = readSnapshot(opts.paneId, maxLines, communicator);
  let sentTail = tailOf(initialSnapshot, SENT_TAIL_MAX);
  let lastSnapshot = initialSnapshot;
  let lastChangeAt = deps.now();
  const startedAt = lastChangeAt;

  // Track the most recent *non-empty* chunk we emitted.  When the loop
  // finalises we surface this as the fallback Final payload — it's the
  // most recent content the user has actually seen on Telegram and acts
  // as a durable recap even after the agent redraws the pane.
  let lastDeltaText = "";

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

    // pane-clear detection: a snapshot that goes from non-empty to empty
    // is a real change but the agent has stopped producing.  Don't reset
    // lastChangeAt so the stability window can finalize.
    const becameEmpty = lastSnapshot.length > 0 && current.length === 0;
    const byteChanged = current !== lastSnapshot;
    if (byteChanged && current.length > 0 && !becameEmpty) {
      lastChangeAt = deps.now();
    }
    lastSnapshot = current;

    const followExpiresInMs =
      opts.stopCondition.kind === "follow"
        ? computeFollowExpiresInMs(opts.stopCondition, deps.now())
        : undefined;

    // Derive what (if anything) the user hasn't seen yet. The first poll
    // never emits historic replay — we already seeded sentTail with the
    // baseline above.
    const unseen = current !== initialSnapshot
      ? deriveUnseen(current, sentTail)
      : "";

    if (unseen.length > 0) {
      // Chunk and emit. Each chunk ends with `\n\n⏳ Working (Xs).` — the
      // suffix counts toward MAX_CHUNK_TOTAL. We do NOT also send a bare
      // Working tick this iteration; the chunks carry the cadence.
      //
      // After emission, re-anchor sentTail to the LITERAL current
      // snapshot.  Anchoring to chunk-derived content caused
      // trailing-`\n` mismatches against scrape snapshots whose final
      // newline was stripped by `stripStatusBar` — using the snapshot
      // itself guarantees substring semantics match on the next poll.
      // We still tail() to keep it bounded by SENT_TAIL_MAX.
      const elapsedText = formatElapsedString(elapsedSec, followExpiresInMs);
      const chunks = chunkForTelegram(unseen, elapsedText);
      for (const chunk of chunks) {
        const formatted = opts.output.paneDelta(chunk);
        await deps.sendMessage(opts.chatId, opts.threadId, formatted, {
          reply_markup: opts.output.workingKeyboard?.(),
        });
        lastDeltaText = chunk;
      }
      sentTail = tailOf(current, SENT_TAIL_MAX);
    } else {
      // No new content — emit exactly one bare Working tick, same as the
      // pre-cumulative behaviour, so the loop's heartbeat is unchanged.
      await deps.sendMessage(
        opts.chatId,
        opts.threadId,
        opts.output.workingTick({ elapsedSec, followExpiresInMs }),
        {
          disable_notification: true,
          reply_markup: opts.output.workingKeyboard?.(),
        },
      );
    }

    // Stop condition checks.
    if (opts.stopCondition.kind === "idle") {
      const stabilityMs = opts.stopCondition.stabilityMs;
      if (deps.now() - lastChangeAt >= stabilityMs) {
        await finalize(opts, deps, current, "idle", lastDeltaText);
        return;
      }
    } else if (opts.stopCondition.kind === "follow") {
      const expiresAt = opts.stopCondition.expiresAt();
      if (expiresAt !== null && deps.now() >= expiresAt) {
        opts.stopCondition.onExpired?.();
        await finalize(opts, deps, current, "follow-timeout", lastDeltaText);
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
  // Prefer the most recent chunk we emitted (the user has already seen
  // it on Telegram, the Final is just a stable recap).  Fall back to the
  // raw pane snapshot ONLY when no chunk was ever emitted (e.g. the pane
  // was already populated before the loop started). Truncate to the
  // Telegram safety limit when needed.
  let finalPayload: string;
  if (fallback.trim().length > 0) {
    finalPayload = fallback;
  } else if (lastSnapshot.trim().length > 0) {
    finalPayload = lastSnapshot.length > MAX_FINAL_PAYLOAD
      ? ELLIPSIS_PREFIX + lastSnapshot.slice(-(MAX_FINAL_PAYLOAD - ELLIPSIS_PREFIX.length))
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
    // Source-agnostic: structured readers return byte-for-byte content.
    // ScrapeReader applies its own terminal-status cleanup internally.
    return communicator.getAgentOutput(maxLines);
  } catch {
    return "";
  }
}

function computeFollowExpiresInMs(c: FollowStopCondition, now: number): number | undefined {
  const v = c.expiresAt();
  return v === null ? undefined : Math.max(0, v - now);
}

/**
 * Derive the portion of `snapshot` the user has not seen yet, anchored
 * against the last `sentTail` chars we delivered.
 *
 *   1. Exact match: lastIndexOf(sentTail) — everything after the match
 *      is new. Handles the common "agent appended content" case.
 *   2. Window-slide fallback: when the structured source's rolling
 *      window dropped the head, sentTail is not fully present.
 *      We find the largest k such that the new snapshot starts with
 *      sentTail's last k chars and emit everything after.
 *   3. No anchor — return "". This is deliberate: emitting a
 *      `(pane scrolled)` marker would duplicate already-sent content.
 *
 * Trailing-newline note: ScrapeReader applies `stripStatusBar`, which
 * can drop the single trailing `\n` off a snapshot. The chunk we emit
 * carries no leading `\n` (we strip those), so the trailing-newline
 * mismatch is harmless — we just compare a snapshot whose final char is
 * `\n` against a sentTail whose final char may be non-`\n` (or vice-
 * versa) and rely on substring semantics. A real `\n` at position 17
 * inside the snapshot still anchors overlap just fine.
 */
export function deriveUnseen(snapshot: string, sentTail: string): string {
  if (!sentTail) return "";
  const idx = snapshot.lastIndexOf(sentTail);
  if (idx >= 0) {
    const after = snapshot.slice(idx + sentTail.length);
    return after.replace(/^\n+/, "");
  }
  // Fallback: largest k where snapshot.startsWith(sentTail.slice(-k)).
  const max = Math.min(snapshot.length, sentTail.length);
  for (let k = max; k > 0; k--) {
    if (snapshot.startsWith(sentTail.slice(sentTail.length - k))) {
      const after = snapshot.slice(k);
      return after.replace(/^\n+/, "");
    }
  }
  return "";
}

/** Last `n` characters of `s` (the whole string when shorter than `n`). */
export function tailOf(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}

/**
 * Split `unseen` into Telegram-friendly chunks. Every chunk's TOTAL size
 * (after the `\n\n⏳ Working (Xs).` suffix is appended) is bounded by
 * `MAX_CHUNK_TOTAL`. The working suffix counts.
 */
export function chunkForTelegram(unseen: string, workingSuffix: string): string[] {
  if (!unseen) return [];
  // Body for the first chunk: leave room for the suffix.
  const firstBody = MAX_CHUNK_TOTAL - workingSuffix.length - 2 /* "\n\n" */;
  if (unseen.length <= firstBody) {
    return [`${unseen}\n\n${workingSuffix}`];
  }
  // After chunk 1 starts with `\n\n⏳ Working (Xs).`, we know its body
  // fits. Remaining chunks attach the suffix again. We split the body
  // into pieces that fit the limit minus suffix.
  const chunks: string[] = [`${unseen.slice(0, firstBody)}\n\n${workingSuffix}`];
  let rest = unseen.slice(firstBody);
  const bodySize = MAX_CHUNK_TOTAL - workingSuffix.length - 2;
  while (rest.length > 0) {
    if (rest.length <= bodySize) {
      chunks.push(`${rest}\n\n${workingSuffix}`);
      break;
    }
    chunks.push(`${rest.slice(0, bodySize)}\n\n${workingSuffix}`);
    rest = rest.slice(bodySize);
  }
  return chunks;
}

/**
 * Format an elapsed + follow-expiry tick suffix in the legacy Wire
 * format: `⏳ Working (Xs).` or `⏳ Working (Xm Ys, follow expires in Zs).`.
 *
 * Inlined here so observe-loop stays self-contained: wait-loop.ts owns
 * the canonical formatter but importing it would create a circular
 * dep at module load time.
 */
function formatElapsedString(
  elapsedSec: number,
  followExpiresInMs: number | undefined,
): string {
  const totalSec = Math.max(0, elapsedSec);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  let elapsedText: string;
  if (h > 0) elapsedText = `${h}h ${m}m ${s}s`;
  else if (m > 0) elapsedText = `${m}m ${s}s`;
  else elapsedText = `${s}s`;
  if (followExpiresInMs !== undefined) {
    const expSec = Math.max(0, Math.floor(followExpiresInMs / 1000));
    const eh = Math.floor(expSec / 3600);
    const em = Math.floor((expSec % 3600) / 60);
    const es = expSec % 60;
    let expiryText: string;
    if (eh > 0) expiryText = `${eh}h ${em}m ${es}s`;
    else if (em > 0) expiryText = `${em}m ${es}s`;
    else expiryText = `${es}s`;
    return `⏳ Working (${elapsedText}, follow expires in ${expiryText}).`;
  }
  return `⏳ Working (${elapsedText}).`;
}
