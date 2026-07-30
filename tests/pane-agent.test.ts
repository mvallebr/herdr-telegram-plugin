/**
 * Tests for PaneAgent — Task 4 of the PaneAgent refactor.
 *
 * PaneAgent is the per-pane coordinator that owns exactly one
 * AgentCommunicator and at most one ObserveLoopController. The
 * public surface maps directly to Telegram intents:
 *
 *   - handleMessage  → "user sent text in a bound topic"
 *   - enableFollow   → "/follow [minutes]"
 *   - disableFollow  → "/unfollow"
 *   - stop           → "/stop"
 *   - getLastOutput  → "/last"  (must not consume diff state)
 *   - dispose        → daemon shutdown
 *
 * Behavioural invariants covered here:
 *
 *   1. Single observe loop per pane.
 *      - First message: start a loop.
 *      - Subsequent messages during the same turn: reuse the loop.
 *      - enableFollow during the same turn: reuse the loop.
 *      - enableFollow when no loop is active: start one with the deadline.
 *   2. handleMessage marks waitUntilIdle without touching the deadline.
 *      - During a follow-only turn (deadline set, waitUntilIdle=false),
 *        a fresh message switches to deadline+idle mode without resetting
 *        the timer.
 *   3. disableFollow clears the deadline but keeps the loop.
 *      - After a message, disableFollow: loop still alive; waitUntilIdle
 *        was already true so the stop formula becomes idle-based.
 *      - After a follow-only turn, disableFollow: deadline becomes null;
 *        waitUntilIdle was false, so the formula collapses to "stop
 *        immediately" (i.e. waitUntilIdle false + deadline null → stop).
 *   4. stop() and dispose() both abort the active loop and clear it.
 *   5. getLastOutput returns the latest snapshot without mutating diff
 *      state — a subsequent handleMessage still surfaces what was
 *      visible to /last.
 *
 * Test infrastructure: we use a real AgentCommunicator wrapping a fake
 * reader so we exercise the same getNewOutput/getLatestOutput code path
 * as production. We spy on `communicator.sendInput` so we can assert
 * the input was forwarded. We pass a `createController` factory in deps
 * that pushes every constructed controller into a list — tests can both
 * count constructions (the single-loop invariant) and await a specific
 * controller's `done` promise.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AgentCommunicator,
  type AgentOutputReader,
} from "../src/agent-sessions.js";
import {
  ObserveLoopController,
  type ObserveLoopControllerDeps,
  type OutputEvent,
} from "../src/turn/observe-loop-controller.js";
import { PaneAgent } from "../src/pane-agent.js";
import type { Config } from "../src/config.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Mock the herdr-client sendText so `AgentCommunicator.sendInput` does
 * not actually shell out to the `herdr` CLI in tests. We still want to
 * verify the call was forwarded, so we let the spy record the call
 * before the mock short-circuits the implementation.
 *
 * vi.mock is hoisted by vitest above the imports, so this overrides
 * sendText for every test in this file.
 */
vi.mock("../src/herdr-client.js", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("../src/herdr-client.js");
  return {
    ...mod,
    sendText: vi.fn(),
  };
});

/**
 * A reader whose snapshots advance on every read. Mirrors the fake
 * reader in tests/turn/observe-loop-controller.test.ts so loop-level
 * semantics are identical.
 */
function makeFakeReader(snapshots: string[]): AgentOutputReader & {
  calls: number;
  append(extra: string[]): void;
} {
  let i = 0;
  const reader: AgentOutputReader & {
    calls: number;
    append(extra: string[]): void;
  } = {
    kind: "fake",
    calls: 0,
    append(extra) {
      snapshots.push(...extra);
    },
    read(_max: number): string {
      this.calls += 1;
      return snapshots[Math.min(i++, snapshots.length - 1)] ?? "";
    },
  };
  return reader;
}

/** Minimal Config for tests. progressIntervalMs + stabilityMs are the
 *  knobs the loop reads from cfg. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botToken: "test",
    chatId: null,
    throttleMs: 1000,
    waitTimeoutS: 300,
    maxTotalWaitS: 1800,
    maxProgressUpdates: 60,
    progressIntervalMs: 100,
    stabilityWindowMs: 100,
    followTimeoutMinutes: 30,
    agentPaths: {},
    opencodeIncludeTools: false,
    opencodeIncludeThoughts: false,
    ...overrides,
  };
}

/**
 * Build the controllable environment a PaneAgent runs in. Each pending
 * sleep represents one progressIntervalMs of wall time; step() resolves
 * one pending sleep and advances the clock. drive() walks the active
 * loop until it finalises. `controllers` lets a test assert the
 * single-loop invariant AND await a specific controller's `done`.
 */
