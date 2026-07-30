/**
 * Cumulative end-to-end coverage for non-OpenCode structured readers.
 *
 * Proves that `runObserveLoop` (the Working-mode polling loop) operates
 * correctly when paired with `PiJsonlReader` and `CodexJsonlReader`. The
 * structured readers are selected by the registry based on agent name
 * (pi/omp → pi-jsonl, codex → codex-jsonl); this test exercises the
 * full pipeline by:
 *
 *   1. Writing a JSONL with one assistant message (the historical
 *      baseline).
 *   2. Starting the loop, which seeds its rolling `sentTail` from the
 *      file. No historic replay is emitted as a delta.
 *   3. Appending a second assistant message mid-loop (the agent
 *      producing fresh output).
 *   4. Asserting that subsequent polls emit the unseen "second" content
 *      as a delta chunk — and crucially do NOT emit the historical
 *      "first" content again.
 *   5. Asserting the loop finalises after the stability window elapses.
 *
 * `readPane` is wired to THROW — if any structured read path
 * accidentally downgrades to scrape, the test fails immediately.
 *
 * Timing is controlled via injected `now` + `sleep` (the same pattern
 * used by `tests/observe-cumulative.test.ts`): the loop awaits sleep
 * promises queued in a `pending` array, and the test resolves them
 * one-by-one while advancing a fake clock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runObserveLoop,
  type ObserveOutputFormatter,
  type RunObserveLoopOptions,
} from "../../src/observe-loop.js";
import { createAgentCommunicator } from "../../src/agent-sessions.js";
import type { TelegramClient } from "../../src/telegram-client.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

/** Render a single pi-style assistant message line for the JSONL file. */
function piLine(text: string, ts = "2026-01-01T00:00:00.000Z"): string {
  return JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";
}

/** Render a single codex-style rollout assistant message line. */
function codexLine(text: string, ts = "2026-01-01T00:00:00.000Z"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
  }) + "\n";
}

/**
 * Build a deterministic observe-loop harness. The caller provides the
 * session file path, the agent name (pi/codex), and the initial JSONL
 * content. Returns a small object exposing `sent`, `pending`, `append`
 * and `drive` so the test can stage content growth between ticks and
 * step the loop forward one pending sleep at a time.
 */
interface DriveHandle {
  /** Every message the loop pushed to the mocked Telegram client. */
  sent: { text: string }[];
  /** Outstanding sleep resolvers. The test shifts one per drive tick. */
  pending: Array<() => void>;
  /** Append content to the JSONL file (mimics agent producing output). */
  append: (content: string) => void;
  /** Run the loop, advancing the fake clock by 50ms per pending sleep,
   *  and stop once the loop finalises or after `maxIter` ticks. */
  drive: (maxIter?: number) => Promise<void>;
  /** Reader kind selected by the registry. Useful for sanity asserts. */
  readerKind: string;
}

function setupDrive(opts: {
  agentName: "pi" | "codex";
  sessionPath: string;
  initialContent: string;
  stabilityMs?: number;
}): DriveHandle {
  const stabilityMs = opts.stabilityMs ?? 200;
  const clock = fakeClock(0);
  const sent: { text: string }[] = [];
  const pending: Array<() => void> = [];

  writeFileSync(opts.sessionPath, opts.initialContent, "utf8");

  const communicator = createAgentCommunicator({
    paneId: "w1:p1",
    getAgentInfo: () => ({
      agent: opts.agentName,
      agent_status: "busy",
      pane_id: "w1:p1",
      tab_id: "",
      workspace_id: "",
      agent_session: { kind: "path", path: opts.sessionPath },
    }),
    readPane: () => {
      throw new Error("readPane must not be called for structured agent");
    },
    logger,
  });

  const output: ObserveOutputFormatter = {
    workingTick: () => "TICK",
    paneDelta: (d) => d,
    finalMessage: (t) => `[final] ${t}`,
  };

  const loopOpts: RunObserveLoopOptions = {
    paneId: "w1:p1",
    threadId: 1,
    cfg: {
      progressIntervalMs: 50,
      botToken: "x",
      chatId: 0,
      throttleMs: 0,
      waitTimeoutS: 0,
      maxTotalWaitS: 0,
      maxProgressUpdates: -1,
      stabilityWindowMs: stabilityMs,
      followTimeoutMinutes: 0,
      opencodeIncludeTools: false,
      opencodeIncludeThoughts: false,
    } as RunObserveLoopOptions["cfg"],
    tg: {} as TelegramClient,
    chatId: 100,
    stopCondition: { kind: "idle", stabilityMs },
    output,
    communicator,
    deps: {
      sendMessage: async (_c, _t, text) => {
        sent.push({ text });
        return 1;
      },
      sleep: () => new Promise<void>((resolve) => pending.push(resolve)),
      now: clock.now,
    },
  };

  // Start the loop now. It runs synchronously up to its first
  // `await deps.sleep(...)`, which queues a resolver in `pending`. By the
  // time setupDrive returns, `pending.length === 1` and the initial
  // snapshot has been read.
  let loopPromise: Promise<void> = runObserveLoop(loopOpts);

  return {
    sent,
    pending,
    append: (content: string) => {
      appendFileSync(opts.sessionPath, content, "utf8");
    },
    async drive(maxIter = 30) {
      let idleSpins = 0;
      for (let i = 0; i < maxIter; i++) {
        let spins = 0;
        while (pending.length === 0) {
          await Promise.resolve();
          if (++spins > 20) break;
        }
        if (pending.length === 0) {
          if (++idleSpins > 3) break;
          continue;
        }
        idleSpins = 0;
        const next = pending.shift();
        if (!next) break;
        clock.advance(50);
        next();
        // Yield so the loop's await sendMessage microtasks drain and the
        // next sleep is queued before the next iteration.
        await Promise.resolve();
        if (sent.some((m) => m.text.startsWith("[final]"))) break;
      }
      await loopPromise;
    },
    readerKind: communicator.readerKind,
  };
}

