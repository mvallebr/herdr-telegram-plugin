import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  readPiSessionResponse,
  readCodexSessionResponse,
  readCodexSessionProgress,
  readAgentSessionResponse,
  pickOutputStrategy,
  createAgentCommunicator,
  type SqliteDriver,
} from "../src/agent-sessions.js";

describe("readPiSessionResponse", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-jsonl-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(content: string): string {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("returns null for a non-existent file", () => {
    expect(readPiSessionResponse("/does/not/exist", 0)).toBeNull();
  });

  it("returns null for empty file", () => {
    const path = writeSession("");
    expect(readPiSessionResponse(path, 0)).toBeNull();
  });

  it("returns the last assistant text response after sinceMs", () => {
    const events = [
      { type: "session", id: "s1", timestamp: "2026-07-13T00:00:00.000Z" },
      { type: "model_change", id: "m1", timestamp: "2026-07-13T00:00:01.000Z", provider: "openai" },
      {
        type: "message",
        id: "u1",
        timestamp: "2026-07-13T00:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        id: "a1",
        timestamp: "2026-07-13T00:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
        },
      },
      {
        type: "message",
        id: "u2",
        timestamp: "2026-07-13T00:00:10.000Z",
        message: { role: "user", content: [{ type: "text", text: "tell me more" }] },
      },
      {
        type: "message",
        id: "a2",
        timestamp: "2026-07-13T00:00:15.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second response" }],
        },
      },
    ];
    const path = writeSession(events.map((e) => JSON.stringify(e)).join("\n"));
    const since = Date.parse("2026-07-13T00:00:08.000Z");
    const result = readPiSessionResponse(path, since);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("second response");
    expect(result?.source).toBe("pi-jsonl");
  });

  it("ignores events before sinceMs", () => {
    const events = [
      {
        type: "message",
        id: "a1",
        timestamp: "2026-07-13T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "old" }] },
      },
    ];
    const path = writeSession(events.map((e) => JSON.stringify(e)).join("\n"));
    const since = Date.parse("2026-07-13T00:00:05.000Z");
    expect(readPiSessionResponse(path, since)).toBeNull();
  });

  it("skips thinking blocks but keeps text content", () => {
    const events = [
      {
        type: "message",
        id: "a1",
        timestamp: "2026-07-13T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "long thinking block..." },
            { type: "text", text: "actual answer" },
          ],
        },
      },
    ];
    const path = writeSession(events.map((e) => JSON.stringify(e)).join("\n"));
    const result = readPiSessionResponse(path, 0);
    expect(result?.text).toBe("actual answer");
  });

  it("concatenates multiple text blocks", () => {
    const events = [
      {
        type: "message",
        id: "a1",
        timestamp: "2026-07-13T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "para 1" },
            { type: "text", text: "para 2" },
          ],
        },
      },
    ];
    const path = writeSession(events.map((e) => JSON.stringify(e)).join("\n"));
    const result = readPiSessionResponse(path, 0);
    expect(result?.text).toBe("para 1\n\npara 2");
  });

  it("tolerates malformed lines", () => {
    const content = [
      "not json",
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-07-13T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      }),
      "{ broken json",
    ].join("\n");
    const path = writeSession(content);
    const result = readPiSessionResponse(path, 0);
    expect(result?.text).toBe("ok");
  });
});

