/**
 * Tests for readOpenCodeCumulative — the OpenCode SQLite structured reader
 * that returns a single text snapshot built by concatenating the parts of
 * the latest N assistant messages in chronological order.
 *
 * Uses real sqlite3 to build a temp DB whose schema matches the **real**
 * OpenCode layout:
 *   - message.data  JSON carries {"role": "assistant" | "user"}
 *   - part.data     JSON carries {"type": "text"|"reasoning"|"tool"|"patch"|…, ...}
 *
 * Source-agnostic: tests do not care about reader class internals — they
 * exercise the public `readOpenCodeCumulative` function only.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readOpenCodeCumulative,
  type SqliteDriver,
  type OpenCodeReadOptions,
} from "../src/agent-sessions.js";

const SQLITE = "sqlite3";

interface OpenCodeFixture {
  dbPath: string;
  sessionId: string;
  tmpDir: string;
}

/**
 * Make a temp SQLite DB whose shape mirrors the real OpenCode schema:
 *   message(id, session_id, time_created, data)  // data JSON with role
 *   part(id, message_id, time_created, data)     // data JSON with type/text/...
 *
 * @param opts.messages — each message describes its parts as raw
 *   `data` JSON objects.  Defaults to {type, text} construction matches the
 *   real DB; tests can override with arbitrary shapes for tool/reasoning.
 */
function makeOpenCodeDb(opts: {
  messages: Array<{ role: "user" | "assistant"; parts: any[] }>;
  sessionId?: string;
}): OpenCodeFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), "oc-cumulative-"));
  const dbPath = join(tmpDir, "opencode.db");
  const sessionId = opts.sessionId ?? "ses_abc";

  const schemaSql = [
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)",
    "CREATE INDEX idx_message_session ON message(session_id)",
  ];
  for (const sql of schemaSql) {
    const r = spawnSync(SQLITE, [dbPath, sql], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("schema setup failed: " + r.stderr);
  }

  let t = 1700000000000;
  // SQLite-style single-quote escaping for any literal embedded in shell SQL.
  // This is TEST-FIXTURE safety only — the production `readOpenCodeCumulative`
  // uses bound parameters and never interpolates user input.
  const safeSessionId = sessionId.replace(/'/g, "''");
  for (const m of opts.messages) {
    t += 1000;
    const msgId = `${m.role}-${t}`;
    const msgData = JSON.stringify({ role: m.role });
    const safeMsgData = msgData.replace(/'/g, "''");
    const insertMsg = spawnSync(SQLITE, [
      dbPath,
      `INSERT INTO message (id, session_id, time_created, data) VALUES ('${msgId}', '${safeSessionId}', ${t}, '${safeMsgData}');`,
    ], { encoding: "utf8" });
    if (insertMsg.status !== 0) throw new Error("insert msg failed: " + insertMsg.stderr);

    for (let i = 0; i < m.parts.length; i++) {
      const p = m.parts[i];
      const partId = `${msgId}-p${i}`;
      const data = JSON.stringify(p);
      const safeData = data.replace(/'/g, "''");
      const sql = `INSERT INTO part (id, message_id, time_created, data) VALUES ('${partId}', '${msgId}', ${t + i}, '${safeData}');`;
      const r = spawnSync(SQLITE, [dbPath, sql], { encoding: "utf8" });
      if (r.status !== 0) throw new Error("insert part failed: " + r.stderr);
    }
  }

  return { dbPath, sessionId, tmpDir };
}

function fixtureCleanup(f: OpenCodeFixture) {
  rmSync(f.tmpDir, { recursive: true, force: true });
}

// A minimal in-memory driver backed by sqlite3's -json mode so we don't need
// to load the bind-param-only `node:sqlite` module at test time. The tests
// below are about row shapes / selection logic, not parameter binding —
// binding has its own coverage in tests/output-strategy.test.ts.
function makeCliDriver(): SqliteDriver {
  return {
    open(path: string) {
      const handle: { statements: Map<string, (params: unknown[]) => unknown[]>; close(): void } = {
        statements: new Map(),
        close() {},
      };
      function jsonAll(sql: string, params: unknown[]): unknown[] {
        const r = spawnSync(SQLITE, ["-json", path, sql.replace(/\?/g, () => {
          const v = params.shift();
          if (v === undefined || v === null) return "NULL";
          if (typeof v === "number") return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        })], { encoding: "utf8" });
        if (r.status !== 0) throw new Error("query failed: " + r.stderr);
        if (!r.stdout.trim()) return [];
        return JSON.parse(r.stdout);
      }
      return {
        prepare(sql: string) {
          return {
            get(...params: unknown[]) {
              const rows = jsonAll(sql, [...params]);
              return (rows[0] as Record<string, unknown>) ?? undefined;
            },
            all(...params: unknown[]) {
              return jsonAll(sql, [...params]);
            },
            run() {},
          };
        },
        close() { handle.close(); },
      };
    },
  };
}

const driver = makeCliDriver();

describe("readOpenCodeCumulative — basic aggregation", () => {
  let fixture: OpenCodeFixture;
  afterEach(() => { if (fixture) fixtureCleanup(fixture); });

  it("orders text from multiple assistant messages chronologically (oldest first)", () => {
    fixture = makeOpenCodeDb({
      messages: [
        { role: "user", parts: [{ type: "text", text: "user 1" }] },
        { role: "assistant", parts: [{ type: "text", text: "first reply" }] },
        { role: "user", parts: [{ type: "text", text: "user 2" }] },
        { role: "assistant", parts: [{ type: "text", text: "second reply" }] },
        { role: "assistant", parts: [{ type: "text", text: "third reply" }] },
      ],
    });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver);
    // Order: oldest assistant → newest. User content MUST be excluded.
    expect(out).toContain("first reply");
    expect(out).toContain("second reply");
    expect(out).toContain("third reply");
    expect(out).not.toContain("user 1");
    expect(out).not.toContain("user 2");
    // Chronological order — "first" must appear before "second" which must
    // appear before "third" in the joined snapshot.
    expect(out.indexOf("first reply")).toBeLessThan(out.indexOf("second reply"));
    expect(out.indexOf("second reply")).toBeLessThan(out.indexOf("third reply"));
  });

  it("returns empty string when no assistant message exists", () => {
    fixture = makeOpenCodeDb({
      messages: [
        { role: "user", parts: [{ type: "text", text: "only user" }] },
      ],
    });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver);
    expect(out).toBe("");
  });
});

describe("readOpenCodeCumulative — message window", () => {
  let fixture: OpenCodeFixture;
  afterEach(() => { if (fixture) fixtureCleanup(fixture); });

  it("defaults to a window of 50 assistant messages", () => {
    // 100 assistant messages. With default window=50, only the last
    // 50 by time_created DESC are kept; the older 50 must drop out.
    const messages: Array<{ role: "user" | "assistant"; parts: any[] }> = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: "assistant",
        parts: [{ type: "text", text: `msg-${i}` }],
      });
    }
    fixture = makeOpenCodeDb({ messages });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver);
    // 50..99 should be present, 0..49 must be excluded by the window.
    expect(out).toContain("msg-99");
    expect(out).toContain("msg-50");
    expect(out).not.toContain("msg-49");
    expect(out).not.toContain("msg-0");
  });

  it("respects messageWindow parameter", () => {
    const messages: Array<{ role: "user" | "assistant"; parts: any[] }> = [];
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: "assistant",
        parts: [{ type: "text", text: `a-${i}` }],
      });
    }
    fixture = makeOpenCodeDb({ messages });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver, {
      messageWindow: 3,
    });
    expect(out).toContain("a-9");
    expect(out).toContain("a-8");
    expect(out).toContain("a-7");
    expect(out).not.toContain("a-6");
  });
});

