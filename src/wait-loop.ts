import type { Config } from "./config.js";
import type { TelegramClient } from "./telegram-client.js";
import { sendText, readPane } from "./herdr-client.js";
import { createAgentWrapper, ScreenScrapeWrapper } from "./agent-wrappers.js";
import { coordinateTurn } from "./turn-coordinator.js";
import { TelegramTurnReporter } from "./telegram-reporter.js";

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

/** Strip context-mode banners and terminal chrome from scraped output. */
export function cleanPaneOutput(content: string): string {
  let clean = content.replace(/<session_state[\s\S]*?<\/session_state>/g, "");
  // Terminal UIs (notably OpenCode) prefix otherwise useful prompt/output
  // lines with a vertical border. Remove that chrome before line filtering so
  // the submitted-prompt anchor remains available for extraction.
  clean = clean.replace(/^[\s┃│▏▕]+/gm, "");
  clean = clean.split("\n").filter((line) => !line.includes("context-mode active")).join("\n");
  return clean.split("\n").filter(isNaturalLanguageLine).join("\n").trim();
}

export function isNaturalLanguageLine(line: string): boolean {
  if (!line || line.length > 300) return false;
  if (/^\d[\d,.]*\s+tokens$/.test(line.trim()) || /^LSPs? are disabled$/.test(line.trim())) return false;
  if (/[─━═]{20,}/.test(line) || /^ctx_\w+ /.test(line) || /^<\/?[a-z_]/i.test(line.trim())) return false;
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (/[^\x20-\x7E\u00A0-\u00FF\u2010-\u2026]/.test(stripped)) return false;
  return !/[─━═|~^$%\\·•]/.test(stripped);
}

/** Remove terminal status lines that refresh independently of agent output. */
export function stripStatusBar(content: string): string {
  const lines = content.split("\n");
  while (lines.length) {
    const last = lines.at(-1)!;
    if (
      last.trim() === "" ||
      /^[─━═]{20,}/.test(last.trim()) ||
      /^.{3,} · /.test(last.trim()) ||
      /^Model: /.test(last.trim()) ||
      /^\S+\s+\S+\s+[^\s]+\$$/.test(last.trim())
    ) lines.pop();
    else break;
  }
  return lines.join("\n");
}

/** Return only content after the last occurrence of the submitted prompt. */
export function extractResponseSince(content: string, userInput: string): string {
  const lines = content.split("\n");
  const userLines = userInput.split("\n").filter((line) => line.trim());
  const anchor = userLines.at(-1) ?? userInput;
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(anchor)) { index = i; break; }
    // Some terminal UIs append status text to the prompt line or wrap its
    // tail. The first 80 chars remain a unique, safe turn anchor.
    if (anchor.length > 80 && lines[i].includes(anchor.slice(0, 80))) { index = i; break; }
  }
  if (index < 0) return "";
  const after = lines.slice(index + 1);
  while (after.length && (after[0].trim() === "")) after.shift();
  return stripStatusBar(after.join("\n"));
}

/** Scrape only a response unambiguously anchored to the submitted prompt. */
export function extractScreenResponse(content: string, userInput: string): string {
  // Locate the prompt before filtering. Long OpenCode prompt lines can carry
  // terminal metadata and exceed the prose filter, but remain the safest
  // correlation anchor for this turn.
  const dechromed = content.replace(/^[\s┃│▏▕]+/gm, "");
  return cleanPaneOutput(extractResponseSince(dechromed, userInput));
}

/**
 * Fallback when a terminal UI removes the submitted prompt after accepting
 * it. Returns only the changed suffix when a stable snapshot has a shared
 * prefix; callers must use it only for content observed after `submit`.
 */
export function extractScreenDelta(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let shared = 0;
  while (shared < oldLines.length && shared < newLines.length && oldLines[shared] === newLines[shared]) shared += 1;
  if (shared === 0 || shared === newLines.length) return "";
  return cleanPaneOutput(newLines.slice(shared).join("\n"));
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
}

/**
 * Composition root for one Telegram turn. The coordinator owns lifecycle;
 * wrappers own agent transport; the reporter owns Telegram presentation.
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
  const deps: WaitLoopDeps = {
    sendText: opts.deps?.sendText ?? sendText,
    readPane: opts.deps?.readPane ?? readPane,
    sendMessage: opts.deps?.sendMessage ?? ((c, t, body, options) => tg.sendMessage(c, t, body, options)),
    sleep: opts.deps?.sleep ?? sleep,
    now: opts.deps?.now ?? (() => Date.now()),
  };
  // This is a terminal read window, not a Telegram response limit. Start
  // wide enough for a 4k response that wrapped in a narrow terminal; the
  // scraper expands further if its prompt anchor has scrolled away.
  const maxOutputLines = opts.maxOutputLines ?? 1_000;
  const startedAt = deps.now();
  const telegram = { sendMessage: deps.sendMessage } as Pick<TelegramClient, "sendMessage">;
  const reporter = new TelegramTurnReporter(telegram, chatId, threadId, deps.now, startedAt);
  // Unit tests deliberately provide pane mocks; keep those entirely at the
  // screen adapter seam instead of invoking the real Herdr metadata command.
  const wrapper = opts.deps
    ? new ScreenScrapeWrapper(paneId, maxOutputLines, opts.stabilityWindowMs ?? cfg.progressIntervalMs, deps)
    : createAgentWrapper(paneId, { maxOutputLines, stabilityWindowMs: opts.stabilityWindowMs ?? cfg.progressIntervalMs }, deps);
  await coordinateTurn(wrapper, reporter, {
    prompt: text,
    progressIntervalMs: opts.pollIntervalMs ?? cfg.progressIntervalMs,
    maxWaitMs: cfg.maxTotalWaitS * 1000,
    maxProgressUpdates: cfg.maxProgressUpdates,
  }, deps);
}