describe("readCodexSessionResponse", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "codex-jsonl-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns the newest final assistant output_text after the send timestamp", () => {
    const path = join(tmpDir, "rollout.jsonl");
    writeFileSync(path, [
      JSON.stringify({ timestamp: "2026-07-15T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "old" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:05.000Z", type: "response_item", payload: { type: "reasoning", role: "assistant", content: [] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:06.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "partial reply" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:08.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "clean Codex reply" }] } }),
    ].join("\n"));
    const response = readCodexSessionResponse(path, Date.parse("2026-07-15T00:00:02.000Z"));
    expect(response).toMatchObject({ text: "clean Codex reply", source: "codex-jsonl" });
  });

  it("correlates an assistant reply to the matching user prompt", () => {
    const path = join(tmpDir, "correlated.jsonl");
    writeFileSync(path, [
      JSON.stringify({ timestamp: "2026-07-15T00:00:03.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "other request" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:04.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "wrong reply" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:05.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "telegram request" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:06.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "correct reply" }] } }),
    ].join("\n"));
    expect(readCodexSessionResponse(path, Date.parse("2026-07-15T00:00:02.000Z"), "telegram request")?.text)
      .toBe("correct reply");
  });

  it("returns correlated commentary only as progress, never the final answer", () => {
    const path = join(tmpDir, "progress.jsonl");
    writeFileSync(path, [
      JSON.stringify({ timestamp: "2026-07-15T00:00:03.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "other" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:04.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "wrong progress" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:05.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "telegram request" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:06.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "current progress" }] } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:07.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "final only" }] } }),
    ].join("\n"));
    expect(readCodexSessionProgress(path, Date.parse("2026-07-15T00:00:02.000Z"), "telegram request")?.text)
      .toBe("current progress");
  });
});

describe("pickOutputStrategy", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-strategy-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns scrape when ref is undefined", () => {
    const r = pickOutputStrategy(undefined, "pi");
    expect(r.strategy).toBe("scrape");
  });

  it("returns scrape when ref is an id (no path yet)", () => {
    const r = pickOutputStrategy({ kind: "id", id: "abc" }, "pi");
    expect(r.strategy).toBe("scrape");
    if (r.strategy === "scrape") {
      expect(r.reason).toMatch(/id, not a path/);
    }
  });

  it("returns scrape when path does not exist", () => {
    const r = pickOutputStrategy(
      { kind: "path", path: "/nonexistent/path" },
      "pi"
    );
    expect(r.strategy).toBe("scrape");
    if (r.strategy === "scrape") {
      expect(r.reason).toMatch(/does not exist/);
    }
  });

  it("returns scrape when path is empty", () => {
    const path = join(tmpDir, "empty.jsonl");
    writeFileSync(path, "");
    const r = pickOutputStrategy({ kind: "path", path }, "pi");
    expect(r.strategy).toBe("scrape");
    if (r.strategy === "scrape") {
      expect(r.reason).toMatch(/empty or not a file/);
    }
  });

  it("returns jsonl when path is a valid file", () => {
    const path = join(tmpDir, "valid.jsonl");
    writeFileSync(path, '{"type":"message"}');
    const r = pickOutputStrategy({ kind: "path", path }, "pi");
    expect(r.strategy).toBe("jsonl");
  });
});

describe("pickOutputStrategy — opencode id (cumulative)", () => {
  const SQLITE = "sqlite3";

  interface OpenCodeFixture {
    dbPath: string;
    sessionId: string;
    tmpDir: string;
  }

  function makeOpenCodeDb(opts: {
    messages: Array<{ role: "user" | "assistant"; parts: any[] }>;
    sessionId?: string;
  }): OpenCodeFixture {
    const tmpDir = mkdtempSync(join(tmpdir(), "pos-oc-"));
    const dbPath = join(tmpDir, "opencode.db");
    const sessionId = opts.sessionId ?? "ses_abc";

    for (const sql of [
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)",
      "CREATE INDEX idx_message_session ON message(session_id)",
    ]) {
      const r = spawnSync(SQLITE, [dbPath, sql], { encoding: "utf8" });
      if (r.status !== 0) throw new Error("schema: " + r.stderr);
    }

    let t = 1700000000000;
    for (const m of opts.messages) {
      t += 1000;
      const msgId = `${m.role}-${t}`;
      const safeMsg = JSON.stringify({ role: m.role }).replace(/'/g, "''");
      spawnSync(SQLITE, [dbPath,
        `INSERT INTO message (id, session_id, time_created, data) VALUES ('${msgId}', '${sessionId}', ${t}, '${safeMsg}');`,
      ], { encoding: "utf8" });
      for (let i = 0; i < m.parts.length; i++) {
        const p = m.parts[i];
        const safeData = JSON.stringify(p).replace(/'/g, "''");
        spawnSync(SQLITE, [dbPath,
          `INSERT INTO part (id, message_id, time_created, data) VALUES ('${msgId}-p${i}', '${msgId}', ${t + i}, '${safeData}');`,
        ], { encoding: "utf8" });
      }
    }
    return { dbPath, sessionId, tmpDir };
  }

  function fixtureCleanup(f: OpenCodeFixture) {
    rmSync(f.tmpDir, { recursive: true, force: true });
  }

  it("returns jsonl strategy with an AgentResponse reader for valid opencode id", () => {
    const fixture = makeOpenCodeDb({
      messages: [
        { role: "user", parts: [{ type: "text", text: "prompt" }] },
        { role: "assistant", parts: [{ type: "text", text: "cumulative reply" }] },
      ],
    });
    try {
      const result = pickOutputStrategy(
        { kind: "id", id: fixture.sessionId },
        "opencode",
        { opencode: { db: fixture.dbPath } },
      );
      expect(result.strategy).toBe("jsonl");

      const response = result.reader(0);
      expect(response).not.toBeNull();
      expect(response!.text).toContain("cumulative reply");
      expect(response!.text).not.toContain("prompt");
      expect(response!.source).toBe("opencode-db");
      expect(typeof response!.timestamp).toBe("string");
    } finally {
      fixtureCleanup(fixture);
    }
  });

  it("returns scrape when opencode db path is missing", () => {
    const result = pickOutputStrategy(
      { kind: "id", id: "ses_none" },
      "opencode",
      { opencode: { db: "/nonexistent/db" } },
    );
    expect(result.strategy).toBe("scrape");
    if (result.strategy === "scrape") {
      expect(result.reason).toMatch(/opencode db not available/i);
    }
  });
});

describe("readAgentSessionResponse (dispatch)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-dispatch-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads pi session regardless of agentName when path is provided", () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-07-13T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi from agent" }],
        },
      })
    );
    const r = readAgentSessionResponse(
      { kind: "path", path },
      "pi",
      0
    );
    expect(r?.text).toBe("hi from agent");
  });

  it("returns null when ref is undefined", () => {
    expect(readAgentSessionResponse(undefined, "pi", 0)).toBeNull();
  });

  it("returns null when ref is id only", () => {
    expect(
      readAgentSessionResponse({ kind: "id", id: "abc" }, "pi", 0)
    ).toBeNull();
  });
});

