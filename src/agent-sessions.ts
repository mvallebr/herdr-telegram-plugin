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
 *
 * Output strategy is selected ONCE at construction via
 * `createAgentCommunicator`. Every known structured agent validates its
 * source up-front; if validation fails we warn once and fall back to a
 * scrape reader. Once selected, the reader is permanent — runtime read
 * failures return empty output (not a fallback to readPane).
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createLogger, type Logger } from "./logger.js";
import { stripStatusBar } from "./output-format.js";

// Use createRequire so we can `require("node:sqlite")` from this ESM
// module without bundler or async-loading ceremony. node:sqlite is built
// into Node 22.5+; on older runtimes we'll fall back to a meaningful
// validation error.
const require_ = createRequire(import.meta.url);

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

interface NodeSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

function tryLoadNodeSqlite(): NodeSqliteModule | null {
  try {
    const mod = require_("node:sqlite") as NodeSqliteModule;
    if (!mod?.DatabaseSync) return null;
    return mod;
  } catch {
    return null;
  }
}

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
      const dbPath = getAgentDataPath("opencode", "db", agentPaths);
      const driver: SqliteDriver = defaultSqliteDriver;
      const reason = validateOpenCodeDb(dbPath, ref.id, driver);
      if (!reason) {
        return {
          strategy: "jsonl",
          reader: (_sinceMs: number, _prompt?: string): AgentResponse | null => {
            const text = readOpenCodeCumulative(dbPath!, ref.id, driver);
            return text
              ? { text, timestamp: new Date().toISOString(), source: "opencode-db" }
              : null;
          },
        };
      }
      return { strategy: "scrape", reason: `opencode db not available: ${reason}` };
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

// --- AgentOutputReader interface --------------------------------------------

/**
 * Single, source-agnostic reader selected ONCE at AgentCommunicator
 * construction. Implementations:
 *  - `ScrapeReader(paneId, readPane)` — terminal screen scrape via herdr.
 *  - `JsonlReader(ref, agentName)` — pi / omp / codex session file.
 *  - `OpenCodeDbReader(sessionId, dbPath, runner)` — SQLite via the
 *    `sqlite3` CLI, parsed via -json mode output.
 *
 * Once selected, runtime read errors return "" (NOT a fallback).
 */
export interface AgentOutputReader {
  /** Short identifier for logs ("scrape", "jsonl", "opencode-db"). */
  readonly kind: string;
  /**
   * Return the latest output for this pane. Empty string when nothing is
   * available. Implementations MUST NOT throw; runtime read errors MUST
   * be swallowed and surfaced via the communicator's logger.
   */
  read(_maxLines: number): string;
}

/** Screen-scrape reader — wraps the injected readPane callback. */
class ScrapeReader implements AgentOutputReader {
  readonly kind = "scrape";
  constructor(
    private readonly paneId: string,
    private readonly readPane: (paneId: string, lines: number) => string,
  ) {}
  read(maxLines: number): string {
    try {
      // stripStatusBar lives here at the scrape boundary rather than in
      // observe-loop's readSnapshot to avoid corrupting structured reader
      // output that happens to match terminal-status patterns (e.g.
      // "Model: …").
      return stripStatusBar(this.readPane(this.paneId, maxLines));
    } catch {
      return "";
    }
  }
}

