/**
 * Per-agent output extraction strategies.
 *
 * Herdr exposes agent metadata via `herdr agent get <target>` — most useful
 * is `agent_session.path` (and `agent_session_id`) reported by agent
 * integrations.  When that path points at a jsonl session log (pi, omp, …),
 * we can read the response directly instead of screen-scraping the pane.
 *
 * For agents without a structured session log, fall back to screen scraping
 * via herdr pane read (handled by the caller).
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Agent data paths ------------------------------------------------------

/**
 * Default per-agent data store paths. Each key is an agent name (e.g.
 * "opencode", "codex"); each value is a map from data kind to the default
 * path on disk, computed from $HOME. Callers can override these via the
 * config.toml [agents.<name>] section.
 */
export function defaultAgentPaths(): Record<string, Record<string, string>> {
  const home = process.env.HOME ?? homedir();
  return {
    opencode: {
      db: join(home, ".local/share/opencode/opencode.db"),
    },
    codex: {
      // Codex sessions live under ~/.codex/sessions — path is resolved
      // dynamically by findCodexSessionPath, so no static default needed.
    },
    pi: {
      // Pi sessions are referenced directly via agent_session.path.
    },
    omp: {
      // Omp sessions are referenced directly via agent_session.path.
    },
  };
}

/**
 * Resolve the path for an agent's data store. Looks up the agent's
 * configured override in `agentPaths`, falling back to the default path
 * computed from $HOME.
 *
 * Returns null when no path is known for the agent/key pair.
 */
export function getAgentDataPath(
  agentName: string,
  key: string,
  agentPaths?: Record<string, Record<string, string>>,
): string | null {
  // Check user override first
  if (agentPaths?.[agentName]?.[key]) {
    return agentPaths[agentName][key];
  }
  // Fall back to default
  const defaults = defaultAgentPaths();
  return defaults[agentName]?.[key] ?? null;
}

export type AgentSessionRef =
  | { kind: "path"; path: string }
  | { kind: "id"; id: string }
  | undefined;

/** A single piece of content extracted from a session log. */
export interface AgentResponse {
  /** Plain text of the assistant's last response. */
  text: string;
  /** ISO timestamp of when that response was produced. */
  timestamp: string;
  /** Source strategy used (e.g. "pi-jsonl", "omp-jsonl", "screen-scrape"). */
  source: string;
}

/** Best-effort text join of a pi/omp message content array. */
function extractTextFromContent(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if ((c?.type === "text" || c?.type === "output_text" || c?.type === "input_text") && typeof c.text === "string") return c.text;
      // Skip thinking blocks — they aren't part of the response the user sees.
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n\n");
}

function matchesPrompt(text: string, prompt?: string): boolean {
  if (!prompt) return true;
  return text.replace(/\s+/g, " ").trim() === prompt.replace(/\s+/g, " ").trim();
}

/**
 * Read the last assistant response from a pi session jsonl, after `sinceMs`.
 *
 * Format (each line is JSON):
 *   {"type":"message", "timestamp":"<iso>", "message":{"role":"assistant"|"user",
 *     "content":[{"type":"text"|"thinking", "text":...}]}}
 */
export function readPiSessionResponse(
  jsonlPath: string,
  sinceMs: number,
  prompt?: string
): AgentResponse | null {
  if (!existsSync(jsonlPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  let last: AgentResponse | null = null;
  let matchedPrompt = !prompt;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type !== "message") continue;
    const msg = ev.message;
    if (!msg) continue;
    const ts = ev.timestamp;
    const tsMs = typeof ts === "string" ? Date.parse(ts) : 0;
    if (sinceMs > 0 && tsMs > 0 && tsMs < sinceMs) continue;
    if (msg.role === "user") {
      matchedPrompt = matchesPrompt(extractTextFromContent(msg.content), prompt);
      continue;
    }
    if (msg.role !== "assistant" || !matchedPrompt) continue;
    const text = extractTextFromContent(msg.content);
    if (!text) continue;
    last = { text, timestamp: ts, source: "pi-jsonl" };
    if (prompt) return last;
  }
  return last;
}

/**
 * Read Codex's final `response_item.payload.message` from its rollout jsonl.
 *
 * Codex writes user-visible commentary as assistant messages too.  Those are
 * intermediate progress notes, not the completed answer for a turn, so they
 * must never be forwarded by the Telegram bridge.
 */
export function readCodexSessionResponse(jsonlPath: string, sinceMs: number, prompt?: string): AgentResponse | null {
  if (!existsSync(jsonlPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
  let last: AgentResponse | null = null;
  let matchedPrompt = !prompt;
  for (const line of raw.split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev?.type !== "response_item" || ev?.payload?.type !== "message") continue;
      const ts = ev.timestamp;
      const tsMs = typeof ts === "string" ? Date.parse(ts) : 0;
      if (sinceMs > 0 && tsMs > 0 && tsMs < sinceMs) continue;
      if (ev.payload.role === "user") {
        matchedPrompt = matchesPrompt(extractTextFromContent(ev.payload.content), prompt);
        continue;
      }
      if (ev.payload.role !== "assistant" || ev.payload.phase !== "final_answer" || !matchedPrompt) continue;
      const text = extractTextFromContent(ev.payload.content);
      if (text) last = { text, timestamp: ts, source: "codex-jsonl" };
      if (last && prompt) return last;
    } catch {
      // A session can be mid-write; ignore malformed/incomplete records.
    }
  }
  return last;
}

