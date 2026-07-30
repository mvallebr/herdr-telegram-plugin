import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runObserveLoop,
  type ObserveOutputFormatter,
  type RunObserveLoopOptions,
} from "../src/observe-loop.js";
import { createAgentCommunicator } from "../src/agent-sessions.js";
import type { TelegramClient } from "../src/telegram-client.js";

// Build a controllable clock so tests don't have to await real sleep timers.
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

// A fake getAgentOutput that returns whatever sequence the test set up. Each item
// is one poll; empty string = "no content yet".
function makeGetAgentOutput(sequence: string[]) {
  let i = 0;
  return (_paneId: string, _maxLines: number) => sequence[Math.min(i++, sequence.length - 1)] ?? "";
}

// Build a communicator + deps with a configurable pane sequence and message log.
// sleep() queues promises; the test resolves them via step(). This lets
// the loop drive itself through iterations without real-time waits.
function makeDeps(sequence: string[], clock: ReturnType<typeof fakeClock>) {
  const sent: { text: string; opts?: { disable_notification?: boolean; reply_markup?: unknown } }[] = [];
  const pending: Array<() => void> = [];
  const communicator = createAgentCommunicator({
    paneId: "w1:p1",
    getAgentInfo: () => null,  // no agent_session, so fallback to readPane
    readPane: makeGetAgentOutput(sequence),
  });
  const deps = {
    sendMessage: async (_c: number, _t: number, text: string, opts?: { disable_notification?: boolean; reply_markup?: unknown }) => {
      sent.push({ text, opts });
      return 1;
    },
    sleep: async (_ms: number) => {
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    now: clock.now,
  };
  return {
    sent,
    communicator,
    deps,
    step() {
      // Resolve one outstanding sleep and advance the clock by tickMs.
      const next = pending.shift();
      if (!next) return false;
      clock.advance(100); // matches progressIntervalMs in makeBaseOpts
      next();
      return true;
    },
    pendingCount() {
      return pending.length;
    },
    /** Drive the loop until a stop condition is met. Steps resolve one
     *  pending sleep at a time, yielding control back to the event loop so
     *  the runObserveLoop microtasks can run and exit naturally. We bail
     *  out of the drive when 3 consecutive steps produce no further
     *  pending sleeps (i.e. the loop finished). */
    async drive(maxIter = 100) {
      let idleSteps = 0;
      for (let i = 0; i < maxIter; i++) {
        // Wait for the loop to queue its next sleep.
        let spins = 0;
        while (pending.length === 0) {
          await Promise.resolve();
          if (++spins > 10) break;
        }
        if (pending.length === 0) {
          if (++idleSteps > 3) return;
          continue;
        }
        idleSteps = 0;
        this.step();
        await Promise.resolve();
      }
    },
  };
}

function makeBaseOpts(
  clock: ReturnType<typeof fakeClock>,
  sent: { text: string }[],
  stopCondition: RunObserveLoopOptions["stopCondition"],
  output: ObserveOutputFormatter,
  signal?: AbortSignal,
): RunObserveLoopOptions {
  void sent; // keep param symmetry with helper
  return {
    paneId: "w1:p1",
    threadId: 1,
    cfg: { progressIntervalMs: 100, botToken: "x", chatId: 0, throttleMs: 0, waitTimeoutS: 0, maxTotalWaitS: 0, maxProgressUpdates: -1, stabilityWindowMs: 0, followTimeoutMinutes: 0 } as RunObserveLoopOptions["cfg"],
    tg: {} as TelegramClient,
    chatId: 100,
    stopCondition,
    output,
    signal,
  };
}

describe("runObserveLoop — idle stop condition", () => {
  it("emits working tick on every iteration and finishes when pane stabilises for stabilityMs", async () => {
    const clock = fakeClock();
    // Sequence: pane grows twice, then settles.
    const sequence = ["alpha\n", "alpha beta\n", "alpha beta\n", "alpha beta\n", "alpha beta\n"];
    const f = makeDeps(sequence, clock);
    const sent = f.sent;
    let ticks = 0;
    const loop = runObserveLoop({
      ...makeBaseOpts(clock, sent, { kind: "idle", stabilityMs: 250 }, {
        workingTick: () => `⏳ Working tick ${++ticks}`,
        paneDelta: (d) => `[delta] ${d}`,
        finalMessage: (text) => `[final] ${text}`,
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;
    const workingCount = sent.filter((m) => m.text.startsWith("⏳ Working")).length;
    expect(workingCount).toBeGreaterThanOrEqual(3);
    // One delta for the first change (alpha -> alpha beta); the rest
    // are stable and only emit Working ticks.
    expect(sent.filter((m) => m.text.startsWith("[delta]"))).toHaveLength(1);
    expect(sent.filter((m) => m.text.startsWith("[final]"))).toHaveLength(1);
    // The Final consolidates what the user has been watching as a delta.
    // The new fallback uses the most recent delta instead of the raw
    // pane snapshot, so the user sees a coherent response without
    // duplicate full-pane dumps (which can blow past Telegram's 4096
    // char limit).
    const final = sent.find((m) => m.text.startsWith("[final]"));
    expect(final?.text).toContain("beta");
  });

  it("emits no extra delta when the prefix diverges (cumulative path: no anchor → no emission)", async () => {
    // After PR #11 the loop is cumulative: when no overlap exists between
    // the prior sentTail and the new snapshot, the safe action is to
    // emit nothing for the divergent content (a `(pane scrolled)` marker
    // would duplicate content the user already saw).  We assert the new
    // contract: the divergent body is still reachable via the Final
    // (which falls back to the latest snapshot for `/last`-style recap),
    // but no separate "pane scrolled" delta is emitted mid-turn.
    const clock = fakeClock();
    const sequence = ["foo\n", "completely\ndifferent\ncontent here\n"];
    const f = makeDeps(sequence, clock);
    const loop = runObserveLoop({
      ...makeBaseOpts(clock, f.sent, { kind: "idle", stabilityMs: 200 }, {
        workingTick: () => `Working tick`,
        paneDelta: (d) => `DELTA:${d}`,
        finalMessage: () => "final!",
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;
    // No `(pane scrolled)` marker — that label is gone.
    expect(f.sent.every((m) => !m.text.includes("(pane scrolled)"))).toBe(true);
    // No DELTA: prefix either — deriveUnseen returned "" and we skipped
    // emission rather than guess.
    expect(f.sent.every((m) => !m.text.startsWith("DELTA:"))).toBe(true);
  });

  it("emits an explicit aborted message and exits when the signal fires", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const sequence = ["a\n", "a b\n", "a b c\n", "a b c d\n", "a b c d e\n", "a b c d e f\n"];
    const f = makeDeps(sequence, clock);
    let ticks = 0;
    const loop = runObserveLoop({
      ...makeBaseOpts(clock, f.sent, { kind: "idle", stabilityMs: 5000 }, {
        workingTick: () => `tick ${++ticks}`,
        paneDelta: (d) => `delta: ${d}`,
        finalMessage: () => "(should not fire)",
        abortedMessage: () => "ABORTED via signal",
      }, controller.signal),
      communicator: f.communicator,
      deps: f.deps,
    });
    // Drive a few iterations, then abort and let the loop finish.
    for (let i = 0; i < 3; i++) {
      while (f.pendingCount() === 0) await Promise.resolve();
      f.step();
      await Promise.resolve();
    }
    controller.abort();
    await f.drive();
    await loop;
    expect(f.sent.filter((m) => m.text === "ABORTED via signal")).toHaveLength(1);
    expect(f.sent.filter((m) => m.text.startsWith("(should not fire)"))).toHaveLength(0);
  });
});

describe("runObserveLoop — follow stop condition", () => {
  it("emits Working with followExpiresInMs until the timer fires, then exits via finalKeyboard", async () => {
    const clock = fakeClock();
    const futureExpiry = clock.now() + 250; // will fire after ~2 ticks
    const stopCondition = {
      kind: "follow" as const,
      expiresAt: () => futureExpiry,
      onExpired: vi.fn(),
    };
    const sequence = ["same\n", "same\n", "same\n", "same\n", "same\n"];
    const f = makeDeps(sequence, clock);
    const sent = f.sent;
    const loop = runObserveLoop({
      ...makeBaseOpts(clock, sent, stopCondition, {
        workingTick: (ctx) => `tick exp=${ctx.followExpiresInMs ?? "none"}`,
        paneDelta: () => "(delta)",
        finalMessage: (text) => `[final] ${text}`,
        finalKeyboard: () => ({ inline_keyboard: [[{ text: "End", callback_data: "x" }]] }),
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;
    expect(stopCondition.onExpired).toHaveBeenCalledTimes(1);
    const lastTick = [...sent].reverse().find((m) => m.text.startsWith("tick"));
    expect(lastTick?.text).toMatch(/exp=/);
    const finalMsg = sent.find((m) => m.text.startsWith("[final]"));
    expect(finalMsg).toBeDefined();
    expect((finalMsg as any).opts?.reply_markup).toEqual({ inline_keyboard: [[{ text: "End", callback_data: "x" }]] });
  });

  it("with expiresAt=null (manual mode), keeps polling until signal aborts", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const stopCondition = {
      kind: "follow" as const,
      expiresAt: () => null as number | null,
    };
    const sequence = ["a\n", "a\n", "a\n", "a\n", "a\n"];
    const f = makeDeps(sequence, clock);
    const loop = runObserveLoop({
      ...makeBaseOpts(clock, f.sent, stopCondition, {
        workingTick: () => "tick",
        paneDelta: () => "delta",
        finalMessage: () => "(final)",
        abortedMessage: () => "(manual abort)",
      }, controller.signal),
      communicator: f.communicator,
      deps: f.deps,
    });
    // 3 ticks then abort
    for (let i = 0; i < 3; i++) {
      while (f.pendingCount() === 0) await Promise.resolve();
      f.step();
      await Promise.resolve();
    }
    controller.abort();
    await f.drive();
    await loop;
    expect(f.sent.filter((m) => m.text === "(manual abort)")).toHaveLength(1);
  });
});

describe("runObserveLoop — output formatter hooks", () => {
  it("invokes workingKeyboard on every Working tick and finalKeyboard on the final", async () => {
    const clock = fakeClock();
    const kbHooks: unknown[] = [];
    const sequence = ["x\n", "x\n", "x\n"];
    const f = makeDeps(sequence, clock);
    const loop = runObserveLoop({
      ...makeBaseOpts(clock, f.sent, { kind: "idle", stabilityMs: 200 }, {
        workingTick: () => "tick",
        paneDelta: () => "delta",
        finalMessage: () => "final",
        workingKeyboard: () => {
          kbHooks.push({ kind: "working" });
          return { inline_keyboard: [[{ text: "Stop", callback_data: "act:stop:1" }]] };
        },
        finalKeyboard: () => {
          kbHooks.push({ kind: "final" });
          return { inline_keyboard: [[{ text: "Follow 5m", callback_data: "act:follow:5:1" }]] };
        },
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;
    expect(kbHooks.some((h) => JSON.stringify(h).includes("working"))).toBe(true);
    expect(kbHooks.some((h) => JSON.stringify(h).includes("final"))).toBe(true);
    const workingMsgs = f.sent.filter((m) => m.text === "tick");
    for (const m of workingMsgs) {
      expect((m as any).opts?.reply_markup).toEqual({ inline_keyboard: [[{ text: "Stop", callback_data: "act:stop:1" }]] });
    }
    const finalMsg = f.sent.find((m) => m.text === "final");
    expect((finalMsg as any).opts?.reply_markup).toEqual({ inline_keyboard: [[{ text: "Follow 5m", callback_data: "act:follow:5:1" }]] });
  });

  it("falls back to the last delta when the agent clears the pane before stabilising", async () => {
    // Real-world pattern: pi/codex erase the screen after responding. The
    // lastSnapshot at stability is empty, but the user has been watching
    // the response appear as a delta — the Final must echo that delta so
    // they have a stable, persisted record in the chat.
    const clock = fakeClock();
    const sequence = [
      "intro line\n",
      "intro line\nagent response part 1\n",  // grows
      "",                                       // agent cleared the pane
      "",                                       // stable
      "",
    ];
    const f = makeDeps(sequence, clock);
    const loop = runObserveLoop({
      ...makeBaseOpts(clock, f.sent, { kind: "idle", stabilityMs: 100 }, {
        workingTick: () => "tick",
        paneDelta: (delta) => `[delta] ${delta}`,
        finalMessage: (text) => `[final] ${text}`,
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;
    const finalMsg = f.sent.find((m) => m.text.startsWith("[final]"));
    expect(finalMsg).toBeDefined();
    // The empty pane at stability must NOT have wiped the Final — the
    // last non-empty delta is the fallback.
    expect(finalMsg?.text).toContain("agent response part 1");
  });
});

// --- Structured-source test -----------------------------------------------
//
// Verifies that when a structured session is selected at construction,
// runObserveLoop never falls back to readPane. The pane is mutated to throw
// if the loop tries to read it.

describe("runObserveLoop — structured reader is source-agnostic", () => {
  it("never calls readPane when the communicator selects a jsonl reader", async () => {
    // Set up a temp jsonl with two growing assistant replies.
    const tmpDir = mkdtempSync(join(tmpdir(), "ol-structured-"));
    const sessionPath = join(tmpDir, "session.jsonl");
    // We bake ONE assistant line; the structured reader will keep returning
    // the same text — so no deltas will be emitted. To exercise the
    // delta path we mutate the file between ticks via the same method the
    // agent would use. For this test we only need to confirm:
    //   * readPane is never called
    //   * the final message content (when present) is the structured text.
    writeFileSync(
      sessionPath,
      JSON.stringify({
        type: "message",
        timestamp: "2026-07-30T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "structured answer" }],
        },
      }) + "\n",
      "utf8",
    );

    const clock = fakeClock();
    const sent: { text: string }[] = [];
    const pending: Array<() => void> = [];
    let readPaneCalls = 0;
    let tickCount = 0;

    const communicator = createAgentCommunicator({
      paneId: "w1:pX",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:pX",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      // If this is ever called, throw — we'd lose test signal.
      readPane: () => {
        readPaneCalls += 1;
        throw new Error("readPane called while structured reader is selected");
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const loop = runObserveLoop({
      paneId: "w1:pX",
      threadId: 1,
      cfg: {
        progressIntervalMs: 100, botToken: "x", chatId: 0,
        throttleMs: 0, waitTimeoutS: 0, maxTotalWaitS: 0,
        maxProgressUpdates: -1, stabilityWindowMs: 0, followTimeoutMinutes: 0,
      } as RunObserveLoopOptions["cfg"],
      tg: {} as TelegramClient,
      chatId: 100,
      stopCondition: { kind: "idle", stabilityMs: 200 },
      output: {
        workingTick: () => "tick",
        paneDelta: (d) => `[delta] ${d}`,
        finalMessage: (t) => `[final] ${t}`,
      },
      communicator,
      deps: {
        sendMessage: async (_c: number, _t: number, text: string) => {
          sent.push({ text });
          tickCount++;
          return 1;
        },
        sleep: async () => new Promise<void>((resolve) => pending.push(resolve)),
        now: clock.now,
      },
    });

    // Drive a few iterations and let the loop finish (snapshot is stable).
    let spins = 0;
    while (pending.length === 0 && spins++ < 50) await Promise.resolve();
    while (pending.length > 0) {
      clock.advance(100);
      pending.shift()!();
      await Promise.resolve();
      // After advancing, wait briefly for new sleep to be queued.
      let s2 = 0;
      while (pending.length === 0 && s2++ < 5) await Promise.resolve();
    }
    await loop;

    expect(readPaneCalls).toBe(0);
    // The final message exists and is built from the structured snapshot.
    const final = sent.find((m) => m.text.startsWith("[final]"));
    expect(final).toBeDefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves structured text that happens to end with a terminal-status pattern", async () => {
    // stripStatusBar removes trailing lines matching /^Model: / etc.
    // That must NOT happen to structured output — it belongs only on the
    // scrape path.  OpenCode / pi / codex may legitimately produce output
    // containing "Model:" — the observe loop must deliver it unchanged.
    const tmpDir = mkdtempSync(join(tmpdir(), "ol-structured-status-"));
    const sessionPath = join(tmpDir, "session.jsonl");
    const statusLikeText = "The analysis shows:\nModel: deliberately literal";
    writeFileSync(
      sessionPath,
      JSON.stringify({
        type: "message",
        timestamp: "2026-07-30T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: statusLikeText }],
        },
      }) + "\n",
      "utf8",
    );

    const clock = fakeClock();
    const sent: { text: string }[] = [];
    const pending: Array<() => void> = [];

    const communicator = createAgentCommunicator({
      paneId: "w1:pY",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:pY",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      readPane: () => { throw new Error("must not scrape"); },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const loop = runObserveLoop({
      paneId: "w1:pY",
      threadId: 1,
      cfg: {
        progressIntervalMs: 100, botToken: "x", chatId: 0,
        throttleMs: 0, waitTimeoutS: 0, maxTotalWaitS: 0,
        maxProgressUpdates: -1, stabilityWindowMs: 0, followTimeoutMinutes: 0,
      } as RunObserveLoopOptions["cfg"],
      tg: {} as TelegramClient,
      chatId: 100,
      stopCondition: { kind: "idle", stabilityMs: 200 },
      output: {
        workingTick: () => "tick",
        paneDelta: (d) => `[delta] ${d}`,
        finalMessage: (t) => `[final] ${t}`,
      },
      communicator,
      deps: {
        sendMessage: async (_c: number, _t: number, text: string) => { sent.push({ text }); return 1; },
        sleep: async () => new Promise<void>((resolve) => pending.push(resolve)),
        now: clock.now,
      },
    });

    let spins = 0;
    while (pending.length === 0 && spins++ < 50) await Promise.resolve();
    while (pending.length > 0) {
      clock.advance(200);
      pending.shift()!();
      let s2 = 0;
      while (pending.length === 0 && s2++ < 10) await Promise.resolve();
    }
    await loop;

    const final = sent.find((m) => m.text.startsWith("[final]"));
    expect(final).toBeDefined();
    // The "Model: " line must be preserved verbatim — not stripped.
    expect(final!.text).toContain("Model: deliberately literal");
    expect(final!.text).toContain("The analysis shows");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("runObserveLoop — finalize payload bounding", () => {
  it("truncates long snapshot with ellipsis prefix and bounded payload", async () => {
    const clock = fakeClock();
    // Build text > 3000 chars.
    const line = "the quick brown fox jumps over the lazy dog ";  // 46 chars
    const longText = Array.from({ length: 70 }, (_, i) => `${line}line-${i}`).join("\n");
    expect(longText.length).toBeGreaterThan(3000);

    const sequence = [longText, longText, longText];
    const f = makeDeps(sequence, clock);
    let capturedPayload = "";

    const loop = runObserveLoop({
      ...makeBaseOpts(clock, f.sent, { kind: "idle", stabilityMs: 0 }, {
        workingTick: () => "tick",
        paneDelta: () => "",
        finalMessage: (text) => {
          capturedPayload = text;
          return text;
        },
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;

    // Must have a final payload (truncated from longText).
    expect(capturedPayload.length).toBeGreaterThan(0);
    // The payload must be at or under 3000 chars.
    expect(capturedPayload.length).toBeLessThanOrEqual(3000);
    // Since original exceeded 3000, ellipsis prefix must be present.
    expect(capturedPayload.startsWith("…\n")).toBe(true);
    // Content must be from the tail of longText.
    expect(capturedPayload).toContain("line-69");
  });

  it("skips truncation when snapshot fits within limit", async () => {
    const clock = fakeClock();
    const shortText = "short final text";
    const sequence = [shortText, shortText, shortText];
    const f = makeDeps(sequence, clock);
    let capturedPayload = "";

    const loop = runObserveLoop({
      ...makeBaseOpts(clock, f.sent, { kind: "idle", stabilityMs: 0 }, {
        workingTick: () => "tick",
        paneDelta: () => "",
        finalMessage: (text) => {
          capturedPayload = text;
          return text;
        },
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;

    expect(capturedPayload).toBe(shortText);
    expect(capturedPayload).not.toContain("…");
  });
});
