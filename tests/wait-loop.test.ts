import { describe, it, expect } from "vitest";
import {
  shouldThrottle,
  formatElapsed,
  cleanPaneOutput,
  extractResponseSince,
  runAgentTurn,
  type WaitLoopDeps,
} from "../src/wait-loop.js";

function makeFakeTg() {
  return {
    sent: [] as Array<{ chatId: number; threadId: number; text: string; opts?: any }>,
    async sendMessage(chatId: number, threadId: number, text: string, opts?: any) {
      this.sent.push({ chatId, threadId, text, opts });
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
  maxProgressUpdates: -1, // unlimited for tests
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

  it("filters lines containing long separator runs", () => {
    const input = `─ something nice ──────────────────────
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

  it("removes <session_state> blocks without the context-mode preamble", () => {
    const input = `agent response here
<session_state source="something-else">
<session_mode>plan</session_mode>
<some_other_key>some value</some_other_key>
</session_state>
more response`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("<session_state");
    expect(out).not.toContain("</session_state>");
    expect(out).toContain("agent response here");
    expect(out).toContain("more response");
  });

  it("filters status bars / debug overlays (high non-word ratio)", () => {
    const input = `here is a normal sentence
~12 % | $0.50 | 1.2k/300k | ctx=8% | mode=implement | R=99%
the agent continued discussing the topic`;
    const out = cleanPaneOutput(input);
    expect(out).toContain("here is a normal sentence");
    expect(out).toContain("the agent continued");
    expect(out).not.toContain("ctx=8%");
  });

  it("filters lines starting with XML-like opening tags", () => {
    const input = `agent response
<tool_name>bash</tool_name>
<tool_args>ls -la</tool_args>
<result>total 42</result>
the response continues`;
    const out = cleanPaneOutput(input);
    expect(out).toContain("agent response");
    expect(out).toContain("the response continues");
    expect(out).not.toContain("<tool_name>");
    expect(out).not.toContain("<result>");
  });

  it("keeps single-line responses intact", () => {
    const out = cleanPaneOutput("São 13/07/2026, 19:21:47 (horário de Brasília).");
    expect(out).toBe("São 13/07/2026, 19:21:47 (horário de Brasília).");
  });

  it("strips ANSI escape codes from status bars before scoring", () => {
    const input = "real response\n\x1b[32m~12 % | $0.50 | 1.2k/300k\x1b[0m\nmore response";
    const out = cleanPaneOutput(input);
    expect(out).toContain("real response");
    expect(out).toContain("more response");
  });
});

describe("extractResponseSince", () => {
  it("returns lines after user input anchor", () => {
    const content = "old\n qual a hora?\nresponse line\nmore";
    expect(extractResponseSince(content, "qual a hora?")).toBe("response line\nmore");
  });

  it("uses last non-blank line of user input as anchor", () => {
    const content = "before\n hello world\nagent says hi";
    expect(extractResponseSince(content, "hello\nworld")).toBe("agent says hi");
  });

  it("returns empty when anchor not found", () => {
    expect(extractResponseSince("some pane\ntext", "not in pane")).toBe("");
  });

  it("trims trailing separators, status bars, and empty lines", () => {
    const sep20 = "─".repeat(20);
    const content = `old\noi\nresponse text\n\n${sep20}\n~/foo · cost`;
    expect(extractResponseSince(content, "oi")).toBe("response text");
  });

  it("trims trailing shell prompts", () => {
    const content = "before\n query\nresult line\n~/cod · main $";
    expect(extractResponseSince(content, "query")).toBe("result line");
  });
});

describe("runAgentTurn (content-based polling)", () => {
  function makeFakeClock(startMs = 0) {
    let now = startMs;
    return {
      now: () => now,
      advance: (ms: number) => { now += ms; },
      set: (ms: number) => { now = ms; },
    };
  }

  const USER_INPUT = "hi";

  it("sends text then waits for pane to change", async () => {
    const order: string[] = [];
    let readCalls = 0;
    const base = "old content";

    const clock = makeFakeClock(0);
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => order.push("sendText"),
      readPane: () => {
        readCalls++;
        if (readCalls === 1) {
          order.push("readPane:postSend");
          return base + "\n" + USER_INPUT;
        }
        return base + "\n" + USER_INPUT + "\nagent response line";
      },
      sleep: async () => { clock.advance(100); },
      now: clock.now,
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, USER_INPUT, dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
      pollIntervalMs: 100,
      stabilityWindowMs: 100,
    });
    expect(order[0]).toBe("sendText");
    expect(order[1]).toBe("readPane:postSend");
    const sent = tg.sent[tg.sent.length - 1].text;
    expect(sent).toContain("agent response line");
    expect(sent).not.toContain("old content");
  });

  it("waits for pane to stabilize before sending final response", async () => {
    const prefix = "old\n" + USER_INPUT; // post-send snapshot
    let readIdx = 0;
    const panes = [
      prefix,                                 // post-send snapshot
      prefix,                                 // Phase 1 iter 1 (no change)
      prefix + "\nresponse starting",         // Phase 1 iter 2 (changed→break)
      prefix + "\nresponse starting\nmore",   // Phase 2 iter 1 (changed→progress)
      prefix + "\nresponse starting\nmore",   // Phase 2 iter 2 (stable)
      prefix + "\nresponse starting\nmore",   // Phase 2 iter 3 (stable→break by time)
    ];

    const clock = makeFakeClock(0);
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => panes[Math.min(readIdx++, panes.length - 1)],
      sleep: async () => { clock.advance(10); },
      now: clock.now,
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, USER_INPUT, dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
      pollIntervalMs: 10,
      stabilityWindowMs: 50,
    });
    expect(readIdx).toBeGreaterThanOrEqual(4);
    const finalSent = tg.sent[tg.sent.length - 1].text;
    expect(finalSent).toContain("more");
    expect(finalSent).not.toContain("old"); // prefix content stripped by anchor
  });

  it("sends Working progress updates while pane is still changing", async () => {
    const prefix = "old\n" + USER_INPUT;
    let readIdx = 0;
    const panes = [
      prefix,
      prefix + "\nstep 1",
      prefix + "\nstep 1\nstep 2",
      prefix + "\nstep 1\nstep 2\nstep 3 final",
      prefix + "\nstep 1\nstep 2\nstep 3 final",
    ];
    const clock = makeFakeClock(0);
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => panes[Math.min(readIdx++, panes.length - 1)],
      sleep: async () => { clock.advance(10); },
      now: clock.now,
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, USER_INPUT, { ...dummyCfg, throttleMs: 0 }, tg as any, 100, {
      deps,
      maxOutputLines: 50,
      pollIntervalMs: 10,
      stabilityWindowMs: 50,
    });
    expect(tg.sent.length).toBeGreaterThan(1);
    expect(tg.sent.some((m) => m.text.includes("Working"))).toBe(true);
    expect(tg.sent.some((m) => m.text.includes("step 3 final"))).toBe(true);
  });

  it("warns if pane never changes (no response)", async () => {
    const prefix = "stuck pane\n" + USER_INPUT;
    const clock = makeFakeClock(0);
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => prefix,
      sleep: async () => { clock.advance(100); },
      now: clock.now,
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, USER_INPUT, { ...dummyCfg, maxTotalWaitS: 1 }, tg as any, 100, {
      deps,
      maxOutputLines: 50,
      pollIntervalMs: 100,
      stabilityWindowMs: 100,
    });
    expect(tg.sent.length).toBeGreaterThan(0);
    expect(tg.sent[tg.sent.length - 1].text).toContain("No response");
  });

  it("truncates responses over 3900 chars", async () => {
    const longLine =
      "The agent responded with a detailed explanation about the topic. ".repeat(2);
    const longResponse = USER_INPUT + "\n" + Array(60).fill(longLine).join("\n");
    const prefix = USER_INPUT; // post-send snapshot has only the typed text
    let readIdx = 0;
    const panes = [prefix, longResponse, longResponse];
    const clock = makeFakeClock(0);
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => panes[Math.min(readIdx++, panes.length - 1)],
      sleep: async () => { clock.advance(10); },
      now: clock.now,
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, USER_INPUT, dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 100,
      pollIntervalMs: 10,
      stabilityWindowMs: 50,
    });
    const sent = tg.sent[tg.sent.length - 1].text;
    expect(sent).toContain("... (truncated");
    expect(sent.length).toBeLessThan(4200);
  });

  it("strips context-mode banner before sending", async () => {
    const prefix = "old content\n" + USER_INPUT;
    const paneContent = `old content
${USER_INPUT}
agent output
context-mode active. Hierarchy: ctx_batch_execute
<session_state source="compaction">
<session_mode>implement</session_mode>
</session_state>
more agent output`;
    let readIdx = 0;
    const panes = [prefix, paneContent, paneContent];
    const clock = makeFakeClock(0);
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => panes[Math.min(readIdx++, panes.length - 1)],
      sleep: async () => { clock.advance(10); },
      now: clock.now,
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, USER_INPUT, dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
      pollIntervalMs: 10,
      stabilityWindowMs: 50,
    });
    const sent = tg.sent[tg.sent.length - 1].text;
    expect(sent).not.toContain("context-mode active");
    expect(sent).not.toContain("<session_state");
    expect(sent).toContain("agent output");
    expect(sent).toContain("more agent output");
    expect(sent).not.toContain("old content");
  });
});