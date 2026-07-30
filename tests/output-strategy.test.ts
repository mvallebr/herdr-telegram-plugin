import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createAgentCommunicator, type AgentCommunicatorDeps } from "../src/agent-sessions.js";

// --- Helpers ---------------------------------------------------------------

const SQLITE = "sqlite3";

interface OpenCodeFixture {
  dbPath: string;
  sessionId: string;
  tmpDir: string;
}

function makeOpenCodeDb(opts: {
  /** Messages as a sequence of {role, textPart} rows. role is 'user' or 'assistant'. */
  messages: Array<{ role: "user" | "assistant"; parts: Array<{ type: string; text: string }> }>;
  sessionId?: string;
}): OpenCodeFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-output-oc-"));
  const dbPath = join(tmpDir, "opencode.db");
  const sessionId = opts.sessionId ?? "ses_abc";

  // Bootstrap schema matching the **real** OpenCode layout:
  //   - message has `data TEXT` whose JSON contains `{"role":"assistant", ...}`
  //   - part has `data TEXT` whose JSON contains `{"type":"text","text":"..."}`
  //     but NEVER a `role` field — the role lives on the message row.
  const schemaSql = [
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)",
    "CREATE INDEX idx_message_session ON message(session_id)",
  ];
  for (const sql of schemaSql) {
    const r = spawnSync(SQLITE, [dbPath, sql], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("schema setup failed: " + r.stderr);
  }

  // Insert messages + parts (with a time_created tick so DESC ordering is stable)
  let t = 1700000000000;
  for (const m of opts.messages) {
    t += 1000;
    const msgId = `${m.role}-${t}`;
    // message.data carries the role — real OpenCode schema
    const msgData = JSON.stringify({ role: m.role });
    const safeMsgData = msgData.replace(/'/g, "''");
    const insertMsg = spawnSync(SQLITE, [
      dbPath,
      `INSERT INTO message (id, session_id, time_created, data) VALUES ('${msgId}', '${sessionId}', ${t}, '${safeMsgData}');`,
    ], { encoding: "utf8" });
    if (insertMsg.status !== 0) throw new Error("insert msg failed: " + insertMsg.stderr);

    for (const p of m.parts) {
      const partId = `${msgId}-p`;
      // Real OpenCode: part.data has type/text but NO role field
      const data = JSON.stringify({ type: p.type, text: p.text });
      const safeData = data.replace(/'/g, "''");
      const sql = `INSERT INTO part (id, message_id, time_created, data) VALUES ('${partId}', '${msgId}', ${t}, '${safeData}');`;
      const r = spawnSync(SQLITE, [dbPath, sql], { encoding: "utf8" });
      if (r.status !== 0) throw new Error("insert part failed: " + r.stderr);
    }
  }

  return { dbPath, sessionId, tmpDir };
}

function fixtureCleanup(f: OpenCodeFixture) {
  rmSync(f.tmpDir, { recursive: true, force: true });
}

// --- RED Phase Tests --------------------------------------------------------
//
// These tests define the behaviour we want the fixed-output-strategy to
// exhibit. They are expected to FAIL today (RED). Once implementation
// passes them, we'll have proven we fixed:
//   * the require()-in-ESM bug in readOpenCodeSessionResponse
//   * shell-interpolated db-path bugs (should use argv)
//   * naive `|`-split parsing of sqlite3 output (should use -json)
//   * the silent selection-by-side-effect bug
//

describe("OpenCode structured reader (fixed)", () => {
  let fixture: OpenCodeFixture;

  afterEach(() => {
    if (fixture) fixtureCleanup(fixture);
  });

  function makeDeps(paneId: string): AgentCommunicatorDeps {
    return {
      paneId,
      getAgentInfo: (target: string) => {
        if (target !== paneId) return null;
        return {
          agent: "opencode",
          agent_status: "idle",
          pane_id: paneId,
          tab_id: "",
          workspace_id: "",
          agent_session: { kind: "id", id: fixture.sessionId },
        };
      },
      readPane: () => "SHOULD NOT BE CALLED",
      agentPaths: { opencode: { db: fixture.dbPath } },
      logger: {
        info: () => {},
        warn: (...args: unknown[]) => (fixture as any)._warn?.(...args),
        error: (...args: unknown[]) => (fixture as any)._error?.(...args),
        debug: () => {},
      },
    };
  }

  it("returns assistant text and never user text", () => {
    fixture = makeOpenCodeDb({
      messages: [
        { role: "user", parts: [{ type: "text", text: "hello with a | pipe" }] },
        { role: "assistant", parts: [{ type: "text", text: "assistant reply with a | pipe" }] },
      ],
    });

    const comm = createAgentCommunicator(makeDeps("w1:p1"));
    const out = comm.getAgentOutput(4000);
    expect(out).toContain("assistant reply with a | pipe");
    expect(out).not.toContain("hello with a | pipe");
  });

  it("returns empty string when no assistant message exists, never falls back to readPane", () => {
    fixture = makeOpenCodeDb({
      messages: [
        { role: "user", parts: [{ type: "text", text: "the only message" }] },
      ],
    });

    let readPaneCalls = 0;
    const deps = makeDeps("w1:p1");
    deps.readPane = () => { readPaneCalls += 1; return "SHOULD NOT BE CALLED"; };
    const comm = createAgentCommunicator(deps);

    const out = comm.getAgentOutput(4000);
    expect(out).toBe("");
    expect(readPaneCalls).toBe(0);
  });

  it("returns older text when newer assistant messages have only reasoning/step parts", () => {
    // Real-world pattern: OpenCode writes step-start and reasoning-only
    // assistant messages *after* the textual answer.  The query must skip
    // those and pick the latest assistant message that has type=text parts.
    fixture = makeOpenCodeDb({
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "older textual answer" }] },
        { role: "assistant", parts: [{ type: "reasoning", text: "thinking step..." }] },
        { role: "assistant", parts: [{ type: "step_start", text: "starting new step" }] },
      ],
    });

    const comm = createAgentCommunicator(makeDeps("w1:p1"));
    const out = comm.getAgentOutput(4000);
    expect(out).toBe("older textual answer");
  });

  it("loggs structured read error when SQLite query throws at runtime", () => {
    fixture = makeOpenCodeDb({
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "ok" }] },
      ],
    });

    const warns: Array<{ message: string; data?: unknown }> = [];
    const errors: Array<{ message: string; data?: unknown }> = [];
    const deps = makeDeps("w1:p1");
    deps.logger = {
      info: () => {},
      warn: (m: string, d?: unknown) => warns.push({ message: m, data: d }),
      error: (m: string, d?: unknown) => errors.push({ message: m, data: d }),
      debug: () => {},
    };
    // Break the DB out from under the reader AFTER construction to force a runtime failure.
    const comm = createAgentCommunicator(deps);
    rmSync(fixture.dbPath, { force: true });

    let readPaneCalls = 0;
    deps.readPane = () => { readPaneCalls += 1; return "FALLBACK SCRAPE"; };
    const out = comm.getAgentOutput(4000);
    expect(out).toBe("");
    expect(readPaneCalls).toBe(0);
    expect(errors.length + warns.length).toBeGreaterThan(0);
  });
});

