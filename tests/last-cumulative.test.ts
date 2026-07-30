/**
 * Regression tests for `/last` readback after PR #11.
 *
 * PR #11 changed OpenCodeDbReader from "latest single assistant message"
 * to "cumulative snapshot of the latest N assistant messages". The
 * structured-text contract is preserved: /last should still
 *   - delegate to the communicator's structured reader (NOT readPane)
 *   - preserve structured text verbatim (no Model: stripping)
 *   - return text with multiple message content concatenated
 *
 * What changed vs. what didn't: the *underlying* reader is now
 * cumulative (50 messages by default). /last should expose that richer
 * snapshot — confirmed below.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLastReadback } from "../src/commands.js";
import {
  readOpenCodeCumulative,
  type SqliteDriver,
} from "../src/agent-sessions.js";
import { spawnSync } from "node:child_process";

const SQLITE = "sqlite3";

function makeOpenCodeDb(opts: {
  messages: Array<{ role: "user" | "assistant"; parts: any[] }>;
  sessionId?: string;
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "last-reg-"));
  const dbPath = join(tmpDir, "opencode.db");
  const sessionId = opts.sessionId ?? "ses_X";
  const safeSess = sessionId.replace(/'/g, "''");

  const schemaSql = [
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)",
    "CREATE INDEX idx_message_session ON message(session_id)",
  ];
  for (const sql of schemaSql) {
    const r = spawnSync(SQLITE, [dbPath, sql], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("schema: " + r.stderr);
  }

  let t = 1700000000000;
  for (const m of opts.messages) {
    t += 1000;
    const msgId = `${m.role}-${t}`;
    const safeMsg = JSON.stringify({ role: m.role }).replace(/'/g, "''");
    spawnSync(SQLITE, [
      dbPath,
      `INSERT INTO message (id, session_id, time_created, data) VALUES ('${msgId}', '${safeSess}', ${t}, '${safeMsg}');`,
    ], { encoding: "utf8" });

    for (let i = 0; i < m.parts.length; i++) {
      const p = m.parts[i];
      const partId = `${msgId}-p${i}`;
      const safeData = JSON.stringify(p).replace(/'/g, "''");
      const sql = `INSERT INTO part (id, message_id, time_created, data) VALUES ('${partId}', '${msgId}', ${t + i}, '${safeData}');`;
      spawnSync(SQLITE, [dbPath, sql], { encoding: "utf8" });
    }
  }
  return { dbPath, sessionId, tmpDir };
}

const cliDriver: SqliteDriver = {
  open(path: string) {
    return {
      prepare(sql: string) {
        return {
          get(...params: unknown[]) { return undefined; },
          all(...params: unknown[]) {
            const r = spawnSync(SQLITE, ["-json", path, sql.replace(/\?/g, () => {
              const v = params.shift();
              if (v == null) return "NULL";
              if (typeof v === "number") return String(v);
              return `'${String(v).replace(/'/g, "''")}'`;
            })], { encoding: "utf8" });
            if (r.status !== 0) throw new Error("query: " + r.stderr);
            return r.stdout.trim() ? JSON.parse(r.stdout) : [];
          },
          run() {},
        };
      },
      close() {},
    };
  },
};

describe("readOpenCodeCumulative — /last regression contract", () => {
  it("returns empty-string when only user messages exist (no fallback to scrape)", () => {
    const { dbPath, sessionId, tmpDir } = makeOpenCodeDb({
      messages: [
        { role: "user", parts: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = readOpenCodeCumulative(dbPath, sessionId, cliDriver);
    expect(out).toBe("");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the latest assistant messages text", () => {
    const { dbPath, sessionId, tmpDir } = makeOpenCodeDb({
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "first reply" }] },
        { role: "assistant", parts: [{ type: "text", text: "second reply" }] },
      ],
    });
    const out = readOpenCodeCumulative(dbPath, sessionId, cliDriver);
    expect(out).toContain("first reply");
    expect(out).toContain("second reply");
    // Chronological: first before second.
    expect(out.indexOf("first reply")).toBeLessThan(out.indexOf("second reply"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not dump the user prompt", () => {
    const { dbPath, sessionId, tmpDir } = makeOpenCodeDb({
      messages: [
        { role: "user", parts: [{ type: "text", text: "the prompt" }] },
        { role: "assistant", parts: [{ type: "text", text: "the answer" }] },
      ],
    });
    const out = readOpenCodeCumulative(dbPath, sessionId, cliDriver);
    expect(out).toContain("the answer");
    expect(out).not.toContain("the prompt");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("getLastReadback — /last still works with cumulative OpenCode reader", () => {
  it("returns formatted readback with the cumulative snapshot text", () => {
    const { dbPath, sessionId, tmpDir } = makeOpenCodeDb({
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "hello" }] },
        { role: "assistant", parts: [{ type: "text", text: "world" }] },
      ],
    });

    // Inject a structured-reader communicator via /last — we don't depend on
    // the global createAgentCommunicator here, we just test that
    // getLastReadback correctly formats whatever the reader returns.
    const fakeComm: any = {
      getAgentOutput: () => readOpenCodeCumulative(dbPath, sessionId, cliDriver),
    };
    const body = getLastReadback({
      mapping: {
        pane_id: "w1:pX",
        label: "Echo",
        agent: "opencode",
        created_at: "x",
      },
      communicator: fakeComm,
      busy: false,
      now: () => "2026-08-01T00:00:00.000Z",
      truncateAt: 3000,
    });
    expect(body).toContain("[2026-08-01T00:00:00.000Z]");
    expect(body).toContain("Echo");
    expect(body).toContain("hello");
    expect(body).toContain("world");
    // No busy hint for this branch.
    expect(body).not.toContain("(painel imprimindo");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
