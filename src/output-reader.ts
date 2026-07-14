/**
 * Output extraction orchestrator.
 *
 * Tries the best available strategy for each agent:
 *   1. Jsonl session log (pi, omp, and others that report session.path)
 *   2. Screen scraping via herdr pane read (fallback)
 *
 * Both strategies follow the same contract: send text → wait for stable
 * response → extract response.
 */
import { readPane, getAgentInfo, sendText, waitIdle } from "./herdr-client.js";
import {
  pickOutputStrategy,
  readPiSessionResponse,
  type AgentResponse,
} from "./agent-sessions.js";

export type OutputSource = "pi-jsonl" | "omp-jsonl" | "screen-scrape";

export interface ExtractedOutput {
  text: string;
  source: OutputSource;
  /** Reason a fallback was used, or undefined for the primary strategy. */
  fallbackReason?: string;
}

export interface OutputReaderDeps {
  sendText: (paneId: string, text: string) => void;
  waitIdle: (paneId: string, timeoutS: number) => { status: "idle" | "blocked" | "timeout" };
  readPane: (paneId: string, lines: number) => string;
  /** Override for getAgentInfo (testing). */
  getAgentInfo?: (target: string) => ReturnType<typeof getAgentInfo>;
  /** Override for jsonl reader (testing). */
  readJsonl?: (path: string, sinceMs: number) => AgentResponse | null;
  /** Now in ms (override for tests). */
  now?: () => number;
}

export const defaultDeps: Required<OutputReaderDeps> = {
  sendText,
  waitIdle,
  readPane,
  getAgentInfo,
  // Default reader is generic — supports pi + omp + unknown agents that
  // happen to use the same jsonl format.
  readJsonl: (path, sinceMs) => readPiSessionResponse(path, sinceMs),
  now: () => Date.now(),
};

export interface ReadAgentOutputOptions {
  paneId: string;
  prompt: string;
  maxWaitS: number;
  /** Lines to read in the screen-scrape fallback (default 200). */
  maxOutputLines?: number;
  /** Override deps (testing). */
  deps?: OutputReaderDeps;
  /**
   * Optional anchor: extract the response AFTER this line in the pane
   * (used to skip pre-send scrollback).  Same heuristic as the screen
   * scrape strategy in wait-loop.ts.
   */
  extractResponseSince?: (content: string, userInput: string) => string;
}

/**
 * Send a prompt to the agent and read back the response.
 *
 * Returns null if the agent didn't respond at all.
 * Throws on transport errors (herdr unreachable, etc).
 */
export async function readAgentOutput(
  opts: ReadAgentOutputOptions
): Promise<ExtractedOutput | null> {
  const deps = { ...defaultDeps, ...(opts.deps ?? {}) };
  const now = deps.now;
  const maxLines = opts.maxOutputLines ?? 200;

  // 1. Discover the agent's session path (if any).
  let agentInfo: ReturnType<typeof getAgentInfo>;
  try {
    agentInfo = deps.getAgentInfo(opts.paneId);
  } catch {
    agentInfo = null;
  }
  const strategy = pickOutputStrategy(
    agentInfo?.agent_session,
    agentInfo?.agent ?? "?"
  );

  // 2. Send the prompt and remember when we did.
  const sendStartedAt = now();
  deps.sendText(opts.paneId, opts.prompt);

  // 3. Wait for the agent to finish (herdr's agent wait reports working
  //    transitions; we use idle as the "done" signal).
  const waitResult = deps.waitIdle(opts.paneId, opts.maxWaitS);

  // 4. Try the jsonl reader first (cheap, perfect content).
  if (strategy.strategy === "jsonl" && agentInfo?.agent_session?.kind === "path") {
    const path = agentInfo.agent_session.path;
    const response = deps.readJsonl(path, sendStartedAt);
    if (response && response.text) {
      const src: OutputSource =
        agentInfo.agent === "omp" ? "omp-jsonl" : "pi-jsonl";
      return {
        text: response.text,
        source: src,
      };
    }
    // Jsonl failed — fall through to screen scraping.
  }

  // 5. Screen scrape fallback.
  let content: string;
  try {
    content = deps.readPane(opts.paneId, maxLines);
  } catch {
    return null;
  }

  // If we couldn't use jsonl at all, note the reason.
  const fallbackReason =
    strategy.strategy === "scrape"
      ? strategy.reason
      : strategy.strategy === "jsonl"
        ? "jsonl returned no usable response after wait"
        : undefined;

  const text = opts.extractResponseSince
    ? opts.extractResponseSince(content, opts.prompt)
    : content;

  return {
    text,
    source: "screen-scrape",
    fallbackReason,
  };
}