/** Jsonl reader for pi / omp / codex sessions. */
class JsonlReader implements AgentOutputReader {
  readonly kind = "jsonl";
  constructor(
    private readonly ref: Extract<AgentSessionRef, { kind: "path" }>,
    private readonly agentName: string,
    private readonly logger: Logger,
    private readonly paneId: string,
  ) {}
  read(_maxLines: number): string {
    try {
      const response = readAgentSessionResponse(this.ref, this.agentName, 0);
      return response?.text ?? "";
    } catch (err) {
      this.logger.warn("jsonl structured read failed", {
        paneId: this.paneId,
        agent: this.agentName,
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }
}

// --- OpenCode SQLite reader ------------------------------------------------

/**
 * Minimal interface around the SQLite driver so tests can stub the
 * open/close/query lifecycle. Production uses `node:sqlite` (Node 22.5+).
 *
 * Why not the `sqlite3` CLI? Two reasons:
 *   - It required shell interpolation of the db path / session id
 *     (which is what we are explicitly trying to avoid).
 *   - Its positional-parameter binding doesn't match the documented
 *     `?` placeholder behaviour we want — we'd have to escape values
 *     ourselves. Using a real driver with prepared statements is
 *     strictly safer.
 */
export interface SqliteDriver {
  open(path: string): SqliteHandle;
}

export interface SqliteHandle {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): void;
}

/**
 * Default driver backed by `node:sqlite`. Built lazily — opening the
 * module requires Node 22.5+, so we probe at first use and surface a
 * meaningful validation reason if it isn't available.
 */
export const defaultSqliteDriver: SqliteDriver = (() => {
  return {
    open(path: string): SqliteHandle {
      const mod = tryLoadNodeSqlite();
      if (!mod) {
        throw new Error("node:sqlite module not available (need Node >=22.5)");
      }
      const db = new mod.DatabaseSync(path);
      return {
        prepare(sql: string): SqliteStatement {
          const stmt = db.prepare(sql);
          return {
            get(...params: unknown[]) {
              const r = stmt.get.apply(stmt, params);
              return (r as Record<string, unknown> | undefined) ?? undefined;
            },
            all(...params: unknown[]) {
              return stmt.all.apply(stmt, params) as Array<Record<string, unknown>>;
            },
            run(...params: unknown[]) {
              stmt.run.apply(stmt, params);
            },
          };
        },
        close() { db.close(); },
      };
    },
  };
})();

/**
 * Probe the OpenCode SQLite DB. Returns `null` on success, or a
 * human-readable reason on failure. Never shell-interpolates; prepared
 * statements bind the session id safely.
 */
export function validateOpenCodeDb(
  dbPath: string | null,
  sessionId: string,
  driver: SqliteDriver = defaultSqliteDriver,
): string | null {
  if (!dbPath) return "no opencode.db path configured";
  if (!existsSync(dbPath)) return `opencode.db not found at ${dbPath}`;
  let handle: SqliteHandle;
  try {
    handle = driver.open(dbPath);
  } catch (err) {
    return `failed to open opencode.db: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    const tables = handle.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message', 'part')",
    ).all();
    const names = new Set(tables.map((r) => String(r.name)));
    if (!names.has("message") || !names.has("part")) {
      return "opencode.db is missing the message/part tables";
    }
    const probe = handle.prepare(
      "SELECT id FROM message WHERE session_id = ? LIMIT 1",
    ).get(sessionId);
    if (!probe) {
      return `session ${sessionId} not present in opencode.db`;
    }
    return null; // OK
  } catch (err) {
    return `opencode.db probe failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    try { handle.close(); } catch { /* ignore */ }
  }
}

/**
 * Read the most recent assistant message text from the DB. Returns ""
 * on any failure; never throws (errors surface via the reader wrapper).
 *
 * Strategy: pick the most recent assistant message id for the session,
 * then read its text parts in time-ASC order. Concatenate to a single
 * newline-joined string.
 *
 * Uses parameterized queries — NEVER string-interpolates user input.
 * Returns only most-recent assistant text — user prompts are skipped.
 */
export function readOpenCodeDb(
  dbPath: string,
  sessionId: string,
  driver: SqliteDriver = defaultSqliteDriver,
): string {
  const handle = driver.open(dbPath);
  try {
    // Real OpenCode schema: message.data JSON holds the role
    // (e.g. {"role":"assistant"}), while part.data holds type/text
    // (e.g. {"type":"text","text":"..."}) with NO role field.
    //
    // Strategy: pick the latest assistant message that has at least
    // one text part (OpenCode may write step-start / reasoning /
    // tool-only messages AFTER the textual answer).  Then collect
    // all text parts from that message in time order.
    const rows = handle.prepare(
      [
        "SELECT p.data AS data, p.time_created AS ts",
        "FROM message m JOIN part p ON p.message_id = m.id",
        "WHERE m.session_id = ?",
        "  AND json_extract(m.data, '$.role') = 'assistant'",
        "  AND json_extract(p.data, '$.type') = 'text'",
        "  AND m.id = (",
        "    SELECT m2.id FROM message m2",
        "    WHERE m2.session_id = ?",
        "      AND json_extract(m2.data, '$.role') = 'assistant'",
        "      AND EXISTS (",
        "        SELECT 1 FROM part p2",
        "        WHERE p2.message_id = m2.id",
        "          AND json_extract(p2.data, '$.type') = 'text'",
        "      )",
        "    ORDER BY m2.time_created DESC, m2.id DESC",
        "    LIMIT 1",
        "  )",
        "ORDER BY p.time_created ASC",
      ].join(" "),
    ).all(sessionId, sessionId);

    const parts: string[] = [];
    for (const row of rows) {
      const raw = (row as any).data;
      let data: any;
      try { data = JSON.parse(typeof raw === "string" ? raw : "null"); }
      catch { data = null; }
      const text = typeof data?.text === "string" ? data.text : "";
      if (text) parts.push(text);
    }
    return parts.join("\n").trim();
  } finally {
    try { handle.close(); } catch { /* ignore */ }
  }
}

/**
 * Read a *cumulative* OpenCode snapshot: the latest N assistant messages,
 * their parts concatenated in chronological order.  Default window is 50
 * messages — recent enough to capture the live turn, bounded enough that
 * SQLite doesn't scale with session length.
 *
 * Real OpenCode part payload shapes (inspected from a live DB):
 *   - {type:"text",     text:"<visible answer>"}
 *   - {type:"reasoning",text:"<chain-of-thought, may be empty when encrypted>"}
 *   - {type:"tool",     tool:"read"|"bash"|..., state:{input:..., output:...}}
 *   - {type:"patch",    hash:"...", files:[...]}
 *   - {type:"step-start"|"step-finish"|"compaction"|"file", ...}
 *
 * Defaults emit ONLY type="text" parts — the user-visible answer.
 * Opt-in flags under [agents.opencode] turn on tool/thought summaries:
 *   include_tools    → "🔧 <tool> <compact input preview>"
 *   include_thoughts → "💭 <reasoning>" (or "💭 (reasoning step)" when
 *                     encrypted with empty text)
 * Tool summaries deliberately omit the large `state.output` body and
 * truncate long inputs.
 *
 * SQL strategy:
 *   1. Resolve the latest N assistant message ids ordered by time_created DESC.
 *   2. Read all parts whose `message_id` is in that set, ordered by time ASC.
 *   3. Walk rows in order, projecting each part to a line (or skipping it)
 *      based on the type and the include options.
 *
 * Both the session id and the window bound are bound parameters — the
 * function never interpolates them into SQL.
 */
export interface OpenCodeReadOptions {
  /** Include tool parts as compact one-line summaries prefixed `🔧`. */
  includeTools?: boolean;
  /** Include reasoning/thinking parts as compact summaries prefixed `💭`. */
  includeThoughts?: boolean;
  /** Max assistant messages to read, latest first. Default 50. */
  messageWindow?: number;
}

const DEFAULT_MESSAGE_WINDOW = 50;

/** Compact summary of a tool part — never dumps the output body. */
function summarizeTool(data: any): string | null {
  const toolName =
    typeof data?.tool === "string" ? data.tool :
    typeof data?.name === "string" ? data.name :
    typeof data?.toolName === "string" ? data.toolName :
    "";
  if (!toolName) return null;
  const input = data?.state?.input ?? data?.input ?? {};
  // Per-tool compact preview: only the args the user would care to see.
  let preview = "";
  if (typeof input?.filePath === "string") {
    preview = input.filePath;
    if (typeof input?.offset === "number") {
      preview += `:${input.offset}`;
      if (typeof input?.limit === "number") preview += `+${input.limit}`;
    }
  } else if (typeof input?.command === "string") {
    preview = input.command.length > 80
      ? input.command.slice(0, 77) + "..."
      : input.command;
  } else if (typeof input?.patchText === "string") {
    const m = input.patchText.match(/^\*\*\*\s+(?:Begin Patch|Update File|Delete File|Add File):\s*(.*)$/m);
    preview = m ? m[1] : `patch (${input.patchText.length}b)`;
  } else if (typeof input?.file === "string") {
    preview = input.file;
  } else if (typeof input?.url === "string") {
    preview = input.url;
  }
  return preview ? `${toolName} ${preview}` : toolName;
}

/** Compact summary of a reasoning/thinking part. */
function summarizeReasoning(data: any): string {
  const text = typeof data?.text === "string" ? data.text : "";
  return text || "(reasoning step)";
}

export function readOpenCodeCumulative(
  dbPath: string,
  sessionId: string,
  driver: SqliteDriver = defaultSqliteDriver,
  options: OpenCodeReadOptions = {},
): string {
  const includeTools = options.includeTools ?? false;
  const includeThoughts = options.includeThoughts ?? false;
  // Clamp invalid / non-positive / non-finite window values to the default.
  // SQLite LIMIT -1 is unlimited and LIMIT 0 returns no rows — both would
  // produce surprising output, so we guard against them here.
  const raw = options.messageWindow;
  const windowSize = (raw != null && Number.isFinite(raw) && raw > 0)
    ? Math.floor(raw)
    : DEFAULT_MESSAGE_WINDOW;

  const handle = driver.open(dbPath);
  try {
    // 1. Find the latest N assistant message ids for this session.
    //    Bound ?1 = sessionId, ?2 = window size. Order by time DESC + id DESC
    //    so concurrent inserts at the same tick resolve deterministically.
    const messageRows = handle.prepare(
      [
        "SELECT id FROM message",
        "WHERE session_id = ?",
        "  AND json_extract(data, '$.role') = 'assistant'",
        "ORDER BY time_created DESC, id DESC",
        "LIMIT ?",
      ].join(" "),
    ).all(sessionId, windowSize);

    const ids: string[] = [];
    for (const row of messageRows) {
      const id = (row as any).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
    if (ids.length === 0) return "";

    // 2. Pull every part whose message_id is in the set, in time order.
    //    Only `?` placeholders — drivers (node:sqlite, sqlite3 CLI) do NOT
    //    support `?N` positional binding, and over-specifying would trip up
    //    any test driver. The IDs are bound — never concatenated into SQL.
    const placeholders = ids.map(() => "?").join(",");
    const partRows = handle.prepare(
      `SELECT data FROM part WHERE message_id IN (${placeholders}) ORDER BY time_created ASC, id ASC`,
    ).all(...ids);

    // 3. Walk rows in order; emit a line per included part.
    const lines: string[] = [];
    for (const row of partRows) {
      const raw = (row as any).data;
      let data: any;
      try { data = JSON.parse(typeof raw === "string" ? raw : "null"); }
      catch { data = null; }
      const type = typeof data?.type === "string" ? data.type : "";
      if (type === "text") {
        const text = typeof data?.text === "string" ? data.text : "";
        if (text) lines.push(text);
        continue;
      }
      if (includeThoughts && (type === "reasoning" || type === "thinking")) {
        lines.push("💭 " + summarizeReasoning(data));
        continue;
      }
      if (includeTools && (type === "tool" || type === "tool_use" || type === "tool_call")) {
        const summary = summarizeTool(data);
        if (summary) lines.push("🔧 " + summary);
        continue;
      }
      // All other part types (step-start, step-finish, patch, file,
      // compaction, …) are skipped — they aren't user-facing prose.
    }

    return lines.join("\n").trim();
  } finally {
    try { handle.close(); } catch { /* ignore */ }
  }
}

class OpenCodeDbReader implements AgentOutputReader {
  readonly kind = "opencode-db";
  constructor(
    private readonly dbPath: string,
    private readonly sessionId: string,
    private readonly driver: SqliteDriver,
    private readonly logger: Logger,
    private readonly paneId: string,
    private readonly readOptions: OpenCodeReadOptions = {},
  ) {}
  read(_maxLines: number): string {
    try {
      // Use the cumulative reader so the caller sees a stable, replayable
      // snapshot of the latest N assistant messages. Default behavior
      // (text-only, 50-message window) matches what users want from /last.
      return readOpenCodeCumulative(
        this.dbPath, this.sessionId, this.driver, this.readOptions,
      );
    } catch (err) {
      this.logger.warn("opencode structured read failed", {
        paneId: this.paneId,
        sessionId: this.sessionId,
        dbPath: this.dbPath,
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }
}

// --- Public factory --------------------------------------------------------

/** Subset of herdr-client AgentInfo that factory needs. */
export interface AgentCommunicatorDeps {
  paneId: string;
  getAgentInfo: (target: string) => { agent?: string; agent_session?: AgentSessionRef } | null;
  readPane: (paneId: string, lines: number) => string;
  agentPaths?: Record<string, Record<string, string>>;
  logger?: Logger;
  /**
   * Optional test seam — replace the SQLite driver. Production uses the
   * built-in `node:sqlite` module via defaultSqliteDriver.
   */
  sqliteDriver?: SqliteDriver;
  /**
   * Per-agent reader options (e.g. include_tools / include_thoughts for
   * OpenCode). Wired in from cfg at the daemon/wait-loop entry points.
   */
  opencodeReadOptions?: OpenCodeReadOptions;
}

const fallbackLog: Logger = createLogger("agent-sessions");

/**
 * Selection-once factory. Caller-facing behaviour:
 *   - If validation of the structured source fails, log a single warning
 *     (pane, agent, reason) and fall back to a scrape reader.
 *   - If validation succeeds, pick the structured reader permanently.
 *
 * Production code MUST go through this factory instead of `new AgentCommunicator`.
 * The class itself remains exported for tests + seam-based construction.
 */
export function createAgentCommunicator(depsIn: AgentCommunicatorDeps): AgentCommunicator {
  const deps: AgentCommunicatorDeps = { ...depsIn };
  const log: Logger = deps.logger ?? fallbackLog;

  const info = safeGetAgentInfo(deps);
  const session = info?.agent_session;
  const agent = info?.agent ?? "?";

  // Helper to build a scrape communicator with a one-shot warn logged.
  const scrapeWithWarn = (reason: string): AgentCommunicator => {
    log.warn("structured source unavailable; falling back to scrape", {
      paneId: deps.paneId,
      agent,
      reason,
    });
    return new AgentCommunicator(
      new ScrapeReader(deps.paneId, deps.readPane),
      log,
    );
  };

  // No structured session at all → scrape (no warn — that's the default path)
  if (!session) {
    return new AgentCommunicator(
      new ScrapeReader(deps.paneId, deps.readPane),
      log,
    );
  }

  // Path-based sessions: validate the file exists and is a regular file.
  // Empty files are accepted — the reader will simply return "" until the
  // agent writes content. The contract is: selection is permanent once made;
  // runtime empty is not a fallback trigger.
  if (session.kind === "path") {
    if (!existsSync(session.path)) {
      return scrapeWithWarn(`session path does not exist: ${session.path}`);
    }
    try {
      const st = statSync(session.path);
      if (!st.isFile()) {
        return scrapeWithWarn(`session path is not a regular file: ${session.path}`);
      }
    } catch (err) {
      return scrapeWithWarn(`cannot stat session path: ${err instanceof Error ? err.message : String(err)}`);
    }
    return new AgentCommunicator(
      new JsonlReader(session, agent, log, deps.paneId),
      log,
    );
  }

  // Id-based sessions: dispatch by agent name.
  if (session.kind === "id") {
    if (agent === "opencode") {
      const dbPath = getAgentDataPath("opencode", "db", deps.agentPaths);
      const driver: SqliteDriver = deps.sqliteDriver ?? defaultSqliteDriver;
      const reason = validateOpenCodeDb(dbPath, session.id, driver);
      if (reason) return scrapeWithWarn(reason);
      // Validation passed — pick the structured reader permanently.
      return new AgentCommunicator(
        new OpenCodeDbReader(
          dbPath!, session.id, driver, log, deps.paneId,
          deps.opencodeReadOptions,
        ),
        log,
      );
    }
    if (agent === "codex") {
      const path = findCodexSessionPath(session.id);
      if (!path) return scrapeWithWarn(`codex session not on disk: ${session.id}`);
      return new AgentCommunicator(
        new JsonlReader({ kind: "path", path }, agent, log, deps.paneId),
        log,
      );
    }
    return scrapeWithWarn(`agent_session is an id, not a path (agent=${agent})`);
  }

  // Defensive — exhaustive union
  return new AgentCommunicator(
    new ScrapeReader(deps.paneId, deps.readPane),
    log,
  );
}

function safeGetAgentInfo(deps: AgentCommunicatorDeps): { agent?: string; agent_session?: AgentSessionRef } | null {
  try {
    return deps.getAgentInfo(deps.paneId);
  } catch {
    return null;
  }
}

// --- AgentCommunicator class -----------------------------------------------

/**
 * Encapsulates communication with a single agent pane.
 *
 * Use `createAgentCommunicator(deps)` to build one. Direct construction
 * is allowed for tests that want to inject a custom reader.
 */
export class AgentCommunicator {
  /** Short identifier of the active reader ("scrape" | "jsonl" | "opencode-db"). */
  readonly readerKind: string;

  constructor(
    reader: AgentOutputReader,
    private readonly logger: Logger = fallbackLog,
  ) {
    this.readerKind = reader.kind;
    this.reader = reader;
  }

  private readonly reader: AgentOutputReader;

  /**
   * Read the current output from the agent.
   *
   * Returns the structured reader's text when one was selected, otherwise
   * the screen-scrape. Runtime read errors return "" (and surface via the
   * injected logger) — they MUST NOT trigger a fallback to readPane.
   */
  getAgentOutput(maxLines: number): string {
    try {
      const text = this.reader.read(maxLines);
      return text ?? "";
    } catch (err) {
      this.logger.error("agent output reader threw unexpectedly", {
        readerKind: this.readerKind,
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }
}

/** Back-compat alias used by old test code. */
export const buildAgentCommunicator = createAgentCommunicator;

// Re-export createLogger so callers can build a Logger without importing logger.ts.
export { createLogger } from "./logger.js";