/**
 * Read Codex commentary for the current prompt. Commentary is deliberately
 * separate from `readCodexSessionResponse`: it is safe only as a labelled
 * progress preview, never as a terminal answer.
 */
export function readCodexSessionProgress(jsonlPath: string, sinceMs: number, prompt?: string): AgentResponse | null {
  if (!existsSync(jsonlPath)) return null;
  let raw: string;
  try { raw = readFileSync(jsonlPath, "utf8"); } catch { return null; }
  let last: AgentResponse | null = null;
  let matchedPrompt = !prompt;
  for (const line of raw.split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev?.type !== "response_item" || ev?.payload?.type !== "message") continue;
      const tsMs = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : 0;
      if (sinceMs > 0 && tsMs > 0 && tsMs < sinceMs) continue;
      if (ev.payload.role === "user") {
        matchedPrompt = matchesPrompt(extractTextFromContent(ev.payload.content), prompt);
        continue;
      }
      if (ev.payload.role !== "assistant" || !matchedPrompt || ev.payload.phase === "final_answer") continue;
      const text = extractTextFromContent(ev.payload.content);
      if (text) last = { text, timestamp: ev.timestamp, source: "codex-jsonl" };
    } catch {
      // A session can be mid-write; retry next poll.
    }
  }
  return last;
}

const codexSessionCache = new Map<string, string>();

/** Resolve Herdr's Codex session id to its local rollout file. */
export function findCodexSessionPath(sessionId: string): string | null {
  const cached = codexSessionCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const root = join(homedir(), ".codex", "sessions");
  const visit = (dir: string): string | null => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = visit(path);
          if (found) return found;
        } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
          return path;
        }
      }
    } catch {
      return null;
    }
    return null;
  };
  const found = visit(root);
  if (found) codexSessionCache.set(sessionId, found);
  return found;
}

/**
 * Generic fallback that tries `readPiSessionResponse` — works for pi, omp
 * (both use the same session format per `herdr integration status` docs).
 * Other agents with future structured logs can plug in here.
 */
export function readAgentSessionResponse(
  ref: AgentSessionRef,
  agentName: string,
  sinceMs: number,
  prompt?: string
): AgentResponse | null {
  if (!ref) return null;
  if (ref.kind === "path") {
    // Future: dispatch on agentName for different formats.
    switch (agentName) {
      case "pi":
      case "omp":
        return readPiSessionResponse(ref.path, sinceMs, prompt);
      case "codex":
        return readCodexSessionResponse(ref.path, sinceMs, prompt);
      default:
        // Try pi format anyway — most agents that emit session files use
        // a similar shape (role, content).  Caller may still fall back to
        // screen scraping if the result is empty/garbage.
        return readPiSessionResponse(ref.path, sinceMs, prompt) ?? readCodexSessionResponse(ref.path, sinceMs, prompt);
    }
  }
  if (ref.kind === "id" && agentName === "codex") {
    const path = findCodexSessionPath(ref.id);
    return path ? readCodexSessionResponse(path, sinceMs, prompt) : null;
  }
  return null;
}

/** Read an optional, non-final progress preview from a structured session. */
export function readAgentSessionProgress(
  ref: AgentSessionRef,
  agentName: string,
  sinceMs: number,
  prompt?: string
): AgentResponse | null {
  if (agentName !== "codex" || !ref) return null;
  if (ref.kind === "path") return readCodexSessionProgress(ref.path, sinceMs, prompt);
  const path = findCodexSessionPath(ref.id);
  return path ? readCodexSessionProgress(path, sinceMs, prompt) : null;
}

/**
 * Decide whether to use the jsonl-based reader or fall back to screen scrape.
 *
 * Returns:
 *  - { strategy: "jsonl", reader } if a usable session ref exists
 *  - { strategy: "scrape", reason } otherwise
 */
