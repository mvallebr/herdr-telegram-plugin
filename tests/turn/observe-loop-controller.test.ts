/**
 * Tests for ObserveLoopController — Task 3 of the PaneAgent refactor.
 *
 * Coverage matrix (mirrors the plan):
 *   - baseline does NOT emit (first call to communicator.getNewOutput seeds,
 *     historical content is never replayed).
 *   - unseen content is chunked and emitted as delta events.
 *   - bare working ticks fire when no unseen is observed that tick.
 *   - bare working tick is NOT emitted in the same iteration as deltas.
 *   - stop conditions (idle / deadline / deadline+idle) drive the loop to a
 *     final event with the correct `reason`.
 *   - abort() produces a final event with reason "aborted".
 *   - final event prefers the last emitted delta; otherwise it falls back to
 *     communicator.getLatestOutput(), truncated to MAX_CHUNK_TOTAL.
 *
 * Design note: we drive the loop via a controllable fake clock + queued
 * sleeps. Each pending sleep represents one progressIntervalMs of wall time;
 * step() resolves one queued sleep and advances the clock. drive() walks
 * the loop until the run promise resolves. This is the same pattern used
 * in tests/observe-loop.test.ts so the behaviour parity stays obvious.
 */
import { describe, it, expect } from "vitest";
import {
  ObserveLoopController,
  type OutputEvent,
} from "../../src/turn/observe-loop-controller.js";
import {
  AgentCommunicator,
  type AgentOutputReader,
} from "../../src/agent-sessions.js";
import { MAX_CHUNK_TOTAL } from "../../src/output-diff.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * A reader whose snapshots advance on every read. Each call to `read`
 * returns the next snapshot from the array, or the last element if
 * exhausted. This models an agent that keeps appending to a pane.
 */
function makeFakeReader(snapshots: string[]) {
  let i = 0;
  const reader: AgentOutputReader & { calls: number; append(extra: string[]): void } = {
    kind: "fake",
    calls: 0,
    append(extra: string[]) {
      snapshots.push(...extra);
    },
    read(_max: number): string {
      this.calls += 1;
      return snapshots[Math.min(i++, snapshots.length - 1)] ?? "";
    },
  };
  return reader;
}

/**
 * Build the controllable environment the loop runs in:
 *   - a fake reader with the supplied snapshots,
 *   - an AgentCommunicator wrapping the reader,
 *   - a collected event log,
 *   - a queued sleep that the test resolves manually,
 *   - a fake clock.
 *
 * step() advances the clock by `tickMs` (matching progressIntervalMs) and
 * resolves one queued sleep. drive() walks the loop until either the run
 * promise resolves or three consecutive idle iterations occur (loop is
 * done). This mirrors the helper in tests/observe-loop.test.ts.
 */
