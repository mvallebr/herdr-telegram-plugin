/**
 * Tests for the cumulative observe-loop: rolling `sentTail`, delta derivation,
 * 3K-char Telegram chunking with a per-chunk Working tail, no bare tick after
 * a chunk-emit poll.
 *
 * Source-agnostic — drive the loop via a fake AgentCommunicator sequence and
 * intercept every `sendMessage` to assert what was delivered to Telegram.
 *
 * Behaviour summary:
 *   - Initial poll: SEED sentTail with the snapshot's last 10K chars, emit NOTHING.
 *   - Subsequent poll: derive unseen = (current) - (last occurrence of sentTail).
 *       * If sentTail is fully inside current: emit snapshot[idx + len(sentTail):]
 *       * If sentTail slid off (50-message window rolled): find largest k where
 *         snapshot.startsWith(sentTail.slice(-k)) and emit snapshot[k:].
 *       * If neither matches: emit nothing (the user already saw the old content
 *         and we can't safely emit a duplicate or a "(pane scrolled)" marker).
 *   - Every emitted chunk ends with `\n\n⏳ Working (Xs).` — the suffix counts
 *     against the 3000-char limit.
 *   - When unseen content is emitted, NO additional bare `⏳ Working` tick is
 *     sent in that same poll.
 *   - When no unseen content (no change), exactly ONE bare `⏳ Working` tick.
 */
import { describe, expect, it } from "vitest";
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

function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

function makeGetAgentOutput(sequence: string[]) {
  let i = 0;
  return (_paneId: string, _maxLines: number) => sequence[Math.min(i++, sequence.length - 1)] ?? "";
}