export function pickOutputStrategy(
  ref: AgentSessionRef,
  agentName: string,
  agentPaths?: Record<string, Record<string, string>>,
): { strategy: "jsonl"; reader: (sinceMs: number, prompt?: string) => AgentResponse | null } | {
  strategy: "scrape";
  reason: string;
} {
  if (!ref) {
    return { strategy: "scrape", reason: "no agent_session reported by herdr" };
  }
  if (ref.kind !== "path") {
    if (ref.kind === "id" && agentName === "codex") {
      const path = findCodexSessionPath(ref.id);
      if (path) {
        return { strategy: "jsonl", reader: (sinceMs, prompt) => readCodexSessionResponse(path, sinceMs, prompt) };
      }
    }
    if (ref.kind === "id" && agentName === "opencode") {
      return { strategy: "jsonl", reader: (sinceMs, prompt) => readOpenCodeSessionResponse(ref.id, sinceMs, prompt, agentPaths) };
    }
    return { strategy: "scrape", reason: "agent_session is an id, not a path" };
  }
  if (!existsSync(ref.path)) {
    return {
      strategy: "scrape",
      reason: `session path does not exist: ${ref.path}`,
    };
  }
  // Optional sanity check: file must be readable and non-empty
  try {
    const stat = statSync(ref.path);
    if (!stat.isFile() || stat.size === 0) {
      return {
        strategy: "scrape",
        reason: `session path is empty or not a file: ${ref.path}`,
      };
    }
  } catch {
    return { strategy: "scrape", reason: `cannot stat session path: ${ref.path}` };
  }
  return {
    strategy: "jsonl",
    reader: (sinceMs: number, prompt?: string) => readAgentSessionResponse(ref, agentName, sinceMs, prompt),
  };
}

/**
 * Read the latest response from an OpenCode session using `opencode export`.
 *
 * OpenCode doesn't expose a jsonl file on disk, but it does provide
 * `opencode export <sessionID>` which returns structured session data
 * including all messages with their parts. We extract the most recent
 * assistant text from the exported data.
 */
export function readOpenCodeSessionResponse(
  sessionId: string,
  sinceMs: number,
  prompt?: string,
  agentPaths?: Record<string, Record<string, string>>,
): AgentResponse | null {
  try {
    // Read directly from the OpenCode SQLite database instead of
    // running `opencode export` (which is slow and produces multi-MB output).
    const dbPath = getAgentDataPath("opencode", "db", agentPaths);
    if (!dbPath || !existsSync(dbPath)) return null;

    // Use sqlite3 CLI to query the database synchronously
    // Strategy: get the last 20 messages, then expand their parts. Sessions
    // can have thousands of parts (tool calls, reasoning, etc.) — looking at
    // the most recent N messages keeps the query bounded while ensuring we
    // see the latest assistant response.
    const { execSync } = require("node:child_process");
    const query = `
      SELECT m.id, m.time_created, p.data
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE m.id IN (
        SELECT id FROM message
        WHERE session_id = '${sessionId}'
        ORDER BY time_created DESC
        LIMIT 20
      )
      ORDER BY m.time_created DESC, p.time_created ASC
    `;
    const output = execSync(
      `sqlite3 ${dbPath} "${query.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { encoding: "utf8", timeout: 5000 }
    );

    // Parse the output — sqlite3 CLI returns one row per line by default
    const lines = output.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    // Find the most recent message with text content
    let currentMessageId: string | null = null;
    let currentTimestamp: number | null = null;
    let textParts: string[] = [];

    for (const line of lines) {
      // sqlite3 output format: id|timestamp|data
      const parts = line.split("|");
      if (parts.length < 3) continue;

      const [msgId, timestamp, dataJson] = parts;
      if (msgId !== currentMessageId) {
        // New message — check if previous had text
        if (textParts.length > 0 && currentTimestamp) {
          const text = textParts.join("\n").trim();
          if (text) {
            return {
              text,
              timestamp: new Date(currentTimestamp).toISOString(),
              source: "opencode",
            };
          }
        }
        currentMessageId = msgId;
        currentTimestamp = parseInt(timestamp, 10);
        textParts = [];
      }

      try {
        const data = JSON.parse(dataJson);
        if (data.type === "text" && data.text) {
          textParts.push(data.text);
        }
      } catch {}
    }

    // Check the last message
    if (textParts.length > 0 && currentTimestamp) {
      const text = textParts.join("\n").trim();
      if (text) {
        return {
          text,
          timestamp: new Date(currentTimestamp).toISOString(),
          source: "opencode",
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Encapsulates communication with a single agent pane.
 *
 * Decides at construction time whether to use the structured jsonl session
 * log (pi, omp, codex) or fall back to screen scraping. Callers (observe-loop,
 * seedTopics, etc.) depend on this abstraction rather than readPane directly,
 * so the output strategy is chosen in one place.
 */
export class AgentCommunicator {
  private readonly strategy: ReturnType<typeof pickOutputStrategy>;

  constructor(
    private readonly paneId: string,
    private readonly getAgentInfo: (target: string) => { agent?: string; agent_session?: AgentSessionRef } | null,
    private readonly readPane: (paneId: string, lines: number) => string,
    private readonly agentPaths?: Record<string, Record<string, string>>,
  ) {
    const info = getAgentInfo(paneId);
    this.strategy = pickOutputStrategy(
      info?.agent_session,
      info?.agent ?? "?",
      agentPaths,
    );
  }

  /**
   * Read the current output from the agent.
   *
   * When a jsonl session log is available and returns content, that content
   * is used directly. Otherwise, falls back to screen scraping the pane.
   */
  getAgentOutput(maxLines: number): string {
    if (this.strategy.strategy === "jsonl") {
      const response = this.strategy.reader(0);
      if (response?.text) return response.text;
      // jsonl returned no content — fall through to screen scrape.
    }
    return this.readPane(this.paneId, maxLines);
  }
}