describe("observe-loop — pi cumulative reader end-to-end", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "observe-pi-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("selects the pi-jsonl reader (no readPane)", () => {
    const sessionPath = join(dir, "session.jsonl");
    writeFileSync(sessionPath, piLine("seed"), "utf8");
    const communicator = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "busy",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      readPane: () => {
        throw new Error("readPane must not be called for structured agent");
      },
      logger,
    });
    expect(communicator.readerKind).toBe("pi-jsonl");
    expect(communicator.getAgentOutput(100)).toBe("seed");
  });

  it("streams only the unseen assistant message as a delta after the file grows", async () => {
    const sessionPath = join(dir, "session.jsonl");
    const state = setupDrive({
      agentName: "pi",
      sessionPath,
      initialContent: piLine("first", "2026-01-01T00:00:00.000Z"),
    });

    expect(state.readerKind).toBe("pi-jsonl");

    // Wait for the loop's first sleep to be queued. By then the initial
    // snapshot has been read and sentTail seeded with "first".
    let spins = 0;
    while (state.pending.length === 0 && spins++ < 50) {
      await Promise.resolve();
    }
    expect(state.pending.length).toBeGreaterThan(0);

    // Resolve one tick: first poll reads "first", no change yet, emits TICK.
    state.pending.shift()!();
    await Promise.resolve();

    // Append the second message — the file now contains both messages.
    state.append(piLine("second", "2026-01-01T00:00:01.000Z"));

    // Drive the loop to completion. Subsequent polls see the change and
    // emit "second" as a delta; once the snapshot is stable, the loop
    // finalises with a [final] recap.
    await state.drive();

    // The "second" content must surface in some non-final message. The
    // final may also include it (uses the last-delta fallback).
    const deltaMessages = state.sent.filter((m) => !m.text.startsWith("[final]"));
    expect(deltaMessages.some((m) => m.text.includes("second"))).toBe(true);

    // "first" must NOT appear anywhere — it was seeded into sentTail
    // and never re-emitted. The final uses lastDeltaText (= "second"),
    // so it doesn't contain "first" either.
    expect(state.sent.every((m) => !m.text.includes("first"))).toBe(true);

    // The loop finalised.
    expect(state.sent.some((m) => m.text.startsWith("[final]"))).toBe(true);
  });
});

describe("observe-loop — codex cumulative reader end-to-end", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "observe-codex-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("selects the codex-jsonl reader (no readPane)", () => {
    const sessionPath = join(dir, "rollout.jsonl");
    writeFileSync(sessionPath, codexLine("seed"), "utf8");
    const communicator = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "codex",
        agent_status: "busy",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      readPane: () => {
        throw new Error("readPane must not be called for structured agent");
      },
      logger,
    });
    expect(communicator.readerKind).toBe("codex-jsonl");
    expect(communicator.getAgentOutput(100)).toBe("seed");
  });

  it("streams only the unseen rollout assistant message as a delta after the file grows", async () => {
    const sessionPath = join(dir, "rollout.jsonl");
    const state = setupDrive({
      agentName: "codex",
      sessionPath,
      initialContent: codexLine("first", "2026-01-01T00:00:00.000Z"),
    });

    expect(state.readerKind).toBe("codex-jsonl");

    let spins = 0;
    while (state.pending.length === 0 && spins++ < 50) {
      await Promise.resolve();
    }
    expect(state.pending.length).toBeGreaterThan(0);

    state.pending.shift()!();
    await Promise.resolve();

    state.append(codexLine("second", "2026-01-01T00:00:01.000Z"));

    await state.drive();

    const deltaMessages = state.sent.filter((m) => !m.text.startsWith("[final]"));
    expect(deltaMessages.some((m) => m.text.includes("second"))).toBe(true);

    expect(state.sent.every((m) => !m.text.includes("first"))).toBe(true);

    expect(state.sent.some((m) => m.text.startsWith("[final]"))).toBe(true);
  });
});
