import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLastReadback, getLastReadback } from "../src/commands.js";
import { createAgentCommunicator, type AgentCommunicatorDeps } from "../src/agent-sessions.js";
import type { ThreadMapping } from "../src/types.js";

const ECHO_MAPPING: ThreadMapping = {
  pane_id: "w1:pZ",
  label: "Echo",
  agent: "pi",
  created_at: "x",
};

const fixedTs = "2026-07-25T13:00:00.000Z";

describe("formatLastReadback", () => {
  it("includes timestamp, label and the cleaned pane content", () => {
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: "echo says hi\n",
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });
    expect(out).toContain(fixedTs);
    expect(out).toContain("Echo");
    expect(out).toContain("echo says hi");
    expect(out).not.toContain("painel imprimindo");
  });

  it("truncates content longer than the configured limit", () => {
    // Realistic natural-language lines under the 300-char line filter.
    const line = "the agent says hello and continues to explain things";
    const big = Array.from({ length: 200 }, () => line).join("\n");
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: big,
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });
    expect(out).toMatch(/\(\.\.\. \d+ chars omitted\)/);
    expect(out.length).toBeLessThan(big.length);
  });

  it("does not truncate content shorter than the limit", () => {
    const small = "short message";
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: small,
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });
    expect(out).not.toMatch(/chars omitted/);
    expect(out).toContain(small);
  });

  it("appends a busy hint when busy=true", () => {
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: "still working\n",
      busy: true,
      now: () => fixedTs,
      truncateAt: 3000,
    });
    expect(out).toContain("(painel imprimindo");
  });

  it("honors a custom truncateAt for unit tests", () => {
    const line = "natural language sentence for the test";
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: Array.from({ length: 20 }, () => line).join("\n"),
      busy: false,
      now: () => fixedTs,
      truncateAt: 50,
    });
    expect(out).toMatch(/\(\.\.\. \d+ chars omitted\)/);
  });
});

function makeComm(opts: {
  paneId?: string;
  agent: string;
  path?: string;
  readPane: (paneId: string, lines: number) => string;
}): AgentCommunicatorDeps {
  const paneId = opts.paneId ?? "w1:pZ";
  return {
    paneId,
    getAgentInfo: () => ({
      agent: opts.agent,
      agent_status: "idle",
      pane_id: paneId,
      tab_id: "",
      workspace_id: "",
      agent_session: opts.path ? { kind: "path", path: opts.path } : undefined,
    }),
    readPane: opts.readPane,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

describe("getLastReadback", () => {
  it("delegates to the communicator's structured reader when it returns content", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-comm-last-"));
    const sessionPath = join(tmpDir, "session.jsonl");
    writeFileSync(
      sessionPath,
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "structured text from jsonl" }] },
      }) + "\n",
      "utf8",
    );

    const readPane = vi.fn(() => "SHOULD NOT APPEAR\n");
    const comm = createAgentCommunicator(makeComm({
      agent: "pi",
      path: sessionPath,
      readPane,
    }));

    const out = getLastReadback({
      mapping: ECHO_MAPPING,
      communicator: comm,
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });

    expect(readPane).not.toHaveBeenCalled();
    expect(out).toContain("structured text from jsonl");
    expect(out).not.toContain("SHOULD NOT APPEAR");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT call readPane when jsonl reader returns empty (current contract: empty structured output)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-comm-empty-"));
    const sessionPath = join(tmpDir, "session.jsonl");
    writeFileSync(sessionPath, "", "utf8");

    const readPane = vi.fn(() => "fallback scrape\n");
    const comm = createAgentCommunicator(makeComm({
      agent: "pi",
      path: sessionPath,
      readPane,
    }));

    const out = getLastReadback({
      mapping: ECHO_MAPPING,
      communicator: comm,
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });

    // Strict: structured selection is permanent; empty structured output
    // does NOT trigger readPane.
    expect(readPane).not.toHaveBeenCalled();
    expect(out).not.toContain("fallback scrape");
    expect(out).toBeDefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses readPane when no agent_session is reported (scrape only)", () => {
    const readPane = vi.fn(() => "scraped pane content\n");
    const comm = createAgentCommunicator(makeComm({
      agent: "unknown",
      readPane,
    }));

    const out = getLastReadback({
      mapping: ECHO_MAPPING,
      communicator: comm,
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });

    expect(readPane).toHaveBeenCalledWith("w1:pZ", 4_000);
    expect(out).toContain("scraped pane content");
    expect(out).toContain(fixedTs);
    expect(out).toContain("Echo");
  });

  it("passes busy state through to formatLastReadback", () => {
    const readPane = vi.fn(() => "working\n");
    const comm = createAgentCommunicator(makeComm({
      agent: "unknown",
      readPane,
    }));

    const out = getLastReadback({
      mapping: ECHO_MAPPING,
      communicator: comm,
      busy: true,
      now: () => fixedTs,
      truncateAt: 3000,
    });

    expect(out).toContain("(painel imprimindo");
  });
});
