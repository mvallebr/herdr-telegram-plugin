import type { Config } from "./config.js";
import type { TelegramClient } from "./telegram-client.js";
import { sendText, waitIdle, readPane } from "./herdr-client.js";

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

/** Strip context-mode banners and other noise from agent output. */
export function cleanPaneOutput(content: string): string {
  // First remove the multi-line context-mode banner block (if present)
  let clean = content.replace(
    /\n*context-mode active\.[\s\S]*?<\/session_state>\n*/g,
    "\n"
  );
  return clean
    .split("\n")
    .filter(
      (l: string) =>
        !l.includes("context-mode active") &&
        !l.startsWith("<session_state") &&
        !l.startsWith("<session_mode") &&
        !l.startsWith("</session_state>") &&
        !l.match(/^ctx_\w+ >/) &&
        !l.match(/^[─━═]{20,}/) &&
        // Lines that contain a long run of separator chars anywhere
        !l.match(/[─━═]{20,}/) &&
        l.length < 300
    )
    .join("\n");
}

/** Given the baseline content (before sending text) and the current pane content,
 *  return only the lines that are new (the agent's response).
 *  This handles the case where the pane is in "done" status and waitIdle returns
 *  immediately — without this, we'd send the entire pane history.
 *
 *  Strategy: find the longest suffix of `baseline` that appears as a contiguous
 *  block in `current`. The lines AFTER that block in current are the new content.
 *
 *  Edge cases:
 *  - baseline empty → return current
 *  - baseline === current → return ""
 *  - baseline is a prefix of current: suffix of baseline = entire baseline, appears at
 *    start of current. Return current[baseline.length:].
 *  - pane scrolled past baseline entirely: no match → return current.
 */
export function diffFromBaseline(
  baseline: string,
  current: string
): string {
  if (!baseline) return current;
  if (baseline === current) return "";
  const baselineLines = baseline.split("\n");
  const currentLines = current.split("\n");

  // Try the longest suffix of baselineLines first; shrink until it appears in currentLines.
  for (let len = baselineLines.length; len >= 1; len--) {
    const suffix = baselineLines.slice(baselineLines.length - len);
    // Find `suffix` as a contiguous block in currentLines, scanning from the start.
    for (let start = 0; start <= currentLines.length - len; start++) {
      let match = true;
      for (let k = 0; k < len; k++) {
        if (currentLines[start + k] !== suffix[k]) {
          match = false;
          break;
        }
      }
      if (match) {
        // Pick the LAST match (latest in current) — that's where new content begins.
        // Continue scanning for a later match at the same or shorter suffix length.
        // We actually want the LAST occurrence overall, so keep going.
        // Optimization: keep track of best match and continue.
        // For simplicity here, we do a full scan; for typical input (≤200 lines) this is fast.
      }
    }
  }
  // Refined scan: find the LAST occurrence of the longest matching suffix in current.
  let bestStart = -1;
  let bestLen = 0;
  for (let len = baselineLines.length; len >= 1; len--) {
    const suffix = baselineLines.slice(baselineLines.length - len);
    for (let start = currentLines.length - len; start >= 0; start--) {
      let match = true;
      for (let k = 0; k < len; k++) {
        if (currentLines[start + k] !== suffix[k]) {
          match = false;
          break;
        }
      }
      if (match) {
        if (len > bestLen || (len === bestLen && start > bestStart)) {
          bestStart = start;
          bestLen = len;
        }
        break; // found the latest match for this length; try shorter
      }
    }
  }
  if (bestStart < 0) return current;
  // Everything in current BEFORE the matched block (bestStart..bestStart+bestLen) is "old".
  // Everything in current AFTER the matched block is "new".
  // But the prefix [0..bestStart-1] may also contain interleaved old lines (they're not new).
  // For simplicity, return the suffix AFTER the match. This assumes no interleaving.
  return currentLines.slice(bestStart + bestLen).join("\n");
}