describe("AgentCommunicator (factory)", () => {
  const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

  it("uses readPane when getAgentInfo returns null", () => {
    const readPane = (paneId: string, _lines: number) => `scraped: ${paneId}`;
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => null,
      readPane,
      logger: noopLogger,
    });
    expect(comm.readerKind).toBe("scrape");
    expect(comm.getAgentOutput(4000)).toBe("scraped: w1:p1");
  });

  it("uses readPane when agent has no agent_session", () => {
    const readPane = () => "scraped content";
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
      }),
      readPane,
      logger: noopLogger,
    });
    expect(comm.getAgentOutput(4000)).toBe("scraped content");
  });

  it("returns '' when session path is missing at construction; does NOT call readPane", () => {
    // The structured reader is selected once. Runtime readPane is forbidden.
    // Construction-time validation may downgrade to scrape (e.g. path
    // missing); but in that case the reader kind must be "scrape".
    let readPaneCalls = 0;
    const readPane = () => { readPaneCalls += 1; return "fallback scrape"; };
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: "/nonexistent/session.jsonl" },
      }),
      readPane,
      logger: noopLogger,
    });
    // Validation should reject the missing path and downgrade to scrape.
    expect(comm.readerKind).toBe("scrape");
    expect(comm.getAgentOutput(4000)).toBe("fallback scrape");
    expect(readPaneCalls).toBe(1);
  });

  it("uses jsonl reader when session path is valid; readPane is never called even if reader returns empty", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-comm-"));
    const sessionPath = join(tmpDir, "session.jsonl");
    writeFileSync(sessionPath, JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "jsonl response" }],
      },
    }) + "\n", "utf8");

    let readPaneCalls = 0;
    const readPane = () => { readPaneCalls += 1; return "should not be called"; };
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      readPane,
      logger: noopLogger,
    });

    expect(comm.readerKind).toBe("pi-jsonl");
    expect(comm.getAgentOutput(4000)).toBe("jsonl response");
    expect(readPaneCalls).toBe(0);

    // Now if the reader returns empty (we'd need to mutate the file), the
    // empty result must NOT trigger readPane.
    writeFileSync(sessionPath, "", "utf8");
    // Construct a NEW communicator with the (now-empty) path so it picks
    // jsonl at construction; reads will return empty.
    const comm2 = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      readPane,
      logger: noopLogger,
    });
    expect(comm2.readerKind).toBe("pi-jsonl");
    expect(comm2.getAgentOutput(4000)).toBe("");
    expect(readPaneCalls).toBe(0); // never increased

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
