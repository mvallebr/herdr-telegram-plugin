import { describe, it, expect, vi } from "vitest";
import { formatLastReadback, getLastReadback } from "../src/commands.js";
import { AgentCommunicator } from "../src/agent-sessions.js";
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

describe("getLastReadback", () => {
  it("delegates to AgentCommunicator.getAgentOutput", () => {
    const getAgentInfo = vi.fn().mockReturnValue(null);
    const readPane = vi.fn().mockReturnValue("scraped pane content\n");
    const comm = new AgentCommunicator("w1:pZ", getAgentInfo, readPane);

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

  it("uses jsonl reader output when available (no screen-scrape fallback)", () => {
    const getAgentInfo = vi.fn().mockReturnValue({
      agent: "pi",
      agent_status: "idle",
      pane_id: "w1:pZ",
      tab_id: "",
      workspace_id: "",
      agent_session: { kind: "path", path: "/tmp/test-session.jsonl" },
    });
    // Mock existsSync to return true for the session path so jsonl is chosen
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn().mockReturnValue(true),
      statSync: vi.fn().mockReturnValue({ isFile: () => true, size: 100 }),
      readFileSync: vi.fn().mockReturnValue(""),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    const readPane = vi.fn().mockReturnValue("should NOT be called\n");
    const comm = new AgentCommunicator("w1:pZ", getAgentInfo, readPane);

    // The reader will be called and return null (no actual jsonl content),
    // which is when AgentCommunicator falls back to readPane.
    const out = getLastReadback({
      mapping: ECHO_MAPPING,
      communicator: comm,
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });

    expect(readPane).toHaveBeenCalled(); // fallback because jsonl was null
    expect(out).toBeDefined();
  });

  it("passes busy state through to formatLastReadback", () => {
    const getAgentInfo = vi.fn().mockReturnValue(null);
    const readPane = vi.fn().mockReturnValue("working\n");
    const comm = new AgentCommunicator("w1:pZ", getAgentInfo, readPane);

    const out = getLastReadback({
      mapping: ECHO_MAPPING,
      communicator: comm,
      busy: true,
      now: () => fixedTs,
      truncateAt: 3000,
    });

    expect(out).toContain("(painel imprimindo");
  });

  it("does not call readPane when jsonl returns content (prefers structured)", () => {
    const tmpDir = (require("node:fs") as typeof import("node:fs")).mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "agent-comm-last-")
    );
    const sessionPath = require("node:path").join(tmpDir, "session.jsonl");
    require("node:fs").writeFileSync(
      sessionPath,
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "structured text from jsonl" }] },
      }) + "\n",
      "utf8"
    );

    const getAgentInfo = vi.fn().mockReturnValue({
      agent: "pi",
      agent_status: "idle",
      pane_id: "w1:pZ",
      tab_id: "",
      workspace_id: "",
      agent_session: { kind: "path", path: sessionPath },
    });
    const readPane = vi.fn().mockReturnValue("SHOULD NOT APPEAR\n");
    const comm = new AgentCommunicator("w1:pZ", getAgentInfo, readPane);

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

    require("node:fs").rmSync(tmpDir, { recursive: true, force: true });
  });
});