describe("readOpenCodeCumulative — type filtering", () => {
  let fixture: OpenCodeFixture;
  afterEach(() => { if (fixture) fixtureCleanup(fixture); });

  it("excludes tool parts by default (text-only)", () => {
    fixture = makeOpenCodeDb({
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "text", text: "Visible reply" },
            // Real-shape tool part per OpenCode schema:
            { type: "tool", tool: "bash", state: { input: { command: "rm -rf /" } } },
          ],
        },
      ],
    });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver);
    expect(out).toContain("Visible reply");
    expect(out).not.toContain("🔧");
    expect(out).not.toContain("bash");
    expect(out).not.toContain("rm -rf");
  });

  it("includes a compact 🔧 summary when includeTools=true; never dumps large input/output", () => {
    fixture = makeOpenCodeDb({
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "text", text: "Reading file now" },
            {
              type: "tool",
              tool: "read",
              state: {
                input: { filePath: "/tmp/big.ts", offset: 100, limit: 50 },
                // Output is intentionally massive — must NOT leak into output.
                output: "x".repeat(20_000),
              },
            },
          ],
        },
      ],
    });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver, {
      includeTools: true,
    });
    expect(out).toContain("🔧");
    expect(out).toContain("read");
    expect(out).toContain("/tmp/big.ts");
    expect(out).not.toContain("xxxxxx"); // we must not dump the output body
    expect(out).not.toContain("x".repeat(100));
  });

  it("excludes reasoning parts by default", () => {
    fixture = makeOpenCodeDb({
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "reasoning", text: "private chain-of-thought" },
            { type: "text", text: "final visible answer" },
          ],
        },
      ],
    });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver);
    expect(out).not.toContain("private chain-of-thought");
    expect(out).not.toContain("💭");
    expect(out).toContain("final visible answer");
  });

  it("includes 💭 reasoning summary when includeThoughts=true", () => {
    fixture = makeOpenCodeDb({
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "reasoning", text: "thinking hard about the problem" },
            { type: "text", text: "final answer" },
          ],
        },
      ],
    });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver, {
      includeThoughts: true,
    });
    expect(out).toContain("💭");
    expect(out).toContain("thinking hard about the problem");
    expect(out).toContain("final answer");
  });

  it("does not erase earlier text when newest messages contain only reasoning/tool parts", () => {
    // Regression for the bug fixed in the previous release: OpenCode writes
    // step-start/reasoning/tool-only messages *after* a textual answer and
    // a naive "latest assistant message" query erases the visible text.
    fixture = makeOpenCodeDb({
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "older textual answer" }] },
        { role: "assistant", parts: [{ type: "reasoning", text: "thinking step..." }] },
        { role: "assistant", parts: [{ type: "tool", tool: "bash", state: { input: { command: "ls" } } }] },
      ],
    });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver);
    expect(out).toContain("older textual answer");
    expect(out).not.toContain("🔧");
    expect(out).not.toContain("💭");
  });
});

