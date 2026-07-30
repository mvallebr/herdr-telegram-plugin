import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentOutputReader } from "../../src/readers/registry.js";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeRequest(path: string, agent = "pi") {
  return {
    paneId: "w1:p1",
    agentName: agent,
    session: { kind: "path", path } as const,
    readPane: () => "SHOULD NOT BE CALLED",
    logger,
  };
}

describe("CodexJsonlReader cumulative output", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-reader-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("concatenates assistant rollout messages and excludes user prompts", () => {
    const path = join(dir, "rollout.jsonl");
    const events = [
      { type: "response_item", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "user prompt" }] } },
      { type: "response_item", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "progress note" }] } },
      { type: "response_item", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "final answer" }] } },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n"), "utf8");

    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "codex",
      session: { kind: "path", path } as const,
      readPane: () => "SHOULD NOT BE CALLED",
      logger,
    });

    const out = reader.read(100);
    expect(reader.kind).toBe("codex-jsonl");
    expect(out).toBe("progress note\n\nfinal answer");
    expect(out).not.toContain("user prompt");
  });
});

describe("PiJsonlReader cumulative output", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-reader-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("concatenates assistant messages chronologically and excludes user prompts", () => {
    const path = join(dir, "session.jsonl");
    const events = [
      { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "user one" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "second" }] } },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n"), "utf8");

    const reader = createAgentOutputReader(makeRequest(path));
    const out = reader.read(100);
    expect(reader.kind).toBe("pi-jsonl");
    expect(out).toBe("first\n\nsecond");
    expect(out).not.toContain("user one");
  });

  it("tolerates malformed lines", () => {
    const path = join(dir, "session.jsonl");
    const content = [
      "{bad json",
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    ].join("\n");
    writeFileSync(path, content, "utf8");

    const reader = createAgentOutputReader(makeRequest(path));
    expect(reader.read(100)).toBe("ok");
  });
});
