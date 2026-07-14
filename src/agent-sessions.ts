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
import { readFileSync, existsSync, statSync } from "node:fs";

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
      if (c?.type === "text" && typeof c.text === "string") return c.text;
      // Skip thinking blocks — they aren't part of the response the user sees.
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n\n");
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
  sinceMs: number
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
    if (!msg || msg.role !== "assistant") continue;
    const ts = ev.timestamp;
    const tsMs = typeof ts === "string" ? Date.parse(ts) : 0;
    if (sinceMs > 0 && tsMs > 0 && tsMs < sinceMs) continue;
    const text = extractTextFromContent(msg.content);
    if (!text) continue;
    last = { text, timestamp: ts, source: "pi-jsonl" };
  }
  return last;
}

/**
 * Generic fallback that tries `readPiSessionResponse` — works for pi, omp
 * (both use the same session format per `herdr integration status` docs).
 * Other agents with future structured logs can plug in here.
 */
export function readAgentSessionResponse(
  ref: AgentSessionRef,
  agentName: string,
  sinceMs: number
): AgentResponse | null {
  if (!ref) return null;
  if (ref.kind === "path") {
    // Future: dispatch on agentName for different formats.
    switch (agentName) {
      case "pi":
      case "omp":
        return readPiSessionResponse(ref.path, sinceMs);
      default:
        // Try pi format anyway — most agents that emit session files use
        // a similar shape (role, content).  Caller may still fall back to
        // screen scraping if the result is empty/garbage.
        return readPiSessionResponse(ref.path, sinceMs);
    }
  }
  // kind === "id" — we don't have a path yet; caller falls back to scrape.
  return null;
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
): { strategy: "jsonl"; reader: (sinceMs: number) => AgentResponse | null } | {
  strategy: "scrape";
  reason: string;
} {
  if (!ref) {
    return { strategy: "scrape", reason: "no agent_session reported by herdr" };
  }
  if (ref.kind !== "path") {
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
    reader: (sinceMs: number) => readAgentSessionResponse(ref, agentName, sinceMs),
  };
}