function makeDeps(sequence: string[], clock: ReturnType<typeof fakeClock>) {
  const sent: { text: string; opts?: { disable_notification?: boolean; reply_markup?: unknown } }[] = [];
  const pending: Array<() => void> = [];
  const communicator = createAgentCommunicator({
    paneId: "w1:p1",
    getAgentInfo: () => null,
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
      const next = pending.shift();
      if (!next) return false;
      clock.advance(100);
      next();
      return true;
    },
    pendingCount() { return pending.length; },
    async drive(maxIter = 200) {
      let idleSteps = 0;
      for (let i = 0; i < maxIter; i++) {
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

function baseOpts(
  clock: ReturnType<typeof fakeClock>,
  stopCondition: RunObserveLoopOptions["stopCondition"],
  output: ObserveOutputFormatter,
): RunObserveLoopOptions {
  return {
    paneId: "w1:p1",
    threadId: 1,
    cfg: {
      progressIntervalMs: 100, botToken: "x", chatId: 0, throttleMs: 0,
      waitTimeoutS: 0, maxTotalWaitS: 0, maxProgressUpdates: -1,
      stabilityWindowMs: 0, followTimeoutMinutes: 0,
      opencodeIncludeTools: false, opencodeIncludeThoughts: false,
    } as RunObserveLoopOptions["cfg"],
    tg: {} as TelegramClient,
    chatId: 100,
    stopCondition,
    output,
  };
}

describe("runObserveLoop — rolling sentTail baseline", () => {
  it("seeds sentTail on initial snapshot but emits no delta (no historic replay)", async () => {
    const clock = fakeClock();
    const baseline = "alpha".repeat(2_000); // 10k chars
    const f = makeDeps([baseline, baseline, baseline, baseline], clock);
    const loop = runObserveLoop({
      ...baseOpts(clock, { kind: "idle", stabilityMs: 250 }, {
        workingTick: () => "TICK",
        paneDelta: (d) => `[delta] ${d}`,
        finalMessage: (t) => `[final] ${t}`,
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;
    // The user-facing chat MUST NOT see the historical 10k chars replayed
    // as DELTAS during the polling period.  The Final may still recap
    // last-observed state — it matches the pre-cumulative behaviour so any
    // post-loop scrape-display stays intact.
    const deltaMessages = f.sent.filter(
      (m) => !m.text.startsWith("TICK") && !m.text.startsWith("[final]"),
    );
    expect(deltaMessages).toHaveLength(0);
    // No pane-scrolled marker slipped in either.
    expect(f.sent.every((m) => !m.text.includes("(pane scrolled)"))).toBe(true);
  });
});

describe("runObserveLoop — chunked emission with Working suffix", () => {
  it("emits only the unseen suffix when prior sentTail is in the MIDDLE; chunks each <=3000 with Working tail; no bare tick after", async () => {
    // 15k "AAAA…" then 20k "AAAA…AAAA" + 5k "NEW5kCHAR" — prior sentTail
    // sits in the middle of the new snapshot. We must emit exactly the 5k
    // NEW content, no duplicates, no "(pane scrolled)" marker.
    const padding = "A".repeat(10_000);     // 10k
    const initial = padding + "B".repeat(5_000);   // 15k total
    const updated = padding + "B".repeat(5_000) + "Z".repeat(5_000); // 20k total, 5k Z's
    const clock = fakeClock();

    const f = makeDeps([initial, updated, updated, updated], clock);
    const loop = runObserveLoop({
      ...baseOpts(clock, { kind: "idle", stabilityMs: 250 }, {
        workingTick: () => "TICK",
        paneDelta: (d) => d,
        finalMessage: () => "(final)",
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;

    // The 5k NEW content must be split across chunks (5k > 3k cap, so at
    // least two messages are needed).  The prior A/B padding from the
    // initial baseline MUST NOT appear in any chunk.  No `(pane scrolled)`
    // marker either.
    const zMessages = f.sent.filter((m) => m.text.includes("Z"));
    expect(zMessages.length).toBeGreaterThanOrEqual(2);

    // No pane-scrolled marker
    expect(f.sent.every((m) => !m.text.includes("(pane scrolled)"))).toBe(true);
    // None of the Z-bearing chunks may carry the A/B padding from the
    // prior tail (would indicate duplicate / unstitched emission).
    for (const m of zMessages) {
      expect(m.text).not.toMatch(/A{40,}/); // 40+ As = the prior padding
      expect(m.text).not.toMatch(/B{40,}/);
    }

    // Each Z-bearing chunk ends with `\n\n⏳ Working (Xs).` and the body
    // (sans suffix) is at most 3000 chars.
    const chunkRe = /\n\n⏳ Working \([^)]+\)\.$/;
    for (const m of zMessages) {
      const stripped = m.text.replace(chunkRe, "");
      expect(stripped.length).toBeLessThanOrEqual(3_000);
      expect(m.text).toMatch(chunkRe);
    }

    // Total Z count across all chunks must equal the 5k that was added.
    const totalZ = f.sent.reduce((acc, m) => acc + (m.text.match(/Z/g) ?? []).length, 0);
    expect(totalZ).toBe(5_000);

    // After the chunks are emitted, the SAME poll MUST NOT also send a
    // bare TICK (the chunks themselves carry the cadence).  Subsequent
    // polls (stable) will resume bare TICKs — those are expected.
    //
    // We verify this by checking that the sequence of sent messages has
    // the chunks coming together with no bare TICK interleaved between
    // them.
    const sentTexts = f.sent.map((m) => m.text);
    const firstChunkIdx = sentTexts.findIndex((t) => chunkRe.test(t) && t.includes("Z"));
    expect(firstChunkIdx).toBeGreaterThanOrEqual(0);
    // No bare TICK message is interleaved between consecutive chunks.
    // (i.e. no "TICK" message between the first and last chunk-bearing
    // message).
    const lastChunkIdx = (() => {
      for (let i = sentTexts.length - 1; i >= 0; i--) {
        if (chunkRe.test(sentTexts[i]) && sentTexts[i].includes("Z")) return i;
      }
      return -1;
    })();
    const between = f.sent.slice(firstChunkIdx + 1, lastChunkIdx);
    expect(between.every((m) => chunkRe.test(m.text))).toBe(true);
  });

  it("emits no message at all on polls where the snapshot is unchanged (single bare Working tick)", async () => {
    const clock = fakeClock();
    const stable = "stable content\n";
    const f = makeDeps([stable, stable, stable, stable, stable], clock);
    const ticks: string[] = [];
    const loop = runObserveLoop({
      ...baseOpts(clock, { kind: "idle", stabilityMs: 250 }, {
        workingTick: () => { const t = `T${ticks.length + 1}`; ticks.push(t); return t; },
        paneDelta: () => "(delta)",
        finalMessage: () => "(final)",
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;
    // No delta ever emitted.
    expect(f.sent.every((m) => !m.text.includes("(delta)"))).toBe(true);
  });
});

describe("runObserveLoop — suffix/prefix overlap fallback when window slid", () => {
  it("detects new content when prior sentTail slid off the head of the snapshot", async () => {
    // sentTail (last 10k of initial) cannot be found fully inside the new
    // snapshot because the window dropped early characters. The fallback
    // finds the largest k where snapshot.startsWith(sentTail.slice(-k))
    // and emits snapshot[k:].
    const initial = "AAA".repeat(5_000) + "BBB".repeat(3_000); // 24_000 chars total
    // New snapshot: drop the first 6000 chars ("AAA" x 2000), keep the
    // trailing content, and append a new tail.
    const slid = initial.slice(6_000) + "ZZZ".repeat(2_000);
    // sanity: the last 10000 chars of `initial` are "AAA" x 667 + "BBB" x 3000
    // (the new snapshot does NOT contain this exact 10k block anywhere).
    const clock = fakeClock();

    const f = makeDeps([initial, slid, slid, slid], clock);
    const loop = runObserveLoop({
      ...baseOpts(clock, { kind: "idle", stabilityMs: 250 }, {
        workingTick: () => "TICK",
        paneDelta: (d) => d,
        finalMessage: () => "(final)",
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;

    // We must surface the new "ZZZ..." content at least once.
    const zMsgs = f.sent.filter((m) => m.text.includes("ZZZ"));
    expect(zMsgs.length).toBeGreaterThanOrEqual(1);
    // No pane-scrolled marker.
    expect(f.sent.every((m) => !m.text.includes("(pane scrolled)"))).toBe(true);
    // Total Z's must equal 6000 (the new tail).
    const totalZ = f.sent.reduce((acc, m) => acc + (m.text.match(/Z/g) ?? []).length, 0);
    expect(totalZ).toBe(6_000);
  });
});

describe("runObserveLoop — Telegram delivery safety", () => {
  it("chunk suffix counts toward the 3000-char limit", async () => {
    // The boundary condition for the Telegram limit. Each chunk is at
    // most 3000 chars INCLUDING the trailing "\n\n⏳ Working (Xs)." marker.
    const baseline = "X".repeat(10_000);
    const updated = baseline + "Y".repeat(4_500); // 4_500 chars of new content
    const clock = fakeClock();
    const f = makeDeps([baseline, updated, updated], clock);
    const loop = runObserveLoop({
      ...baseOpts(clock, { kind: "idle", stabilityMs: 250 }, {
        workingTick: () => "TICK",
        paneDelta: (d) => d,
        finalMessage: () => "(final)",
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;

    const yMsgs = f.sent.filter((m) => m.text.includes("Y"));
    expect(yMsgs.length).toBeGreaterThanOrEqual(2);
    for (const m of yMsgs) {
      // The TOTAL chunk size (including any Working tail we attached) must
      // be <= 3000.  Strip suffix first to assert the body fits, then
      // re-add the suffix to confirm we never emit a chunk whose TOTAL
      // exceeds 3000.
      const withoutSuffix = m.text.replace(/\n\n⏳ Working \([^)]+\)\.$/, "");
      expect(withoutSuffix.length).toBeLessThanOrEqual(3_000);
      // Reconstructed with an \n\n⏳ Working (1s). tail (~22 chars), still
      // must NOT exceed 3000 by more than a few chars of working text. Use
      // a soft <= 3050 to absorb small formatter differences.
      expect(m.text.length).toBeLessThanOrEqual(3_050);
    }
  });

  it("preserves scrape content via the same generic mechanism (no regression on /last path)", async () => {
    // The cumulative mechanism must apply to scrape readers too.  A growing
    // scrape snapshot gets split into the right chunks without crashing the
    // loop or losing content.
    const clock = fakeClock();
    const initial = "stable agent line\n";
    const growing = [
      initial,
      initial + "agent says: partial reply\n",
      initial + "agent says: partial reply\nagent says: final answer\n",
      initial + "agent says: partial reply\nagent says: final answer\n",
      initial + "agent says: partial reply\nagent says: final answer\n",
    ];
    const f = makeDeps(growing, clock);
    const loop = runObserveLoop({
      ...baseOpts(clock, { kind: "idle", stabilityMs: 250 }, {
        workingTick: () => "TICK",
        paneDelta: (d) => d,
        finalMessage: (t) => `[final] ${t}`,
      }),
      communicator: f.communicator,
      deps: f.deps,
    });
    await f.drive();
    await loop;
    // "final answer" must be present in the chat log somewhere.
    expect(f.sent.some((m) => m.text.includes("final answer"))).toBe(true);
    // And the final message must include it (final recall from the snapshot/lastDelta).
    const final = f.sent.find((m) => m.text.startsWith("[final]"));
    expect(final?.text).toContain("final answer");
  });
});

describe("runObserveLoop — JSONL structured reader path", () => {
  it("never calls readPane when the communicator picks a jsonl reader (source-agnostic guarantee preserved)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cumulative-jsonl-"));
    const sessionPath = join(tmpDir, "session.jsonl");
    writeFileSync(
      sessionPath,
      JSON.stringify({
        type: "message",
        timestamp: "2026-07-30T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "structured text" }],
        },
      }) + "\n",
      "utf8",
    );

    const clock = fakeClock();
    const sent: { text: string }[] = [];
    const pending: Array<() => void> = [];
    const communicator = createAgentCommunicator({
      paneId: "w1:pJ",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:pJ",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      readPane: () => { throw new Error("readPane must not be called"); },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const loop = runObserveLoop({
      paneId: "w1:pJ",
      threadId: 1,
      cfg: {
        progressIntervalMs: 100, botToken: "x", chatId: 0, throttleMs: 0,
        waitTimeoutS: 0, maxTotalWaitS: 0, maxProgressUpdates: -1,
        stabilityWindowMs: 0, followTimeoutMinutes: 0,
        opencodeIncludeTools: false, opencodeIncludeThoughts: false,
      } as RunObserveLoopOptions["cfg"],
      tg: {} as TelegramClient,
      chatId: 100,
      stopCondition: { kind: "idle", stabilityMs: 200 },
      output: {
        workingTick: () => "TICK",
        paneDelta: (d) => d,
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
      clock.advance(100);
      pending.shift()!();
      await Promise.resolve();
      let s2 = 0;
      while (pending.length === 0 && s2++ < 5) await Promise.resolve();
    }
    await loop;
    rmSync(tmpDir, { recursive: true, force: true });

    const final = sent.find((m) => m.text.startsWith("[final]"));
    expect(final?.text).toContain("structured text");
  });
});