describe("readOpenCodeCumulative — message window clamping", () => {
  let fixture: OpenCodeFixture;
  afterEach(() => { if (fixture) fixtureCleanup(fixture); });

  // Helper: generate N assistant messages with distinct text.
  function nMessages(n: number): Array<{ role: "user" | "assistant"; parts: any[] }> {
    const msgs: Array<{ role: "user" | "assistant"; parts: any[] }> = [];
    for (let i = 0; i < n; i++) {
      msgs.push({ role: "assistant", parts: [{ type: "text", text: `clamp-${i}` }] });
    }
    return msgs;
  }

  it("clamps messageWindow=0 to DEFAULT_MESSAGE_WINDOW (50)", () => {
    fixture = makeOpenCodeDb({ messages: nMessages(60) });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver, {
      messageWindow: 0,
    });
    // 60 messages, DEFAULT_WINDOW=50 → contains indices 10..59
    expect(out).toContain("clamp-59");
    expect(out).toContain("clamp-10");
    expect(out).not.toContain("clamp-9");
  }, 15_000);

  it("clamps negative messageWindow to DEFAULT_MESSAGE_WINDOW", () => {
    fixture = makeOpenCodeDb({ messages: nMessages(60) });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver, {
      messageWindow: -1,
    });
    expect(out).toContain("clamp-59");
    expect(out).toContain("clamp-10");
    expect(out).not.toContain("clamp-9");
  }, 15_000);

  it("clamps NaN messageWindow to DEFAULT_MESSAGE_WINDOW", () => {
    fixture = makeOpenCodeDb({ messages: nMessages(60) });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver, {
      messageWindow: NaN,
    });
    expect(out).toContain("clamp-59");
    expect(out).toContain("clamp-10");
    expect(out).not.toContain("clamp-9");
  }, 15_000);

  it("allows positive messageWindow override", () => {
    fixture = makeOpenCodeDb({ messages: nMessages(10) });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver, {
      messageWindow: 3,
    });
    expect(out).not.toContain("clamp-0");
    expect(out).toContain("clamp-9");
    expect(out).toContain("clamp-7");
    expect(out).not.toContain("clamp-6");
  }, 15_000);
});

describe("readOpenCodeCumulative — type-safety and binding", () => {
  let fixture: OpenCodeFixture;
  afterEach(() => { if (fixture) fixtureCleanup(fixture); });

  it("uses a bound parameter for sessionId (no string interpolation of user input)", () => {
    // Inject a SQL-special character into the session id; the query must
    // still find the message exactly once. Direct interpolation would let
    // the test break out and match multiple/false rows.
    fixture = makeOpenCodeDb({
      sessionId: "ses_special'; --",
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "first" }] },
        { role: "assistant", parts: [{ type: "text", text: "second" }] },
      ],
    });
    const out = readOpenCodeCumulative(fixture.dbPath, fixture.sessionId, driver);
    expect(out).toContain("first");
    expect(out).toContain("second");
  });
});
