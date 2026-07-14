import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAgentOutput } from "../src/output-reader.js";
import type { AgentResponse } from "../src/agent-sessions.js";

describe("readAgentOutput", () => {
  let tmpDir: string;
  // setup once per describe (we don't need beforeEach for tmp)
  tmpDir = mkdtempSync(join(tmpdir(), "pi-reader-"));

  function writeSession(content: string): string {
    const path = join(tmpDir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(path, content, "utf8");
    return path;
  }

  function makeFakeJsonlReader(text: string): (path: string, sinceMs: number) => AgentResponse | null {
    return () => ({ text, timestamp: "2026-07-13T00:00:01.000Z", source: "pi-jsonl" });
  }

  function makeEmptyJsonlReader(): (path: string, sinceMs: number) => AgentResponse | null {
    return () => null;
  }

  it("uses jsonl reader when agent_session.path is valid", async () => {
    const sessionPath = writeSession("ignored");
    const result = await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hello",
      maxWaitS: 5,
      deps: {
        sendText: () => {},
        waitIdle: () => ({ status: "idle" as const }),
        readPane: () => "",
        getAgentInfo: () => ({
          agent: "pi",
          pane_id: "w1:pX",
          tab_id: "w1:tX",
          workspace_id: "w1",
          agent_session: { kind: "path", path: sessionPath },
        }),
        readJsonl: makeFakeJsonlReader("clean answer from pi"),
        now: () => 1000,
      },
    });
    expect(result).not.toBeNull();
    expect(result?.text).toBe("clean answer from pi");
    expect(result?.source).toBe("pi-jsonl");
    expect(result?.fallbackReason).toBeUndefined();
  });

  it("uses omp-jsonl label when agent is omp", async () => {
    const sessionPath = writeSession("ignored");
    const result = await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hi",
      maxWaitS: 5,
      deps: {
        sendText: () => {},
        waitIdle: () => ({ status: "idle" as const }),
        readPane: () => "",
        getAgentInfo: () => ({
          agent: "omp",
          pane_id: "w1:pX",
          tab_id: "w1:tX",
          workspace_id: "w1",
          agent_session: { kind: "path", path: sessionPath },
        }),
        readJsonl: makeFakeJsonlReader("omp answer"),
        now: () => 1000,
      },
    });
    expect(result?.source).toBe("omp-jsonl");
  });

  it("falls back to scrape when no agent_session reported", async () => {
    const result = await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hi",
      maxWaitS: 5,
      deps: {
        sendText: () => {},
        waitIdle: () => ({ status: "idle" as const }),
        readPane: () => "pane content",
        getAgentInfo: () => null,
        readJsonl: makeFakeJsonlReader("unused"),
        now: () => 1000,
      },
    });
    expect(result?.source).toBe("screen-scrape");
    expect(result?.fallbackReason).toMatch(/no agent_session/);
  });

  it("falls back to scrape when session path is missing", async () => {
    const result = await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hi",
      maxWaitS: 5,
      deps: {
        sendText: () => {},
        waitIdle: () => ({ status: "idle" as const }),
        readPane: () => "scrape content",
        getAgentInfo: () => ({
          agent: "pi",
          pane_id: "w1:pX",
          tab_id: "w1:tX",
          workspace_id: "w1",
          agent_session: { kind: "id", id: "abc" },
        }),
        readJsonl: makeFakeJsonlReader("unused"),
        now: () => 1000,
      },
    });
    expect(result?.source).toBe("screen-scrape");
    expect(result?.fallbackReason).toMatch(/id, not a path/);
  });

  it("falls back to scrape when jsonl reader returns null", async () => {
    const sessionPath = writeSession("ignored");
    const result = await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hi",
      maxWaitS: 5,
      deps: {
        sendText: () => {},
        waitIdle: () => ({ status: "idle" as const }),
        readPane: () => "scraped content",
        getAgentInfo: () => ({
          agent: "pi",
          pane_id: "w1:pX",
          tab_id: "w1:tX",
          workspace_id: "w1",
          agent_session: { kind: "path", path: sessionPath },
        }),
        readJsonl: makeEmptyJsonlReader(),
        now: () => 1000,
      },
    });
    expect(result?.source).toBe("screen-scrape");
    expect(result?.fallbackReason).toMatch(/jsonl returned no usable response/);
  });

  it("falls back to scrape when jsonl returns empty text", async () => {
    const sessionPath = writeSession("ignored");
    const result = await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hi",
      maxWaitS: 5,
      deps: {
        sendText: () => {},
        waitIdle: () => ({ status: "idle" as const }),
        readPane: () => "scraped content",
        getAgentInfo: () => ({
          agent: "pi",
          pane_id: "w1:pX",
          tab_id: "w1:tX",
          workspace_id: "w1",
          agent_session: { kind: "path", path: sessionPath },
        }),
        readJsonl: () => ({ text: "", timestamp: "", source: "pi-jsonl" }),
        now: () => 1000,
      },
    });
    expect(result?.source).toBe("screen-scrape");
  });

  it("returns null if pane read also fails", async () => {
    const result = await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hi",
      maxWaitS: 5,
      deps: {
        sendText: () => {},
        waitIdle: () => ({ status: "idle" as const }),
        readPane: () => { throw new Error("pane gone"); },
        getAgentInfo: () => null,
        readJsonl: makeEmptyJsonlReader(),
        now: () => 1000,
      },
    });
    expect(result).toBeNull();
  });

  it("calls waitIdle with the configured timeout", async () => {
    let waitIdleTimeout = 0;
    await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hi",
      maxWaitS: 42,
      deps: {
        sendText: () => {},
        waitIdle: (_paneId, timeoutS) => {
          waitIdleTimeout = timeoutS;
          return { status: "idle" as const };
        },
        readPane: () => "",
        getAgentInfo: () => null,
        readJsonl: makeEmptyJsonlReader(),
        now: () => 1000,
      },
    });
    expect(waitIdleTimeout).toBe(42);
  });

  it("calls sendText exactly once", async () => {
    let sendCount = 0;
    await readAgentOutput({
      paneId: "w1:pX",
      prompt: "hi",
      maxWaitS: 5,
      deps: {
        sendText: () => { sendCount++; },
        waitIdle: () => ({ status: "idle" as const }),
        readPane: () => "",
        getAgentInfo: () => null,
        readJsonl: makeEmptyJsonlReader(),
        now: () => 1000,
      },
    });
    expect(sendCount).toBe(1);
  });
});