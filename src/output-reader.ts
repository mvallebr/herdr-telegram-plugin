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
  readAgentSessionResponse,
  type AgentResponse,
} from "./agent-sessions.js";

export type OutputSource = "pi-jsonl" | "omp-jsonl" | "codex-jsonl" | "screen-scrape" | "unavailable";

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
  readJsonl?: (path: string, sinceMs: number, prompt?: string) => AgentResponse | null;
  /** Now in ms (override for tests). */
  now?: () => number;
  /** Delay used while a session log flushes after the agent becomes idle. */
  sleep?: (ms: number) => Promise<void>;
}

export const defaultDeps: Required<OutputReaderDeps> = {
  sendText,
  waitIdle,
  readPane,
  getAgentInfo,
  readJsonl: (path, sinceMs, prompt) => readAgentSessionResponse({ kind: "path", path }, "?", sinceMs, prompt),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
  if (strategy.strategy === "jsonl") {
    const path = agentInfo?.agent_session?.kind === "path" ? agentInfo.agent_session.path : undefined;
    // `agent wait` can report a transient idle state before Codex has
    // finished a turn. Poll its structured log through the configured turn
    // deadline, accepting only `phase: final_answer` (the reader enforces
    // that), rather than forwarding a commentary/progress message.
    const attempts = agentInfo?.agent === "codex"
      ? Math.max(1, Math.ceil((opts.maxWaitS * 1000) / 500))
      : 1;
    let response: AgentResponse | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      response = opts.deps?.readJsonl && path
        ? deps.readJsonl(path, sendStartedAt, opts.prompt)
        : strategy.reader(sendStartedAt, opts.prompt);
      if (response?.text) break;
      if (attempt < attempts - 1) await deps.sleep(500);
    }
    if (response?.text) {
      const source: OutputSource = agentInfo?.agent === "omp" && response.source === "pi-jsonl"
        ? "omp-jsonl"
        : response.source as OutputSource;
      return {
        text: response.text,
        source,
      };
    }
    // Codex panes can contain another live Codex conversation. Scraping that
    // terminal after a missed JSONL correlation leaks unrelated tool output.
    // Fail closed instead of treating arbitrary screen text as a reply.
    if (agentInfo?.agent === "codex") {
      return {
        text: "",
        source: "unavailable",
        fallbackReason: "Codex JSONL did not contain a response correlated to this prompt",
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