function makeEnv(opts: {
  snapshots: string[];
  progressIntervalMs?: number;
  stabilityMs?: number;
  formatWorkingSuffix?: (elapsedMs: number) => string;
  formatDelta?: (chunk: string, elapsedMs: number) => string;
  formatWorkingTick?: (elapsedMs: number) => string;
}) {
  const progressIntervalMs = opts.progressIntervalMs ?? 100;
  const stabilityMs = opts.stabilityMs ?? 100;
  const reader = makeFakeReader(opts.snapshots);
  const communicator = new AgentCommunicator(reader, noopLogger);
  const events: OutputEvent[] = [];
  const pending: Array<() => void> = [];
  let now = 0;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };

  const sleep = async (_ms: number) =>
    new Promise<void>((resolve) => pending.push(resolve));

  const controller = new ObserveLoopController({
    communicator,
    emit: (e) => events.push(e),
    sleep,
    now: clock.now,
    progressIntervalMs,
    stabilityMs,
    formatWorkingSuffix: opts.formatWorkingSuffix,
    formatDelta: opts.formatDelta,
    formatWorkingTick: opts.formatWorkingTick,
  });

  return {
    controller,
    events,
    pending,
    clock,
    step() {
      const next = pending.shift();
      if (!next) return false;
      clock.advance(progressIntervalMs);
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

describe("ObserveLoopController — deadline state", () => {
  it("reports whether a deadline is currently armed", () => {
    const env = makeEnv({ snapshots: ["stable"] });

    expect(env.controller.hasDeadline()).toBe(false);

    env.controller.updateDeadline(500);
    expect(env.controller.hasDeadline()).toBe(true);

    env.controller.updateDeadline(null);
    expect(env.controller.hasDeadline()).toBe(false);
  });
});

describe("ObserveLoopController — baseline seeding", () => {
  it("does not emit a delta on the first poll (baseline seeds silently)", async () => {
    // Pane already has content when the loop starts. The first poll seeds
    // the communicator's diff state and returns "" — no delta event is
    // emitted for that content. Replaying the existing snapshot would
    // duplicate what the user has been watching live. The loop is
    // otherwise allowed to fire working ticks and finalise.
    const env = makeEnv({ snapshots: ["initial"] });
    env.controller.markUserInput(); // waitUntilIdle=true so loop waits for idle
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const deltas = env.events.filter((e) => e.type === "delta");
    expect(deltas).toHaveLength(0);
    // The loop still finalises — the snapshot fallback fires.
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
  });
});

describe("ObserveLoopController — delta emission", () => {
  it("emits delta events when new content is observed", async () => {
    // Pane grows: "x" → "x y" → "x y". After the second growth the pane
    // settles, the loop reaches idle and finalises.
    const env = makeEnv({
      snapshots: ["x", "x y", "x y", "x y"],
      stabilityMs: 100,
    });
    env.controller.markUserInput(); // waitUntilIdle=true so the loop waits
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const deltas = env.events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);
    // The first delta must carry the " y" suffix that deriveUnseen saw.
    expect(deltas.some((d) => d.text.includes(" y"))).toBe(true);
  });

  it("emits multiple delta chunks when unseen content exceeds MAX_CHUNK_TOTAL", async () => {
    // Produce a single huge growth (15 000 chars) so chunkForTelegram must
    // split into multiple chunks. Each chunk is emitted as its own delta.
    const big = "x".repeat(15_000);
    const env = makeEnv({
      snapshots: ["seed", "seed" + big],
      progressIntervalMs: 100,
      stabilityMs: 100,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const deltas = env.events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    // Every chunk must be bounded by MAX_CHUNK_TOTAL — chunkForTelegram
    // honours that invariant by design.
    for (const d of deltas) {
      expect(d.text.length).toBeLessThanOrEqual(MAX_CHUNK_TOTAL);
    }
    // The combined delta text reconstructs the unseen content modulo the
    // "\n\n" separators chunkForTelegram inserts between chunks.
    const combined = deltas.map((d) => d.text).join("");
    expect(combined.replace(/\n/g, "")).toBe(big);
  });
});

describe("ObserveLoopController — working ticks", () => {
  it("emits a working tick when no unseen content is observed", async () => {
    // Stable pane from start. The baseline poll emits nothing; subsequent
    // polls see no growth and emit working ticks until the idle window
    // elapses.
    const env = makeEnv({
      snapshots: ["stable", "stable", "stable", "stable"],
      stabilityMs: 200,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const ticks = env.events.filter((e) => e.type === "working");
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("does NOT emit a bare working tick in the same iteration as deltas", async () => {
    // Pane grows on every poll — every iteration has unseen content.
    // The loop must NEVER emit a bare working tick alongside the deltas.
    // Use a short deadline so the loop stops after the first tick (which
    // produces a delta) without waiting for idle.
    const env = makeEnv({
      snapshots: ["x", "x y", "x y z"],
      progressIntervalMs: 100,
      stabilityMs: 100,
    });
    // deadline = 50ms so the loop exits right after tick 1's delta.
    env.controller.updateDeadline(env.clock.now() + 50);
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const deltas = env.events.filter((e) => e.type === "delta");
    const ticks = env.events.filter((e) => e.type === "working");
    // At least one delta must have fired.
    expect(deltas.length).toBeGreaterThan(0);
    // No bare working tick — every tick that had unseen emitted deltas only.
    expect(ticks).toHaveLength(0);
  });
});

describe("ObserveLoopController — stop conditions", () => {
  it("stops with reason 'idle' when waitUntilIdle is true and pane is stable", async () => {
    // waitUntilIdle=true (via markUserInput), deadline=null (default).
    // shouldStop() reduces to isIdle. Once the pane has been stable for
    // stabilityMs, the loop emits final with reason="idle".
    const env = makeEnv({
      snapshots: ["stable", "stable", "stable", "stable"],
      stabilityMs: 100,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.reason).toBe("idle");
  });

  it("stops with reason 'deadline' when waitUntilIdle is false and deadline is reached", async () => {
    // waitUntilIdle=false (default — no markUserInput call). deadline set
    // to ~1 tick ahead. The loop stops at the deadline even though the
    // pane never went idle.
    const env = makeEnv({
      snapshots: ["x", "x", "x", "x", "x", "x"],
      stabilityMs: 10_000, // large so idle never triggers
    });
    env.controller.updateDeadline(env.clock.now() + 150);
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.reason).toBe("deadline");
  });

  it("stops with reason 'idle' when deadline AND idle are both required", async () => {
    // follow + message scenario: deadline in the near future AND
    // waitUntilIdle=true. The pane is producing content during the
    // follow window, so even after the deadline expires the loop must
    // wait stabilityMs AFTER the last content change before stopping.
    const env = makeEnv({
      // Pane grows through the deadline tick then settles — this proves
      // the loop didn't finalise merely because the timer expired.
      snapshots: ["x", "x y", "x y z", "x y z", "x y z", "x y z"],
      progressIntervalMs: 100,
      stabilityMs: 100,
    });
    env.controller.updateDeadline(env.clock.now() + 200); // deadline = tick 2
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    // Idle was the gating constraint, so the reason is "idle".
    expect(finals[0]?.reason).toBe("idle");
    // The loop must NOT have stopped at the deadline (200ms). The pane
    // was still producing at that point, so the loop ran an additional
    // stability-window tick before finalising — that's at least 4 events
    // (two deltas, one bare working tick, the final).
    const deltas = env.events.filter((e) => e.type === "delta");
    const ticks = env.events.filter((e) => e.type === "working");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(env.events.length).toBeGreaterThanOrEqual(4);
  });

  it("does not stop before the deadline when waitUntilIdle is false", async () => {
    // Sanity check the inverse: with deadline=300 and a fast-growing
    // pane, the loop should NOT finalise before the deadline fires.
    const env = makeEnv({
      snapshots: ["x", "x y", "x y z", "x y z w"],
      progressIntervalMs: 100,
      stabilityMs: 100,
    });
    env.controller.updateDeadline(env.clock.now() + 300);
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.reason).toBe("deadline");
    // At least two ticks worth of deltas must have fired before stop.
    const deltas = env.events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ObserveLoopController — abort", () => {
  it("emits final with reason 'aborted' when abort() is called", async () => {
    // Long-lived loop: large stabilityMs, growing pane. Drive a few
    // ticks, then abort. The final event MUST fire with reason="aborted".
    const env = makeEnv({
      snapshots: [
        "x",
        "x y",
        "x y z",
        "x y z w",
        "x y z w v",
        "x y z w v u",
      ],
      stabilityMs: 10_000, // never goes idle
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    // Run a few ticks, then abort.
    for (let i = 0; i < 3; i++) {
      while (env.pendingCount() === 0) await Promise.resolve();
      env.step();
      await Promise.resolve();
    }
    env.controller.abort();
    await env.drive();
    await loop;
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.reason).toBe("aborted");
  });

  it("done promise resolves when the loop ends", async () => {
    // The done promise must settle once the loop exits. Awaiting it
    // without timing out proves the controller resolves it.
    const env = makeEnv({
      snapshots: ["x", "x", "x"],
      stabilityMs: 100,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    // Resolve the done promise; if it never resolved we'd hit the
    // vitest default timeout.
    await env.controller.done;
    expect(true).toBe(true);
  });
});

describe("ObserveLoopController — final payload fallback", () => {
  it("uses the last emitted delta when at least one delta was emitted", async () => {
    // Pane grows once then settles. After the growth the loop waits for
    // idle. The final must surface the most recent delta text, not the
    // raw snapshot.
    const env = makeEnv({
      snapshots: ["seed", "seed tail", "seed tail", "seed tail"],
      stabilityMs: 100,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    // The last delta was the " tail" suffix.
    expect(finals[0]?.text).toContain(" tail");
  });

  it("falls back to communicator.getLatestOutput() when no delta was emitted", async () => {
    // Pane never grows — only the baseline seed is observed. The final
    // has no delta to fall back on, so it MUST use the latest snapshot
    // via communicator.getLatestOutput().
    const env = makeEnv({
      snapshots: ["snapshot only", "snapshot only", "snapshot only"],
      stabilityMs: 100,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toContain("snapshot only");
  });

  it("truncates the latest snapshot to MAX_CHUNK_TOTAL when needed", async () => {
    // No delta was emitted (snapshot unchanged from seed), but the
    // snapshot itself is larger than MAX_CHUNK_TOTAL — the fallback
    // path must clamp it.
    const big = "y".repeat(MAX_CHUNK_TOTAL + 500);
    const env = makeEnv({
      snapshots: [big, big, big, big],
      stabilityMs: 100,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    // Final payload must be capped to MAX_CHUNK_TOTAL.
    expect(finals[0]?.text.length).toBeLessThanOrEqual(MAX_CHUNK_TOTAL);
  });
});

describe("ObserveLoopController — start() is idempotent", () => {
  it("returns the same promise on repeated start() calls", async () => {
    const env = makeEnv({ snapshots: ["x", "x", "x"] });
    env.controller.markUserInput();
    const p1 = env.controller.start();
    const p2 = env.controller.start();
    expect(p1).toBe(p2);
    await env.drive();
    await p1;
  });
});

describe("ObserveLoopController — formatter callbacks", () => {
  it("applies formatDelta to each emitted chunk", async () => {
    const env = makeEnv({
      snapshots: ["x", "x y"],
      stabilityMs: 100,
      formatDelta: (chunk) => `[formatted]${chunk}`,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const deltas = env.events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) {
      expect(d.text.startsWith("[formatted]")).toBe(true);
    }
  });

  it("applies formatWorkingTick to bare working ticks", async () => {
    const env = makeEnv({
      snapshots: ["x", "x", "x", "x"],
      stabilityMs: 100,
      formatWorkingTick: (elapsedMs) => `<tick:${elapsedMs}>`,
    });
    env.controller.markUserInput();
    const loop = env.controller.start();
    await env.drive();
    await loop;
    const ticks = env.events.filter((e) => e.type === "working");
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.text.startsWith("<tick:")).toBe(true);
    }
  });
});