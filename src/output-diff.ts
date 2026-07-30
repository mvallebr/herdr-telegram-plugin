/**
 * Output diff primitives shared between the observe loop and the
 * per-pane `AgentCommunicator`.
 *
 * History: these helpers used to live inside `observe-loop.ts`. As of
 * Task 2 of the PaneAgent refactor, the diff state moves into
 * `AgentCommunicator` (so polling loops can read it and `/last` can
 * avoid consuming it). To avoid a circular dep between the loop and
 * the communicator, the pure helpers are extracted here.
 *
 * Behavioural contract (preserved from `observe-loop.ts`):
 *
 *   - `tailOf(s, n)` returns the trailing `n` characters of `s`, or
 *     the whole string when `s` is shorter than `n`.
 *   - `SENT_TAIL_MAX` is the overlap-anchor window the loop remembers
 *     for already-delivered content. Larger values are robust to long
 *     "Working" runs but cost memory.
 *   - `deriveUnseen(snapshot, sentTail)` returns the portion of the
 *     snapshot the user has not seen yet:
 *       1. exact tail match via `lastIndexOf`,
 *       2. window-slide fallback when sentTail was dropped off the
 *          head of a rolling snapshot,
 *       3. no anchor — return "". Emitting a placeholder here would
 *          duplicate already-delivered content.
 *   - `chunkForTelegram(unseen, workingSuffix)` splits the unseen
 *     payload into Telegram-friendly chunks whose TOTAL size
 *     (with the `workingSuffix` appended) is bounded by
 *     `MAX_CHUNK_TOTAL`.
 *
 * None of these helpers throw. They are pure and source-agnostic.
 */

/** Last N chars of delivered content the loop remembers for overlap. */
export const SENT_TAIL_MAX = 10_000;

/**
 * Hard cap on a single Telegram message body, including its Working tail.
 * Lives here too because `chunkForTelegram` honours it directly.
 */
export const MAX_CHUNK_TOTAL = 3_000;

/** Last `n` characters of `s` (the whole string when shorter than `n`). */
export function tailOf(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
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
