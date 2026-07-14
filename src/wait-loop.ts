import type { Config } from "./config.js";
import type { TelegramClient } from "./telegram-client.js";
import { sendText, readPane } from "./herdr-client.js";

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
  // Step 1: remove the entire <session_state ...>...</session_state> block
  // (any session metadata, not just context-mode).
  let clean = content.replace(/<session_state[\s\S]*?<\/session_state>/g, "");
  // Step 2: remove any standalone "context-mode active. ..." lines (in case
  // the <session_state> wrapper was missing).
  clean = clean.split("\n").filter((l) => !l.includes("context-mode active")).join("\n");
  // Step 3: line-level filtering for other noise patterns
  return clean
    .split("\n")
    .filter((l: string) => isNaturalLanguageLine(l))
    .join("\n")
    .trim();
}

/**
 * Returns true if the line looks like natural agent prose / output rather
 * than terminal noise (system banners, debug overlays, status bars, etc.).
 *
 * Heuristics:
 * - Length > 300 → noise (status bars / debug dumps)
 * - Made mostly of separator chars (─━═) → noise
 * - Starts with XML tags (<session_*, <tool_*, etc.) → noise
 * - Starts with `ctx_* >` (tool command-line) → noise
 * - More than 50% non-word characters → likely noise (status display)
 * - Contains URLs / paths / JSON-looking keys in a banner-like context → noise
 */
export function isNaturalLanguageLine(line: string): boolean {
  if (!line) return false;
  if (line.length > 300) return false;
  if (/[─━═]{20,}/.test(line)) return false;
  if (/^<[a-z_]/.test(line.trim())) return false; // XML-like opening tag
  if (/^<\//.test(line.trim())) return false; // XML-like closing tag
  if (/^ctx_\w+ /.test(line)) return false;
  if (/^<\?xml/.test(line)) return false;
  // Pure status bars: lines with many $ / % / digits / pipes and few spaces
  // are usually status displays, not prose.  Allow escape sequences too.
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  // "Decorative" chars typical of status bars / banners / diff lines.
  // Lines with too many of these are noise regardless of length.
  const decorations = (stripped.match(/[─━═|~^$%\\]/g) || []).length;
  if (decorations > 0) return false;
  // XML-ish opening/closing tags at the start of the line.
  if (/^\s*<\/?[a-z_]+/i.test(stripped)) return false;
  return true;
}

/**
 * Strip trailing status-bar / prompt lines that refresh independently of
 * the agent's output (e.g. pi cost/token display, shell prompt).  Used to
 * avoid resetting the stability timer when only the status bar changes.
 */
function stripStatusBar(content: string): string {
  const lines = content.split("\n");
  // Drop trailing lines that look like shell prompts or pi status bars
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (
      last.trim() === "" ||
      /^[─━═]{20,}/.test(last.trim()) ||
      /^.{3,} · /.test(last.trim()) ||
      /^Model: /.test(last.trim()) ||
      /^\S+\s+\S+\s+[^\s]+\$/.test(last.trim())
    ) {
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join("\n");
}

/**
 * Extract the agent's response from the pane content by anchoring on the
 * user's last input line. More robust than baseline-diff because it doesn't
 * depend on exact line-matching against a pre-send snapshot (which breaks
 * when the pane scrolls or separators are cleaned).
 */
export function extractResponseSince(
  content: string,
  userInput: string
): string {
  const lines = content.split("\n");

  // Use the last non-blank line of the user's input as the anchor.
  const userLines = userInput.split("\n").filter((l) => l.trim().length > 0);
  const anchor = userLines.length > 0 ? userLines[userLines.length - 1] : userInput;

  // Find the LAST line in the pane that contains the anchor text.
  let anchorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(anchor)) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx < 0) return "";

  let after = lines.slice(anchorIdx + 1);

  // Trim trailing noise: empty lines, separator runs, status-bar refreshes
  while (after.length > 0) {
    const last = after[after.length - 1];
    if (
      last.trim() === "" ||
      /^[─━═]{20,}/.test(last.trim()) ||
      /^.{3,} · /.test(last.trim()) ||            // status bar (any 3+ chars then middle-dot then space)
      /^Model: /.test(last.trim())                 // "Model: deepseek-v4-flash" etc.
    ) {
      after.pop();
    } else {
      break;
    }
  }

  // Trim leading blank lines
  while (after.length > 0 && after[0].trim() === "") {
    after.shift();
  }

  return after.join("\n");
}

/** Sleep for ms milliseconds. Exposed for tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface WaitLoopDeps {
  /** Send text to the pane (text + Enter). */
  sendText: (paneId: string, text: string) => void;
  /** Read recent output from the pane. */
  readPane: (paneId: string, lines: number) => string;
  /** Send a message to Telegram. */
  sendMessage: (
    chatId: number,
    threadId: number,
    text: string,
    opts?: { disable_notification?: boolean }
  ) => Promise<number>;
  /** Sleep for ms milliseconds. */
  sleep: (ms: number) => Promise<void>;
  /** Now in ms (override for tests). */
  now: () => number;
}

export const defaultWaitLoopDeps: WaitLoopDeps = {
  sendText,
  readPane,
  sendMessage: async () => {
    throw new Error("sendMessage not provided — pass a TelegramClient to runAgentTurn");
  },
  sleep,
  now: () => Date.now(),
};

export interface RunAgentTurnOptions {
  /** Lines to read from the pane (default 200). */
  maxOutputLines?: number;
  /** How often to poll the pane for changes (ms, default 1000). */
  pollIntervalMs?: number;
  /** How long the pane must be stable (no changes) before considering the
   *  response complete (ms, default 3000). */
  stabilityWindowMs?: number;
  /** Override the dependencies (for testing). */
  deps?: Partial<WaitLoopDeps>;
}

