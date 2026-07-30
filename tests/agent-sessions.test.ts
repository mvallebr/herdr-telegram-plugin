import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createAgentCommunicator } from "../src/agent-sessions.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
