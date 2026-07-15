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
  agentName: string
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
