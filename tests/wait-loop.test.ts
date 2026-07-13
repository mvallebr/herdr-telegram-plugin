import { describe, it, expect } from "vitest";
import {
  shouldThrottle,
  formatElapsed,
  cleanPaneOutput,
  diffFromBaseline,
  runAgentTurn,
  type WaitLoopDeps,
} from "../src/wait-loop.js";

function makeFakeTg() {
  return {
    sent: [] as Array<{ chatId: number; threadId: number; text: string }>,
    async sendMessage(chatId: number, threadId: number, text: string) {
      this.sent.push({ chatId, threadId, text });
      return this.sent.length;
    },
  };
}

const dummyCfg = {
  botToken: "x",
  chatId: 0,
  waitTimeoutS: 1,
  throttleMs: 100,
  maxTotalWaitS: 30,
};

describe("shouldThrottle", () => {
  it("returns true within throttle window", () => {
    expect(shouldThrottle(Date.now(), 3000)).toBe(true);
  });

  it("returns false after throttle window", () => {
    expect(shouldThrottle(Date.now() - 4000, 3000)).toBe(false);
  });
});

describe("formatElapsed", () => {
  it("formats seconds", () => {
    expect(formatElapsed(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(125)).toBe("2m 5s");
  });

  it("formats hours", () => {
    expect(formatElapsed(3661)).toBe("1h 1m 1s");
  });
});

describe("cleanPaneOutput", () => {
  it("removes multiline context-mode banner block", () => {
    const input = `some agent output
context-mode active. Hierarchy: ctx_batch_execute > ctx_execute
<session_state source="compaction">
<session_mode>implement</session_mode>
</session_state>
more agent output after`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("context-mode active");
    expect(out).not.toContain("<session_state");
    expect(out).toContain("some agent output");
    expect(out).toContain("more agent output after");
  });

  it("filters individual context-mode lines as a fallback", () => {
    const input = `context-mode active. some text
<session_mode>foo</session_mode>
real output`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("context-mode active");
    expect(out).not.toContain("<session_mode>");
    expect(out).toContain("real output");
  });

  it("filters separator lines", () => {
    const input = `─ something nice ───────────────────────────────────────
real output`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("─");
    expect(out).toContain("real output");
  });

  it("filters lines longer than 300 chars", () => {
    const longLine = "x".repeat(500);
    const out = cleanPaneOutput(`real\n${longLine}\nafter`);
    expect(out).toContain("real");
    expect(out).toContain("after");
    expect(out).not.toContain(longLine);
  });
});

describe("diffFromBaseline", () => {
  it("returns current when baseline is empty", () => {
    expect(diffFromBaseline("", "hello\nworld")).toBe("hello\nworld");
  });

  it("returns empty when current equals baseline", () => {
    expect(diffFromBaseline("hello\nworld", "hello\nworld")).toBe("");
  });

  it("returns only the new lines appended at the end", () => {
    const baseline = "old line 1\nold line 2";
    const current = "old line 1\nold line 2\nnew line 3\nnew line 4";
    expect(diffFromBaseline(baseline, current)).toBe("new line 3\nnew line 4");
  });

  it("returns full current when current is a strict subset of baseline (heavy scroll)", () => {
    const baseline = "a\nb\nc\nd";
    const current = "a\nb";
    // Heavy scroll case: we can't reliably determine what's new, so return current.
    expect(diffFromBaseline(baseline, current)).toBe("a\nb");
  });
});

describe("runAgentTurn (with mocked deps)", () => {
  it("captures baseline BEFORE sendText", async () => {
    const baseline = "old content before send";
    const afterAgent = "old content before send\nagent response line";
    const sendTextOrder: string[] = [];
    let readCalls = 0;

    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {
        sendTextOrder.push("sendText");
      },
      readPane: () => {
        readCalls++;
        if (readCalls === 1) {
          sendTextOrder.push("readPane:baseline");
          return baseline;
        }
        return afterAgent;
      },
      waitIdle: () => ({ status: "idle" as const }),
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, "hi", dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
    });
    // Baseline must be read BEFORE sendText is called
    expect(sendTextOrder).toEqual(["readPane:baseline", "sendText"]);
    // The Telegram message should contain only the agent's response, NOT the baseline
    const sent = tg.sent[0].text;
    expect(sent).toContain("agent response line");
    expect(sent).not.toContain("old content before send");
  });

  it("sends only the new response when waitIdle returns idle immediately (done status)", async () => {
    const baseline = "line1\nline2\nline3";
    const afterSend = "line1\nline2\nline3\nagent: hello";
    let readCalls = 0;
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => {
        readCalls++;
        return readCalls === 1 ? baseline : afterSend;
      },
      waitIdle: () => ({ status: "idle" as const }),
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, "hi", dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
    });
    const sent = tg.sent[0].text;
    expect(sent).toContain("agent: hello");
    expect(sent).not.toContain("line1");
  });

  it("truncates responses over 3900 chars", async () => {
    const baseline = "";
    // Long but each line is short (<300 chars); 50 lines of 100 chars = 5000 chars total
    const longLine = "x".repeat(100);
    const longResponse = Array(50).fill(longLine).join("\n");
    let readCalls = 0;
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => {
        readCalls++;
        return readCalls === 1 ? baseline : longResponse;
      },
      waitIdle: () => ({ status: "idle" as const }),
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, "hi", dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 100,
    });
    const sent = tg.sent[0].text;
    expect(sent).toContain("... (truncated");
    // The actual response payload should be < 4000 chars
    expect(sent.length).toBeLessThan(4200);
  });

  it("strips context-mode banner before sending", async () => {
    const baseline = "old content";
    const paneContent = `old content
agent output
context-mode active. Hierarchy: ctx_batch_execute
<session_state source="compaction">
<session_mode>implement</session_mode>
</session_state>
more agent output`;
    let readCalls = 0;
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => {
        readCalls++;
        return readCalls === 1 ? baseline : paneContent;
      },
      waitIdle: () => ({ status: "idle" as const }),
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, "hi", dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
    });
    const sent = tg.sent[0].text;
    expect(sent).not.toContain("context-mode active");
    expect(sent).not.toContain("<session_state");
    expect(sent).toContain("agent output");
    expect(sent).toContain("more agent output");
    expect(sent).not.toContain("old content");
  });

  it("sends Working message on timeout (not throttled)", async () => {
    const baseline = "";
    const paneContent = "still working...";
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => paneContent,
      waitIdle: () => ({ status: "timeout" as const }),
    };
    const tg = makeFakeTg();
    // Use maxTotalWaitS=2 so the loop terminates after ~2 timeouts
    await runAgentTurn("w1:pX", 1, "hi", { ...dummyCfg, maxTotalWaitS: 2 }, tg as any, 100, {
      deps,
      maxOutputLines: 50,
    });
    expect(tg.sent.length).toBeGreaterThan(0);
    expect(tg.sent[0].text).toContain("Working");
  });

  it("sends Blocked message and stops on blocked status", async () => {
    const baseline = "";
    const paneContent = "approval needed";
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => paneContent,
      waitIdle: () => ({ status: "blocked" as const }),
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, "hi", dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
    });
    expect(tg.sent[0].text).toContain("Blocked");
    expect(tg.sent[0].text).toContain("approval needed");
  });

  it("sends timeout message when maxTotalWaitS is exceeded", async () => {
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => "x",
      waitIdle: () => ({ status: "timeout" as const }),
    };
    const tg = makeFakeTg();
    await runAgentTurn(
      "w1:pX",
      1,
      "hi",
      { ...dummyCfg, maxTotalWaitS: 0 },
      tg as any,
      100,
      { deps, maxOutputLines: 50 }
    );
    expect(tg.sent[0].text).toContain("Tempo limite excedido");
  });
});