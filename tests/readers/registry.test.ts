import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createAgentOutputReader } from "../../src/readers/registry.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("createAgentOutputReader — unknown agent", () => {
  it("returns a scrape reader when no structured source is known", () => {
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "agy",
      session: undefined,
      readPane: () => "scraped",
      logger,
    });
    expect(reader.kind).toBe("scrape");
    expect(reader.read(100)).toBe("scraped");
  });
});

describe("ScrapeReader", () => {
  it("strips terminal status bars at the scrape boundary", () => {
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "agy",
      session: undefined,
      readPane: () => "real output\nModel: something",
      logger,
    });
    expect(reader.read(100)).toBe("real output");
  });
});

describe("Codex reader selection", () => {
  it("selects codex-jsonl for an id session when its rollout file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const sessions = join(home, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    const sessionId = `registry-${Date.now()}`;
    const rolloutPath = join(sessions, `rollout-${sessionId}.jsonl`);
    writeFileSync(
      rolloutPath,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "from rollout" }],
        },
      }) + "\n",
      "utf8",
    );

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const reader = createAgentOutputReader({
        paneId: "w1:p1",
        agentName: "codex",
        session: { kind: "id", id: sessionId },
        readPane: () => "SHOULD NOT BE CALLED",
        logger,
      });
      expect(reader.kind).toBe("codex-jsonl");
      expect(reader.kind).not.toBe("scrape");
      expect(reader.read(100)).toContain("from rollout");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("OpenCode reader selection", () => {
  it("returns scrape with warning when opencode db is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-registry-"));
    const dbPath = join(dir, "missing.db");
    const warns: unknown[] = [];
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "opencode",
      session: { kind: "id", id: "ses_x" },
      readPane: () => "scraped",
      agentPaths: { opencode: { db: dbPath } },
      logger: { ...logger, warn: (m: string, d?: unknown) => warns.push({ m, d }) },
    });
    expect(reader.kind).toBe("scrape");
    expect(warns.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns opencode-db reader when db validates", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-registry-valid-"));
    const dbPath = join(dir, "opencode.db");
    const sessionId = "ses_abc";
    for (const sql of [
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)",
      `INSERT INTO message (id, session_id, time_created, data) VALUES ('m1', '${sessionId}', 1, '{"role":"assistant"}')`,
      `INSERT INTO part (id, message_id, time_created, data) VALUES ('p1', 'm1', 1, '{"type":"text","text":"hello"}')`,
    ]) {
      const r = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    }

    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "opencode",
      session: { kind: "id", id: sessionId },
      readPane: () => "SHOULD NOT BE CALLED",
      agentPaths: { opencode: { db: dbPath } },
      logger,
    });
    expect(reader.kind).toBe("opencode-db");
    expect(reader.read(100)).toContain("hello");
    rmSync(dir, { recursive: true, force: true });
  });
});
