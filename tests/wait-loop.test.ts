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

describe("runAgentTurn (PR #10 observe-loop engine)", () => {
  function makeFakeClock(startMs = 0) {
    let now = startMs;
    return {
      now: () => now,
      advance: (ms: number) => { now += ms; },
      set: (ms: number) => { now = ms; },
    };
  }

  const USER_INPUT = "hi";

  // PR #10 changed the engine from coordinateTurn+wrapper+reporter to
  // runObserveLoop with an idle stop condition. Output format is now:
  //   - Working tick standalone: `⏳ Working (Xs).`
  //   - Pane delta emitted as its own message via output.paneDelta
  //   - Final consolidated: `✅ (Xs):\n\n<pane content>`
  // Tests below exercise the new contract.

  it("sends the prompt immediately (pass-through) before polling", async () => {
    const order: string[] = [];
    let readCalls = 0;
    const base = "old content";

    const clock = makeFakeClock(0);
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => order.push("sendText"),
      readPane: () => {
        readCalls++;
        order.push("readPane");
        if (readCalls === 1) return base;
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
    expect(order.filter((s) => s.startsWith("readPane")).length).toBeGreaterThanOrEqual(1);
    expect(tg.sent.some((m) => m.text.includes("agent response line"))).toBe(true);
    expect(tg.sent[tg.sent.length - 1].text.startsWith("✅")).toBe(true);
  });

  it("emits a Working tick on every iteration until pane stabilises", async () => {
    const prefix = "old\n" + USER_INPUT;
    let readIdx = 0;
    const panes = [
      prefix,
      prefix,
      prefix + "\nresponse starting",
      prefix + "\nresponse starting\nmore",
      prefix + "\nresponse starting\nmore",
      prefix + "\nresponse starting\nmore",
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
    const working = tg.sent.filter((m) => m.text.startsWith("⏳ Working"));
    expect(working.length).toBeGreaterThanOrEqual(2);
    for (const m of working) {
      expect(m.text).toMatch(/^⏳ Working \(\d+s\)\.$/);
    }
  });

  it("emits pane deltas as separate messages when content grows", async () => {
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
    await runAgentTurn("w1:pX", 1, USER_INPUT, dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
      pollIntervalMs: 10,
      stabilityWindowMs: 50,
    });
    expect(tg.sent.some((m) => m.text.includes("Working"))).toBe(true);
    expect(tg.sent.some((m) => m.text.includes("step 1") && !m.text.startsWith("⏳"))).toBe(true);
    expect(tg.sent.some((m) => m.text.includes("step 2") && !m.text.startsWith("⏳"))).toBe(true);
    expect(tg.sent.some((m) => m.text.includes("step 3 final") && !m.text.startsWith("⏳"))).toBe(true);
    const final = tg.sent[tg.sent.length - 1].text;
    expect(final.startsWith("✅")).toBe(true);
    expect(final).toContain("step 3 final");
  });

  it("exits the loop and emits a final message when pane never changes", async () => {
    const prefix = "stable\n" + USER_INPUT;
    const clock = makeFakeClock(0);
    const deps: Partial<WaitLoopDeps> = {
      sendText: () => {},
      readPane: () => prefix,
      sleep: async () => { clock.advance(100); },
      now: clock.now,
    };
    const tg = makeFakeTg();
    await runAgentTurn("w1:pX", 1, USER_INPUT, dummyCfg, tg as any, 100, {
      deps,
      maxOutputLines: 50,
      pollIntervalMs: 100,
      stabilityWindowMs: 200,
    });
    // No separate "No response" warning any more — when stability hits, the
    // loop finalises with the latest pane content (the agent hasn't changed
    // anything, but the turn is over).
    expect(tg.sent[tg.sent.length - 1].text.startsWith("✅")).toBe(true);
    expect(tg.sent[tg.sent.length - 1].text).toContain(USER_INPUT);
  });

  it("truncates deltas that exceed Telegram's 4096-char limit", async () => {
    const longLine =
      "The agent responded with a detailed explanation about the topic. ".repeat(2);
    const longResponse = USER_INPUT + "\n" + Array(60).fill(longLine).join("\n");
    const prefix = USER_INPUT;
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
    // The first delta is the appended junk; the observe-loop truncates to
    // the last 3000 chars and prepends an ellipsis when it exceeds 3000.
    const delta = tg.sent.find((m) => m.text.includes("\u2026"));
    expect(delta).toBeDefined();
    expect(delta!.text.length).toBeLessThanOrEqual(3100);
  });
});

describe("runAgentFollowLoop (PR #10 observe-loop engine)", () => {
  function makeFakeClock(startMs = 0) {
    let now = startMs;
    return {
      now: () => now,
      advance: (ms: number) => { now += ms; },
      set: (ms: number) => { now = ms; },
    };
  }

  // Create a deps object where readPane returns a sequence of panes
  // controlled by the test, sleep advances the clock on each call,
  // sendMessage records.
  function makeFollowDeps(paneSequence: string[], clock: ReturnType<typeof makeFakeClock>) {
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
          clock.advance(ms);
        },
        now: clock.now,
        sendText: () => {},
      } as Partial<WaitLoopDeps>,
    };
  }

  function makeCfg(intervalMs = 100) {
    return { ...dummyCfg, progressIntervalMs: intervalMs } as any;
  }

  // Helper to drive the follow loop with a configurable expiration deadline.
  // The closure freezes a wall-clock value at call time so each iteration
  // can compare `now() >= expiresAt` deterministically.
  function makeFollowExpiring(clock: ReturnType<typeof makeFakeClock>, delayMs: number) {
    const startedAt = clock.now();
    return () => startedAt + delayMs;
  }

  it("emits only the suffix delta when the pane grew", async () => {
    const clock = makeFakeClock(0);
    const fixture = makeFollowDeps([
      "pane baseline content",
      "pane baseline content\nagent responded: hello",
      "pane baseline content\nagent responded: hello\nmore stuff",
    ], clock);
    const expiresAt = makeFollowExpiring(clock, 250);
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      expiresAt,
      deps: fixture.deps as WaitLoopDeps,
    });
    const deltas = fixture.sent.filter((m) => m.text.includes("agent") || m.text.includes("more stuff"));
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  it("emits nothing when the pane is unchanged between polls", async () => {
    const clock = makeFakeClock(0);
    const fixture = makeFollowDeps([
      "stable pane content",
      "stable pane content",
      "stable pane content",
    ], clock);
    const expiresAt = makeFollowExpiring(clock, 250);
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      expiresAt,
      deps: fixture.deps as WaitLoopDeps,
    });
    expect(fixture.sent.every((m) =>
      m.text.startsWith("⏳ Working") ||
      m.text.includes("Follow ended") ||
      m.text.includes("Subscription expired"),
    )).toBe(true);
  });

  it("emits a labelled tail when the prefix diverges (pane scrolled)", async () => {
    const clock = makeFakeClock(0);
    const statusBar = "───── MiniMax/medium ─────";
    const baseline = "a\nb\nc\n" + statusBar;
    const after = "[tool output]\nagent thinking\n" + statusBar;
    const fixture = makeFollowDeps([baseline, after], clock);
    const expiresAt = makeFollowExpiring(clock, 250);
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      expiresAt,
      deps: fixture.deps as WaitLoopDeps,
    });
    const labelled = fixture.sent.find((m) => m.text.match(/pane scrolled/));
    expect(labelled).toBeDefined();
    expect(labelled?.text).not.toContain("a\nb\nc");
    expect(labelled?.text).toContain("[tool output]");
  });

  it("truncates huge suffixes to last 3000 chars with ellipsis prefix", async () => {
    const clock = makeFakeClock(0);
    const fixture = makeFollowDeps([
      "base\n",
      "base\n" + "x".repeat(5000) + "\n",
    ], clock);
    const expiresAt = makeFollowExpiring(clock, 250);
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      expiresAt,
      deps: fixture.deps as WaitLoopDeps,
    });
    const delta = fixture.sent.find((m) => m.text.startsWith("…"));
    expect(delta).toBeDefined();
    expect(delta!.text.length).toBeLessThanOrEqual(3100);
  });

  it("strips status bar from baseline and polls (does not discard recent lines)", async () => {
    const clock = makeFakeClock(0);
    const agentLine = "agent: finished processing your request\n";
    const baseline = "old intro\n" + agentLine;
    const after = baseline + "agent: response goes here\n───── MiniMax/medium ─────";
    const fixture = makeFollowDeps([baseline, after], clock);
    const expiresAt = makeFollowExpiring(clock, 250);
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      expiresAt,
      deps: fixture.deps as WaitLoopDeps,
    });
    const delta = fixture.sent.find((m) => m.text.includes("agent: response goes here"));
    expect(delta).toBeDefined();
    expect(delta!.text).not.toContain("old intro");
    expect(delta!.text).not.toContain("agent: finished");
  });

  it("emits the suffix delta even when both reads share a trailing status bar (regression: endsWith branch)", async () => {
    const clock = makeFakeClock(0);
    const statusBar = "─── MiniMax/medium ───";
    const baseline = statusBar + "\nold intro line 1\nold intro line 2\n";
    const after = baseline + "agent: hello\n";
    const fixture = makeFollowDeps([baseline, after], clock);
    const expiresAt = makeFollowExpiring(clock, 250);
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      expiresAt,
      deps: fixture.deps as WaitLoopDeps,
    });
    const delta = fixture.sent.find((m) => m.text.includes("agent: hello"));
    expect(delta).toBeDefined();
    expect(delta!.text).not.toContain("old intro");
  });

  it("keeps polling even when readPane throws (no crash, no emission)", async () => {
    const clock = makeFakeClock(0);
    let readCalls = 0;
    const sent: Array<{ chatId: number; threadId: number; text: string }> = [];
    const deps: Partial<WaitLoopDeps> = {
      readPane: () => {
        readCalls++;
        if (readCalls === 1) return "stable content\n";
        if (readCalls === 2) throw new Error("herdr unavailable");
        return "stable content\nnew line";
      },
      sendMessage: async (chatId, threadId, text) => {
        sent.push({ chatId, threadId, text });
        return sent.length;
      },
      sleep: async (ms: number) => { clock.advance(ms); },
      now: clock.now,
      sendText: () => {},
    };
    const expiresAt = makeFollowExpiring(clock, 250);
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      expiresAt,
      deps: deps as WaitLoopDeps,
    });
    const deltas = sent.filter((m) => !m.text.startsWith("⏳ Working"));
    expect(deltas.some((m) => m.text.includes("new line"))).toBe(true);
  });

  it("stops polling and emits `👋 Follow cancelled.` when the AbortSignal fires", async () => {
    const clock = makeFakeClock(0);
    const controller = new AbortController();
    let readCalls = 0;
    const fixture = makeFollowDeps(["start\n", "start\nsecond", "start\nsecond\nthird"], clock);
    const deps: Partial<WaitLoopDeps> = {
      readPane: () => {
        readCalls++;
        return fixture.paneSequence[Math.min(readCalls - 1, fixture.paneSequence.length - 1)];
      },
      sendMessage: async (chatId, threadId, text) => {
        fixture.sent.push({ chatId, threadId, text });
        return fixture.sent.length;
      },
      sleep: async (ms: number) => {
        clock.advance(ms);
        if (readCalls >= 2 && !controller.signal.aborted) controller.abort();
      },
      now: clock.now,
      sendText: () => {},
    };
    const expiresAt = () => null; // manual mode
    await runAgentFollowLoop({
      paneId: "w1:pZ",
      threadId: 140,
      cfg: makeCfg(100),
      tg: {} as any,
      chatId: 100,
      expiresAt,
      signal: controller.signal,
      deps,
    });
    expect(fixture.sent.some((m) => m.text.includes("Follow cancelled"))).toBe(true);
  });
});