describe("OpenCode validation failure → fallback to scrape", () => {
  it("logs a warning once with meaningful reason when db is missing, then uses readPane", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-output-oc-missing-"));
    const dbPath = join(tmpDir, "does-not-exist.db");

    const warns: Array<{ message: string; data?: unknown }> = [];
    const paneId = "w1:pN";
    let readPaneCalls = 0;
    const deps: AgentCommunicatorDeps = {
      paneId,
      getAgentInfo: () => ({
        agent: "opencode",
        agent_status: "idle",
        pane_id: paneId,
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "id", id: "ses_nope" },
      }),
      readPane: (p: string) => { readPaneCalls += 1; return `scraped:${p}`; },
      agentPaths: { opencode: { db: dbPath } },
      logger: {
        info: () => {},
        warn: (m: string, d?: unknown) => warns.push({ message: m, data: d }),
        error: () => {},
        debug: () => {},
      },
    };

    const comm = createAgentCommunicator(deps);
    // First call: warn once, scrape
    expect(comm.getAgentOutput(4000)).toBe("scraped:w1:pN");
    // Second call: no new warn
    const warnsAfterFirst = warns.length;
    expect(comm.getAgentOutput(4000)).toBe("scraped:w1:pN");
    expect(warns.length).toBe(warnsAfterFirst);

    // The warn payload must contain the failure context — either the
    // message string or the structured `data.reason` references opencode
    // and the missing DB.
    const warnDump = JSON.stringify(warns[0]);
    expect(warnDump).toMatch(/opencode/i);
    expect(warnDump).toMatch(/db|database|missing/i);
    expect((warns[0].data as any)?.paneId).toBe(paneId);
    expect(readPaneCalls).toBe(2);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to scrape and includes sqlite3 unavailability reason when binary missing", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-output-oc-binmissing-"));
    const dbPath = join(tmpDir, "missing-bin.db");
    writeFileSync(dbPath, "", "utf8");

    const warns: Array<{ message: string; data?: unknown }> = [];
    const paneId = "w1:pB";
    const deps: AgentCommunicatorDeps = {
      paneId,
      getAgentInfo: () => ({
        agent: "opencode",
        agent_status: "idle",
        pane_id: paneId,
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "id", id: "ses_zzz" },
      }),
      readPane: (p: string) => `scraped:${p}`,
      agentPaths: { opencode: { db: dbPath } },
      logger: {
        info: () => {},
        warn: (m: string, d?: unknown) => warns.push({ message: m, data: d }),
        error: () => {},
        debug: () => {},
      },
    };

    // Force sqlite3 to be reported as missing using a shimmed PATH
    const pathBackup = process.env.PATH;
    process.env.PATH = "/var/empty/nope";
    try {
      const comm = createAgentCommunicator(deps);
      const out = comm.getAgentOutput(4000);
      // Whatever the reason — it must be either "sqlite3 missing" or "db missing" or "session not found"
      // but the outcome must be a scrape.
      expect(out).toBe("scraped:w1:pB");
      expect(warns.length).toBeGreaterThanOrEqual(1);
      const reason = String((warns[0].data as any)?.reason ?? warns[0].message);
      // Meaningful reason — not just "scrape".
      expect(reason).not.toBe("scrape");
    } finally {
      process.env.PATH = pathBackup;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("createAgentCommunicator — factory contract", () => {
  it("is the canonical construction path; no `new AgentCommunicator(` exists outside agent-sessions.ts", () => {
    // Read all .ts files under src/ except agent-sessions.ts itself.
    // Any `new AgentCommunicator(` outside that file is a contract violation.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = join(__dirname, "..", "src");
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const content = fs.readFileSync(full, "utf8");
          if (/new AgentCommunicator\(/.test(content)) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    }
    walk(root);

    // Only the module that defines AgentCommunicator may construct it.
    expect(offenders).toEqual(["agent-sessions.ts"]);
  });

  it("exposes AgentCommunicatorDeps from agent-sessions.ts", () => {
    expect(typeof createAgentCommunicator).toBe("function");
    const deps: AgentCommunicatorDeps = {
      paneId: "w1:p0",
      getAgentInfo: () => null,
      readPane: () => "",
    };
    const comm = createAgentCommunicator(deps);
    expect(comm.readerKind).toBe("scrape");
  });
});

describe("validation warning visibility — default logger", () => {
  it("writes a daemon-level warning to stderr when no explicit logger is passed and validation fails", () => {
    // Create a fixture whose opencode.db path does not exist.
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-output-oc-vis-"));
    const missingDb = join(tmpDir, "nope.db");
    const paneId = "w1:pV";
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => { stderrChunks.push(String(chunk)); return true; }
    );

    try {
      const comm = createAgentCommunicator({
        paneId,
        getAgentInfo: () => ({
          agent: "opencode",
          agent_status: "idle",
          pane_id: paneId,
          tab_id: "",
          workspace_id: "",
          agent_session: { kind: "id", id: "ses_x" },
        }),
        readPane: (p: string) => `scraped:${p}`,
        agentPaths: { opencode: { db: missingDb } },
        // No logger — must fall back to the project logger (stderr)
      });

      const out = comm.getAgentOutput(4000);
      expect(out).toBe("scraped:w1:pV");

      // Verify at least one stderr entry is a warn-level JSON record
      // from the agent-sessions logger.
      const warns = stderrChunks
        .map((c) => { try { return JSON.parse(c); } catch { return null; } })
        .filter((e) => e?.name === "agent-sessions" && e?.level === "warn");
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect(String(warns[0].reason ?? "")).not.toBe("");

      rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      spy.mockRestore();
    }
  });
});
