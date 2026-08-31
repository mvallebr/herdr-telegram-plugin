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
import { createAgentOutputReader } from "./readers/registry.js";
import { sendText } from "./herdr-client.js";
import {
  SENT_TAIL_MAX,
  tailOf,
  deriveUnseen,
} from "./output-diff.js";

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

// --- AgentOutputReader interface --------------------------------------------

/**
 * Single, source-agnostic reader selected ONCE at AgentCommunicator
 * construction. Implementations live in `./readers/` and are selected
 * by `./readers/registry.ts` — see `createAgentOutputReader`. The class
 * itself is still exposed here because `AgentCommunicator` depends on it.
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

/** Screen-scrape reader moved to `./readers/registry.ts` so all reader
 *  selection lives in one place. See `createAgentOutputReader`. */

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
        // OpenCode stores both user-visible final answers and the assistant's
        // internal commentary as text parts. Provider metadata is the only
        // reliable distinction in the native session database.
        const phase = data?.metadata?.openai?.phase;
        if (typeof phase === "string" && phase !== "final_answer") continue;
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

export class OpenCodeDbReader implements AgentOutputReader {
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
   * OpenCode). Wired in from cfg at the daemon entry point.
   */
  opencodeReadOptions?: OpenCodeReadOptions;
}

const fallbackLog: Logger = createLogger("agent-sessions");

/**
 * Selection-once factory. Delegates reader selection to
 * `./readers/registry.ts` — all agent-specific logic (pi/omp/codex/opencode
 * validation, scrape fallback, warn reasons) lives there. This function
 * only knows about the communicator class and the request shape.
 *
 * Caller-facing behaviour (unchanged):
 *   - If validation of the structured source fails, the registry logs a
 *     single warning (pane, agent, reason) and falls back to a scrape reader.
 *   - If validation succeeds, the registry picks the structured reader
 *     permanently.
 *   - Runtime empty reads do NOT trigger a fallback.
 *
 * Production code MUST go through this factory instead of `new AgentCommunicator`.
 * The class itself remains exported for tests + seam-based construction.
 */
export function createAgentCommunicator(depsIn: AgentCommunicatorDeps): AgentCommunicator {
  const deps: AgentCommunicatorDeps = { ...depsIn };
  const log: Logger = deps.logger ?? fallbackLog;

  const info = safeGetAgentInfo(deps);
  const reader = createAgentOutputReader({
    paneId: deps.paneId,
    agentName: info?.agent ?? "?",
    session: info?.agent_session,
    readPane: deps.readPane,
    agentPaths: deps.agentPaths,
    opencodeReadOptions: deps.opencodeReadOptions,
    sqliteDriver: deps.sqliteDriver,
    logger: log,
  });
  return new AgentCommunicator(reader, log, deps.paneId);
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
  /**
   * Pane id this communicator is bound to. Required for `sendInput`.
   * Optional in the constructor purely so existing direct-construction
   * test sites (which don't exercise input) keep working unchanged —
   * the factory always supplies a value.
   */
  readonly paneId: string;

  constructor(
    reader: AgentOutputReader,
    private readonly logger: Logger = fallbackLog,
    paneId?: string,
  ) {
    this.readerKind = reader.kind;
    this.reader = reader;
    this.paneId = paneId ?? "";
  }

  private readonly reader: AgentOutputReader;

  /**
   * Diff state. `sentTail` is the trailing SENT_TAIL_MAX chars of the last
   * snapshot we considered "consumed" by the consumer (a follow loop, a
   * /last-aware poll, etc.). `initialized` flips to `true` after the first
   * baseline seed; until then the next `getNewOutput()` call seeds instead
   * of emitting — historical content must never be replayed as "new".
   *
   * Why per-instance: each pane gets its own communicator, so each pane's
   * turn lifecycle owns its own baseline. Sharing across panes would let
   * one pane consume another pane's unread content.
   */
  private sentTail = "";
  private initialized = false;

  /**
   * Read the current output from the agent.
   *
   * Returns the structured reader's text when one was selected, otherwise
   * the screen-scrape. Runtime read errors return "" (and surface via the
   * injected logger) — they MUST NOT trigger a fallback to readPane.
   *
   * This is a PURE read: it does not seed or update the diff state owned
   * by `getNewOutput`. Use it for one-shot reads (e.g. the watcher's
   * seed snapshot) where there's no notion of "what the user has already
   * seen".
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

  /**
   * Stateful diff reader for polling consumers (follow loop, turn
   * controller, etc.).
   *
   *   - First call: seed `sentTail` from the current snapshot and return
   *     "". Historical content is never replayed — the user has been
   *     watching the pane live and would see duplicates.
   *   - Subsequent calls: return the portion of the current snapshot
   *     that has not yet been seen, and update `sentTail` only when the
   *     unseen suffix was non-empty. When nothing is new, the baseline
   *     is left untouched so a stable pane does not drift the anchor.
   *   - Errors are swallowed by `getAgentOutput` (return "") — the
   *     first error after a clean seed will look like "snapshot went
   *     empty", which `deriveUnseen` handles by returning "".
   *
   * Multiple calls after the baseline seed each return only what has
   * appeared since the previous successful call, so a polling consumer
   * that calls this every tick will see each new chunk exactly once.
   */
  getNewOutput(): string {
    const snapshot = this.getAgentOutput(4000);
    if (!this.initialized) {
      this.sentTail = tailOf(snapshot, SENT_TAIL_MAX);
      this.initialized = true;
      return "";
    }
    const unseen = deriveUnseen(snapshot, this.sentTail);
    if (unseen.length > 0) {
      // Re-anchor on the LITERAL current snapshot (not on the unseen
      // suffix) — trailing-newline stripping on scrape snapshots can
      // offset by a single `\n`, and substring anchoring against the
      // snapshot itself always matches on the next poll.
      this.sentTail = tailOf(snapshot, SENT_TAIL_MAX);
    }
    return unseen;
  }

  /**
   * Read-only peek for `/last` and similar. Returns whatever the
   * underlying reader currently reports WITHOUT touching diff state —
   * a subsequent `getNewOutput()` still treats the first unseen
   * content as "new".
   *
   * Implemented as a thin wrapper over `getAgentOutput` so the
   * constraint is structurally guaranteed: there is no path through
   * this method that mutates `sentTail`/`initialized`.
   */
  getLatestOutput(): string {
    return this.getAgentOutput(4000);
  }

  /**
   * Forward `text` to the pane as agent input (via herdr's
   * `pane run` bridge). Equivalent to the user typing in the TUI.
   * Synchronous — herdr returns once the input has been delivered to
   * the pane's stdin.
   *
   * Throws if the communicator was built without a `paneId` (only
   * possible via direct constructor — the factory always supplies one).
   * `PaneAgent` calls this from `handleMessage`.
   */
  sendInput(text: string): void {
    if (!this.paneId) {
      throw new Error(
        "AgentCommunicator.sendInput requires a paneId — use createAgentCommunicator()"
      );
    }
    sendText(this.paneId, text);
  }
}

/** Back-compat alias used by old test code. */
export const buildAgentCommunicator = createAgentCommunicator;

// Re-export createLogger so callers can build a Logger without importing logger.ts.
export { createLogger } from "./logger.js";
