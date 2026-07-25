import { describe, it, expect } from "vitest";
import {
  shouldThrottle,
  formatElapsed,
  cleanPaneOutput,
  extractResponseSince,
  extractScreenResponse,
  extractScreenDelta,
  runAgentTurn,
  runAgentFollowLoop,
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
  progressIntervalMs: 100,
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

  it("preserves lines with common emoji (🚀, ✅, 🎉)", () => {
    const input = "Recebido com sucesso! 🚀 O teste chegou perfeitamente.\nplain line";
    const out = cleanPaneOutput(input);
    expect(out).toContain("Recebido com sucesso! 🚀 O teste chegou perfeitamente.");
    expect(out).toContain("plain line");
  });

  it("preserves lines with checkmarks and other Unicode symbols (✅, ⏳, ❌)", () => {
    const input = "✅ done\n⏳ working\n❌ failed\nplain";
    const out = cleanPaneOutput(input);
    expect(out).toContain("✅ done");
    expect(out).toContain("⏳ working");
    expect(out).toContain("❌ failed");
  });

  it("preserves lines with non-Latin scripts (Cyrillic, Greek, accented)", () => {
    const input = "Olá mundo\nПривет мир\nΓειά σου Κόσμε";
    const out = cleanPaneOutput(input);
    expect(out).toContain("Olá mundo");
    expect(out).toContain("Привет мир");
    expect(out).toContain("Γειά σου Κόσμε");
  });

  it("still strips visual separators and lines that are pure ANSI noise", () => {
    const input = "real\n──────\nmore real\n\x1b[31m\x1b[0m";
    const out = cleanPaneOutput(input);
    expect(out).toContain("real");
    expect(out).toContain("more real");
    expect(out).not.toContain("──────");
    // Empty line with only ANSI escapes should be filtered as control chars
    expect(out).not.toMatch(/^\s*$/m);
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

describe("extractScreenResponse", () => {
  it("returns empty when the exact prompt is absent instead of leaking terminal text", () => {
    const content = [
      "older output",
      "› a wrapped or transformed prompt",
      "Useful final answer",
      "─".repeat(31),
      "status · 10%",
    ].join("\n");
    expect(extractScreenResponse(content, "original long prompt")).toBe("");
  });

  it("still returns the exact anchored response", () => {
    expect(extractScreenResponse("prompt\nclean reply", "prompt")).toBe("clean reply");
  });

  it("keeps an OpenCode prompt anchor after stripping its terminal border", () => {
    const prompt = "Keep it under 4000 characters. Summarize what we've been working on: original goal, progress, blockers, next steps.";
    const pane = `┃  ${prompt}\n┃\n┃  Original goal\n┃  A clean summary`;
    expect(extractScreenResponse(pane, prompt)).toBe("Original goal\nA clean summary");
  });
});

describe("extractScreenDelta", () => {
  it("returns only new terminal text when a prompt disappears after submit", () => {
    expect(extractScreenDelta("header\nold", "header\nnew answer")).toBe("new answer");
  });

  it("fails closed when there is no stable shared prefix", () => {
    expect(extractScreenDelta("old", "unrelated")).toBe("");
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
    expect(tg.sent.some((m) => m.text.includes("agent response line"))).toBe(true);
    expect(tg.sent[tg.sent.length - 1].text).toBe("✅ (0s).");
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
    expect(tg.sent.some((m) => m.text.includes("more"))).toBe(true);
    expect(tg.sent[tg.sent.length - 1].text).toBe("✅ (0s).");
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
    const preview = tg.sent.find((m) => m.text.includes("... (truncated"));
    expect(preview?.text).toContain("... (truncated");
    expect(preview?.text.length).toBeLessThan(4200);
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
    const preview = tg.sent.find((m) => m.text.includes("agent output"))?.text ?? "";
    expect(preview).not.toContain("context-mode active");
    expect(preview).not.toContain("<session_state");
    expect(preview).toContain("agent output");
    expect(preview).toContain("more agent output");
    expect(preview).not.toContain("old content");
  });
});

describe("runAgentFollowLoop (pane delta)", () => {
  function makeFakeClock(startMs = 0) {
    let now = startMs;
    return {
      now: () => now,
      advance: (ms: number) => { now += ms; },
      set: (ms: number) => { now = ms; },
    };
  }

  // Create a deps object where readPane returns a sequence of panes
  // controlled by the test, sleep is a no-op, sendMessage records.
  function makeFollowDeps(paneSequence: string[]) {
    let readCalls = 0;
    const sent: Array<{ chatId: number; threadId: number; text: string }> = [];
    const sleeps: number[] = [];
    return {
      paneSequence,
      readCalls: () => readCalls,
      sent,
      sleeps,
      deps: {
        readPane: () => {
          const idx = readCalls++;
          return paneSequence[Math.min(idx, paneSequence.length - 1)];
        },
        sendMessage: async (chatId: number, threadId: number, text: string) => {
          sent.push({ chatId, threadId, text });
          return sent.length;
        },
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        now: () => Date.now(),
        sendText: () => {},
      } as Partial<WaitLoopDeps>,
    };
  }

  function makeCfg(intervalMs = 100) {
    return {
      ...dummyCfg,
      progressIntervalMs: intervalMs,
    } as any;
  }

  it("emits only the suffix delta when the pane grew", async () => {
    const fixture = makeFollowDeps([
      "pane baseline content",   // baseline (no trailing newline)
      "pane baseline content\nagent responded: hello", // grew (no trailing newline)
      "pane baseline content\nagent responded: hello\nmore stuff", // grew again
    ]);
    // shouldContinue ticks twice per iteration. 6 ticks = 3 iterations:
    // 1 baseline + 2 polls.
    let ticks = 0;
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      shouldContinue: () => ticks++ < 6,
      advanceTurn: () => {},
      deps: fixture.deps as WaitLoopDeps,
    });
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[0].text).toBe("agent responded: hello");
    expect(fixture.sent[1].text).toBe("more stuff");
  });

  it("emits nothing when the pane is unchanged between polls", async () => {
    const fixture = makeFollowDeps([
      "stable pane content",
      "stable pane content",
      "stable pane content",
    ]);
    let ticks = 0;
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      shouldContinue: () => ticks++ < 6,
      advanceTurn: () => {},
      deps: fixture.deps as WaitLoopDeps,
    });
    expect(fixture.sent).toHaveLength(0);
  });

  it("emits the old prefix as delta when the pane scrolled (case from production bug)", async () => {
    // Repro of the bug that motivated this fix: a persistent status-bar-like
    // suffix showed up at the end of both reads (the 'endsWith' trap).
    // We must NOT return the previous content as 'prefix' — emit a labelled
    // tail instead so the user sees activity but no duplication.
    const statusBar = "───── MiniMax/medium ─────";
    const baseline = "a\nb\nc\n" + statusBar;
    const after = "[tool output]\nagent thinking\n" + statusBar;
    const fixture = makeFollowDeps([baseline, after]);
    let ticks = 0;
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      shouldContinue: () => ticks++ < 4,
      advanceTurn: () => {},
      deps: fixture.deps as WaitLoopDeps,
    });
    expect(fixture.sent).toHaveLength(1);
    // Must NOT include the previous pane content "a\nb\nc\n"
    expect(fixture.sent[0].text).not.toContain("a\nb\nc");
    // Must indicate the pane scrolled
    expect(fixture.sent[0].text).toMatch(/pane scrolled/);
    // Should include the new content observed
    expect(fixture.sent[0].text).toContain("[tool output]");
  });

  it("truncates huge suffixes to last 3000 chars with ellipsis prefix", async () => {
    const baseline = "base\n";
    // 5000 chars of new content
    const huge = "x".repeat(5000);
    const after = baseline + huge + "\n";
    const fixture = makeFollowDeps([baseline, after]);
    let ticks = 0;
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      shouldContinue: () => ticks++ < 4,
      advanceTurn: () => {},
      deps: fixture.deps as WaitLoopDeps,
    });
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0].text.startsWith("…")).toBe(true);
    // Truncated body should still be under Telegram's 4096-char limit
    expect(fixture.sent[0].text.length).toBeLessThanOrEqual(3100);
  });

  it("uses stripStatusBar on baseline and polls (does not discard recent lines)", async () => {
    // Baseline contains the agent's "real" latest output. If we applied
    // cleanPaneOutput (the old broken behaviour) the baseline digest would
    // be missing that line, and the next poll with the same line would be
    // considered unchanged -> no emission. With stripStatusBar the line is
    // preserved.
    //
    // Note: stripStatusBar's existing regex strips the BARE separator
    // (`──────...`) but not the modern '─── MiniMax/medium ───' format.
    // The delta therefore includes the trailing status-bar line. We accept
    // that here — fixing stripStatusBar's regex is a separate concern.
    const agentLine = "agent: finished processing your request\n";
    const baseline = "old intro\n" + agentLine;
    const after = baseline + "agent: response goes here\n───── MiniMax/medium ─────";
    const fixture = makeFollowDeps([baseline, after]);
    let ticks = 0;
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      shouldContinue: () => ticks++ < 4,
      advanceTurn: () => {},
      deps: fixture.deps as WaitLoopDeps,
    });
    expect(fixture.sent).toHaveLength(1);
    // Delta is the suffix that grew between polls. stripStatusBar's regex
    // does not match the 'MiniMax/medium' status bar format, so it stays in
    // the emission. That is acceptable noise for follow mode.
    expect(fixture.sent[0].text).toContain("agent: response goes here");
    // Critically: must NOT contain the previous lines (no prefix delta).
    expect(fixture.sent[0].text).not.toContain("old intro");
    expect(fixture.sent[0].text).not.toContain("agent: finished");
  });

  it("emits the suffix delta even when both reads share a trailing status bar (regression: endsWith branch)", async () => {
    // Repro of the production 'manda os últimos 3000' bug from PR #7:
    // both polls ended in the same persistent status bar (the user's
    // minimax-m3 hint line), which made the old endsWith branch emit the
    // entire previous-pane contents as 'prefix delta'.
    // We must detect this as suffix growth and emit only the new tail.
    const statusBar = "─── MiniMax/medium ───";
    const baseline = statusBar + "\nold intro line 1\nold intro line 2\n";
    const after = baseline + "agent: hello\n";
    const fixture = makeFollowDeps([baseline, after]);
    let ticks = 0;
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      shouldContinue: () => ticks++ < 4,
      advanceTurn: () => {},
      deps: fixture.deps as WaitLoopDeps,
    });
    expect(fixture.sent).toHaveLength(1);
    // Only the suffix that was appended
    expect(fixture.sent[0].text).toBe("agent: hello");
    // Critically: the duplicate 'prefix delta' must NOT appear. The previous
    // production bug emitted the entire baseline as a 'prefix' here.
    expect(fixture.sent[0].text).not.toContain("old intro");
    expect(fixture.sent[0].text).not.toContain(statusBar);
  });

  it("keeps polling even when readPane throws (no crash, no emission)", async () => {
    let readCalls = 0;
    const sent: Array<{ chatId: number; threadId: number; text: string }> = [];
    const deps: Partial<WaitLoopDeps> = {
      readPane: () => {
        readCalls++;
        if (readCalls === 1) return "stable content\n"; // baseline
        if (readCalls === 2) throw new Error("herdr unavailable");
        return "stable content\nnew line"; // recovers (no trailing newline)
      },
      sendMessage: async (chatId, threadId, text) => {
        sent.push({ chatId, threadId, text });
        return sent.length;
      },
      sleep: async () => {},
      now: () => Date.now(),
      sendText: () => {},
    };
    // shouldContinue is called twice per loop iteration (one at `while` and
    // one after the sleep). Use 6 ticks = 3 iterations: 1 baseline read +
    // 1 throw + 1 recovery read.
    let ticks = 0;
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      shouldContinue: () => ticks++ < 6,
      advanceTurn: () => {},
      deps: deps as WaitLoopDeps,
    });
    // First poll: errored -> skipped (no emission). Second poll: new line.
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("new line");
  });

  it("stops emitting the moment shouldContinue returns false (no extra poll)", async () => {
    let readCalls = 0;
    const sent: string[] = [];
    const deps: Partial<WaitLoopDeps> = {
      readPane: () => {
        readCalls++;
        return `content${readCalls}\n`;
      },
      sendMessage: async (_c, _t, text) => {
        sent.push(text);
        return sent.length;
      },
      sleep: async () => {},
      now: () => Date.now(),
      sendText: () => {},
    };
    // shouldContinue returns true the first two iterations, false after.
    let ticks = 0;
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      shouldContinue: () => {
        ticks++;
        return ticks <= 2;
      },
      advanceTurn: () => {},
      deps: deps as WaitLoopDeps,
    });
    expect(readCalls).toBeLessThanOrEqual(2); // baseline + at most 1 poll
  });
});
