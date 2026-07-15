import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPiSessionResponse,
  readCodexSessionResponse,
  readCodexSessionProgress,
  readAgentSessionResponse,
  pickOutputStrategy,
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