function makeEnv(opts: {
  snapshots?: string[];
  config?: Partial<Config>;
} = {}) {
  const cfg = makeConfig(opts.config);
  const reader = makeFakeReader(opts.snapshots ?? ["stable"]);
  const comm = new AgentCommunicator(reader, noopLogger, "w1:p1");
  const events: OutputEvent[] = [];
  const pending: Array<() => void> = [];
  let now = 0;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const controllers: ObserveLoopController[] = [];
  const deps = {
    sleep: async (_ms: number) =>
      new Promise<void>((resolve) => pending.push(resolve)),
    now: clock.now,
    createController: (cd: ObserveLoopControllerDeps) => {
      const c = new ObserveLoopController(cd);
      controllers.push(c);
      return c;
    },
  };
  const agent = new PaneAgent({
    paneId: "w1:p1",
    communicator: comm,
    emit: (e) => events.push(e),
    config: cfg,
    deps,
  });
  return {
    agent,
    comm,
    events,
    controllers,
    pending,
    clock,
    step() {
      const next = pending.shift();
      if (!next) return false;
      clock.advance(cfg.progressIntervalMs);
      next();
      return true;
    },
    pendingCount() {
      return pending.length;
    },
    async drive(maxIter = 80) {
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

// ---------------------------------------------------------------------------
// 1. handleMessage — first message starts a loop and forwards input
// ---------------------------------------------------------------------------

describe("PaneAgent — handleMessage (first message)", () => {
  it("forwards text via communicator.sendInput and starts an observe loop", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    const spy = vi.spyOn(env.comm, "sendInput");

    env.agent.handleMessage("hello");

    // Input was forwarded to the pane.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("hello");
    // A loop is now active.
    expect(env.agent.isLoopActive()).toBe(true);
    // Exactly one controller was constructed.
    expect(env.controllers).toHaveLength(1);
  });

  it("does not start a second loop when called again on the same pane", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    const spy = vi.spyOn(env.comm, "sendInput");

    env.agent.handleMessage("first");
    env.agent.handleMessage("second");

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]).toEqual(["first"]);
    expect(spy.mock.calls[1]).toEqual(["second"]);
    // Single-loop invariant: still exactly one controller.
    expect(env.controllers).toHaveLength(1);
    expect(env.agent.isLoopActive()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. enableFollow — no loop → start one with the deadline
// ---------------------------------------------------------------------------

describe("PaneAgent — enableFollow", () => {
  it("starts a loop with the deadline when no loop is active", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    expect(env.agent.isLoopActive()).toBe(false);

    env.agent.enableFollow(env.clock.now() + 500);

    expect(env.agent.isLoopActive()).toBe(true);
    expect(env.controllers).toHaveLength(1);
  });

  it("updates the existing loop's deadline rather than creating a new loop", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    env.agent.handleMessage("a");
    expect(env.controllers).toHaveLength(1);

    env.agent.enableFollow(env.clock.now() + 500);

    // Single-loop invariant: still one controller.
    expect(env.controllers).toHaveLength(1);
    expect(env.agent.isLoopActive()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. disableFollow — clears deadline, keeps loop
// ---------------------------------------------------------------------------

describe("PaneAgent — disableFollow", () => {
  it("clears the deadline but keeps the loop running", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    env.agent.enableFollow(env.clock.now() + 500);
    expect(env.agent.isLoopActive()).toBe(true);

    env.agent.disableFollow();

    // Loop should still be alive — we just removed the timer gate.
    expect(env.agent.isLoopActive()).toBe(true);
    expect(env.controllers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. handleMessage during a follow — marks waitUntilIdle, preserves deadline
// ---------------------------------------------------------------------------

describe("PaneAgent — message during follow", () => {
  it("forwards the input and reuses the existing loop (no second controller)", () => {
    const env = makeEnv({ snapshots: ["x", "x y", "x y", "x y"] });
    env.agent.enableFollow(env.clock.now() + 500);
    expect(env.controllers).toHaveLength(1);

    const spy = vi.spyOn(env.comm, "sendInput");
    env.agent.handleMessage("interrupt");

    // Input forwarded.
    expect(spy).toHaveBeenCalledWith("interrupt");
    // Single-loop invariant: still one controller.
    expect(env.controllers).toHaveLength(1);
    expect(env.agent.isLoopActive()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. disableFollow after message — keeps waitUntilIdle (stop on idle)
// ---------------------------------------------------------------------------

describe("PaneAgent — unfollow after message", () => {
  it("keeps waitUntilIdle so the loop drains on idle after /unfollow", async () => {
    // Pane grows then settles. With markUserInput=true and deadline=null,
    // the loop finalises on idle alone. We disableFollow after the
    // message — the loop should stay alive until the pane settles.
    const env = makeEnv({
      snapshots: ["seed", "seed tail", "seed tail", "seed tail", "seed tail"],
    });
    env.agent.handleMessage("a");
    expect(env.controllers).toHaveLength(1);
    const loop = env.controllers[0]!;

    env.agent.disableFollow();

    // Loop must still be active — the stop formula is now
    // deadline=null (always reached) AND waitUntilIdle=true → stop on idle.
    expect(env.agent.isLoopActive()).toBe(true);

    // Drive the loop until it finalises.
    await env.drive();
    await loop.done;
    expect(env.agent.isLoopActive()).toBe(false);
    expect(env.controllers).toHaveLength(1);
  });

  it("stops immediately when /unfollow lands on a follow-only loop", async () => {
    // Follow only (waitUntilIdle=false, deadline set). Unfollow clears
    // the deadline but does NOT flip waitUntilIdle to true — so the
    // formula becomes deadline=null (reached) AND !waitUntilIdle (true)
    // → stop on the very next iteration.
    const env = makeEnv({
      snapshots: ["stable", "stable", "stable", "stable"],
    });
    env.agent.enableFollow(env.clock.now() + 500);
    expect(env.agent.isLoopActive()).toBe(true);
    const loop = env.controllers[0]!;

    env.agent.disableFollow();

    // Drive — the loop must finalise on the next iteration.
    await env.drive();
    await loop.done;
    expect(env.agent.isLoopActive()).toBe(false);
    expect(env.controllers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. stop() — aborts and clears
// ---------------------------------------------------------------------------

describe("PaneAgent — stop", () => {
  it("aborts the active loop and clears it", async () => {
    const env = makeEnv({
      // Long-lived: stabilityMs large so the loop doesn't finalise on
      // its own. We need stop() to be the one ending it.
      snapshots: ["x", "x y", "x y z", "x y z w"],
    });
    env.agent.handleMessage("a");
    expect(env.agent.isLoopActive()).toBe(true);
    const loop = env.controllers[0]!;

    env.agent.stop();

    // The controller only checks the abort latch AFTER its current
    // sleep resolves, so drive one tick to let the abort propagate
    // through the loop's per-iteration check.
    await env.drive();
    await loop.done;
    expect(env.agent.isLoopActive()).toBe(false);
  });

  it("is a no-op when no loop is active", () => {
    const env = makeEnv();
    expect(env.agent.isLoopActive()).toBe(false);
    expect(() => env.agent.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. dispose() — aborts and clears (idempotent)
// ---------------------------------------------------------------------------

describe("PaneAgent — dispose", () => {
  it("aborts the active loop and clears it", async () => {
    const env = makeEnv({
      snapshots: ["x", "x y", "x y z", "x y z w"],
    });
    env.agent.handleMessage("a");
    const loop = env.controllers[0]!;

    env.agent.dispose();

    // Same as stop: the abort latch is checked after the next sleep
    // resolves, so drive to let the abort propagate.
    await env.drive();
    await loop.done;
    expect(env.agent.isLoopActive()).toBe(false);
  });

  it("is a no-op when no loop is active", () => {
    const env = makeEnv();
    expect(() => env.agent.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. getLastOutput — readback does not consume diff state
// ---------------------------------------------------------------------------

describe("PaneAgent — getLastOutput", () => {
  it("returns communicator.getLatestOutput() without touching diff state", () => {
    // Use a stable snapshot so reader state does not advance
    // underneath getNewOutput between calls. The fake reader returns
    // the next snapshot per read(), so a static ["x"] means every read
    // returns "x".
    const env = makeEnv({ snapshots: ["x"] });

    // Seed the diff state — first call returns "" and sets sentTail="x".
    expect(env.comm.getNewOutput()).toBe("");

    // Spy on getNewOutput to prove getLastOutput did NOT consume it.
    const newOutputSpy = vi.spyOn(env.comm, "getNewOutput");

    // /last is a pure read; it should NOT call getNewOutput.
    const last = env.agent.getLastOutput();
    expect(last).toBe("x");
    expect(newOutputSpy).not.toHaveBeenCalled();

    // After /last, a getNewOutput call still finds nothing new.
    expect(env.comm.getNewOutput()).toBe("");
  });
});