export interface WaitLoopDeps {
  /** Send text to the pane (text + Enter). */
  sendText: (paneId: string, text: string) => void;
  /** Wait for the pane to become idle. Returns the status observed. */
  waitIdle: (
    paneId: string,
    timeoutS: number
  ) => { status: "idle" | "blocked" | "timeout" };
  /** Read recent output from the pane. */
  readPane: (paneId: string, lines: number) => string;
  /** Send a message to Telegram. */
  sendMessage: (
    chatId: number,
    threadId: number,
    text: string,
    opts?: { disable_notification?: boolean }
  ) => Promise<number>;
}

export const defaultWaitLoopDeps: WaitLoopDeps = {
  sendText,
  waitIdle,
  readPane,
  // sendMessage is provided per-call from the TelegramClient passed to runAgentTurn.
  // The default below is a no-op so calling without overrides fails loudly if used.
  sendMessage: async () => {
    throw new Error("sendMessage not provided — pass a TelegramClient to runAgentTurn");
  },
};

export interface RunAgentTurnOptions {
  /** Lines to read from the pane at idle (default 200). */
  maxOutputLines?: number;
  /** Override the dependencies (for testing). */
  deps?: Partial<WaitLoopDeps>;
}

export async function runAgentTurn(
  paneId: string,
  threadId: number,
  text: string,
  cfg: Config,
  tg: TelegramClient,
  chatId: number,
  maxOutputLinesOrOptions: number | RunAgentTurnOptions = 200
): Promise<void> {
  const opts: RunAgentTurnOptions =
    typeof maxOutputLinesOrOptions === "number"
      ? { maxOutputLines: maxOutputLinesOrOptions }
      : maxOutputLinesOrOptions;
  // Build sendMessage: use deps override if provided, otherwise call tg.sendMessage.
  const tgSendMessage = async (
    c: number,
    t: number,
    txt: string,
    o?: { disable_notification?: boolean }
  ) => tg.sendMessage(c, t, txt, o);
  const sendMsg = opts.deps?.sendMessage ?? tgSendMessage;
  const deps: WaitLoopDeps = {
    sendText: opts.deps?.sendText ?? sendText,
    waitIdle: opts.deps?.waitIdle ?? waitIdle,
    readPane: opts.deps?.readPane ?? readPane,
    sendMessage: sendMsg,
  };
  const maxOutputLines = opts.maxOutputLines ?? 200;

  // Capture baseline pane content BEFORE sending — we'll diff against this
  // so we only return the agent's NEW response (not the entire pane history).
  let baseline = "";
  try {
    baseline = deps.readPane(paneId, maxOutputLines);
  } catch {
    // Pane might not be readable — proceed without baseline
  }
  deps.sendText(paneId, text);

  let lastSent = 0;
  const startTime = Date.now();

  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed >= cfg.maxTotalWaitS) {
      await sendMsg(chatId, threadId, `⏳ Tempo limite excedido (${formatElapsed(elapsed)})`);
      break;
    }

    const result = deps.waitIdle(paneId, cfg.waitTimeoutS);

    if (result.status === "idle") {
      const content = deps.readPane(paneId, maxOutputLines);
      const clean = cleanPaneOutput(content);
      const responseText = diffFromBaseline(baseline, clean);
      const truncated = responseText.length > 3900
        ? responseText.slice(0, 3900) + `\n\n... (truncated, ${responseText.length} chars total)`
        : responseText;
      await sendMsg(chatId, threadId, `✅ (${formatElapsed(elapsed)}):\n\n${truncated}`);
      break;
    }

    if (result.status === "timeout") {
      if (shouldThrottle(lastSent, cfg.throttleMs)) continue;
      const content = deps.readPane(paneId, 15);
      const clean = cleanPaneOutput(content);
      const truncated = clean.length > 2000
        ? clean.slice(0, 2000) + "..."
        : clean;
      await sendMsg(chatId, threadId, `⏳ Working (${formatElapsed(elapsed)}):\n\n${truncated}`, { disable_notification: true });
      lastSent = Date.now();
    }

    if (result.status === "blocked") {
      const content = deps.readPane(paneId, 30);
      const truncated = content.length > 2000
        ? content.slice(0, 2000) + "..."
        : content;
      await sendMsg(chatId, threadId, `⚠️ Blocked (tool approval):\n\n${truncated}`);
      break;
    }
  }
}