/**
 * Send text to an agent pane, wait for it to finish responding, and post the
 * response back to Telegram.
 *
 * Strategy: send the text, then poll the pane periodically. The response is
 * considered complete when the pane content has been stable (unchanged) for
 * `stabilityWindowMs` AND we've seen at least one change from the initial
 * post-send snapshot. The response is extracted by anchoring on the user's
 * last input line instead of computing a line-level diff from a baseline.
 * This avoids relying on herdr's (sometimes inaccurate) agent_status field.
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
  const opts: RunAgentTurnOptions =
    typeof maxOutputLinesOrOptions === "number"
      ? { maxOutputLines: maxOutputLinesOrOptions }
      : maxOutputLinesOrOptions;
  const tgSendMessage = async (
    c: number,
    t: number,
    txt: string,
    o?: { disable_notification?: boolean }
  ) => tg.sendMessage(c, t, txt, o);
  const sendMsg = opts.deps?.sendMessage ?? tgSendMessage;
  const deps: WaitLoopDeps = {
    sendText: opts.deps?.sendText ?? sendText,
    readPane: opts.deps?.readPane ?? readPane,
    sendMessage: sendMsg,
    sleep: opts.deps?.sleep ?? sleep,
    now: opts.deps?.now ?? defaultWaitLoopDeps.now,
  };
  const maxOutputLines = opts.maxOutputLines ?? 200;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const stabilityWindowMs = opts.stabilityWindowMs ?? 3000;

  deps.sendText(paneId, text);

  const startTime = deps.now();

  // Capture first snapshot AFTER sending text (the "before agent responds" state).
  let lastContent = "";
  try {
    lastContent = deps.readPane(paneId, maxOutputLines);
  } catch {
    // Pane might not be readable — proceed with empty snapshot
  }

  let lastChangeAt = deps.now();
  let sawChange = false;
  let lastProgressSentAt = 0;
  let progressCount = 0;

  // Phase 1: wait for the pane to start changing from the post-send snapshot.
  // The agent needs to pick up the input — this can take a few seconds.
  while (deps.now() - startTime < cfg.maxTotalWaitS * 1000) {
    await deps.sleep(pollIntervalMs);
    let current = "";
    try {
      current = deps.readPane(paneId, maxOutputLines);
    } catch {
      continue;
    }
    if (current !== lastContent) {
      sawChange = true;
      lastContent = current;
      lastChangeAt = deps.now();
      break;
    }
    // Still no change — check timeout
    if (deps.now() - startTime > cfg.maxTotalWaitS * 1000) break;
  }

  if (!sawChange) {
    // No change at all — maybe the pane didn't pick up the input.
    const elapsed = Math.floor((deps.now() - startTime) / 1000);
    await sendMsg(chatId, threadId, `⚠️ No response from pane after ${formatElapsed(elapsed)}.`);
    return;
  }

  // Phase 2: wait for the pane to stabilize (no changes for stabilityWindowMs).
  while (deps.now() - startTime < cfg.maxTotalWaitS * 1000) {
    await deps.sleep(pollIntervalMs);
    let current = "";
    try {
      current = deps.readPane(paneId, maxOutputLines);
    } catch {
      continue;
    }
    if (current !== lastContent) {
      // Pane changed — but ignore status-bar-only refreshes (pi cost/token
      // display updates every ~2s) that don't reflect real agent output.
      const stableCurrent = stripStatusBar(current);
      const stableLast = stripStatusBar(lastContent);
      if (stableCurrent !== stableLast) {
        // Real content changed — reset stability timer
        lastContent = current;
        lastChangeAt = deps.now();
        // Send a progress update (throttled)
        const elapsedMs = deps.now() - startTime;
        if (deps.now() - lastProgressSentAt > cfg.throttleMs) {
          progressCount++;
          const limited = cfg.maxProgressUpdates > 0 && progressCount >= cfg.maxProgressUpdates;
          const clean = cleanPaneOutput(current);
          const soFar = extractResponseSince(clean, text);
          // On the last allowed update, include a "giving up" prefix
          const prefix = limited ? "⚠️ Agent didn't respond in time.\n\n" : "";
          const body = soFar.length > 2000
            ? soFar.slice(0, 2000) + "..."
            : soFar;
          const truncated = limited
            ? `${prefix}${body}\n\nTry /digest for a summary.`
            : body;
          const elapsed = Math.floor(elapsedMs / 1000);
          await sendMsg(chatId, threadId, `⏳ Working (${formatElapsed(elapsed)}):\n\n${truncated}`, {
            disable_notification: true,
          });
          lastProgressSentAt = deps.now();
          if (limited) return;
        }
      } else {
        // Only status bar changed — update lastContent silently so
        // the next raw compare doesn't re-enter this branch either.
        lastContent = current;
      }
      continue;
    }
    // Pane stable — check if stability window has elapsed
    if (deps.now() - lastChangeAt >= stabilityWindowMs) {
      break;
    }
  }

  // Phase 3: read final content, extract response, send to Telegram.
  let finalContent = lastContent;
  try {
    finalContent = deps.readPane(paneId, maxOutputLines);
  } catch {
    // Use lastContent
  }
  const clean = cleanPaneOutput(finalContent);
  const responseText = extractResponseSince(clean, text);
  const truncated = responseText.length > 3900
    ? responseText.slice(0, 3900) + `\n\n... (truncated, ${responseText.length} chars total)`
    : responseText;
  const elapsed = Math.floor((deps.now() - startTime) / 1000);
  await sendMsg(chatId, threadId, `✅ (${formatElapsed(elapsed)}):\n\n${truncated}`);
}