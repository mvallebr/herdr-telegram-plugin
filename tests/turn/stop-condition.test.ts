import { describe, it, expect } from "vitest";
import {
  isDeadlineReached,
  isIdle,
  shouldStop,
  type StopState,
} from "../../src/turn/stop-condition.js";

/**
 * Build a StopState fixture. Defaults model a fresh pane that last changed
 * "now" and a generous stability window — tests adjust the fields they care
 * about.
 */
function makeState(overrides: Partial<StopState> = {}): StopState {
  return {
    now: 0,
    lastChangeAt: 0,
    stabilityMs: 100,
    deadline: null,
    waitUntilIdle: true,
    ...overrides,
  };
}

describe("isDeadlineReached", () => {
  it("returns true when deadline is null (always reached)", () => {
    expect(isDeadlineReached(makeState({ deadline: null, now: 0 }))).toBe(true);
    // Even arbitrarily far in the future, null still means reached.
    expect(isDeadlineReached(makeState({ deadline: null, now: 10_000_000 }))).toBe(true);
  });

  it("returns true when now >= deadline", () => {
    expect(isDeadlineReached(makeState({ deadline: 1000, now: 1000 }))).toBe(true);
    expect(isDeadlineReached(makeState({ deadline: 1000, now: 1001 }))).toBe(true);
  });

  it("returns false when now < deadline", () => {
    expect(isDeadlineReached(makeState({ deadline: 1000, now: 999 }))).toBe(false);
  });
});

describe("isIdle", () => {
  it("returns true when stability window has elapsed since last change", () => {
    expect(isIdle(makeState({ now: 100, lastChangeAt: 0, stabilityMs: 100 }))).toBe(true);
    expect(isIdle(makeState({ now: 250, lastChangeAt: 100, stabilityMs: 100 }))).toBe(true);
  });

  it("returns false when content has changed within the stability window", () => {
    expect(isIdle(makeState({ now: 50, lastChangeAt: 0, stabilityMs: 100 }))).toBe(false);
    expect(isIdle(makeState({ now: 99, lastChangeAt: 0, stabilityMs: 100 }))).toBe(false);
  });
});

describe("shouldStop", () => {
  // --- Scenario 1: message only (deadline=null, waitUntilIdle=true) -----
  it("message-only: does NOT stop before the stability window elapses", () => {
    const state = makeState({
      deadline: null,
      waitUntilIdle: true,
      now: 50,
      lastChangeAt: 0,
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(false);
  });

  it("message-only: stops when the pane has been stable for the window", () => {
    const state = makeState({
      deadline: null,
      waitUntilIdle: true,
      now: 100,
      lastChangeAt: 0,
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(true);
  });

  // --- Scenario 2: follow only (deadline set, waitUntilIdle=false) -----
  it("follow-only: does NOT stop when idle early, before deadline", () => {
    const state = makeState({
      deadline: 1000,
      waitUntilIdle: false,
      now: 100,   // already idle (100 - 0 >= 100)
      lastChangeAt: 0,
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(false);
  });

  it("follow-only: stops exactly at deadline", () => {
    const state = makeState({
      deadline: 1000,
      waitUntilIdle: false,
      now: 1000,
      lastChangeAt: 999, // still considered not-idle (1ms < 100ms)
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(true);
  });

  it("follow-only: stops past deadline even if not idle", () => {
    const state = makeState({
      deadline: 1000,
      waitUntilIdle: false,
      now: 1500,
      lastChangeAt: 1450, // 50ms < 100ms → not idle
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(true);
  });

  // --- Scenario 3: follow + message (deadline set, waitUntilIdle=true) --
  it("follow+message: does NOT stop when idle but deadline not reached", () => {
    const state = makeState({
      deadline: 1000,
      waitUntilIdle: true,
      now: 500,   // idle (500 - 0 >= 100)
      lastChangeAt: 0,
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(false);
  });

  it("follow+message: does NOT stop when deadline reached but not idle", () => {
    const state = makeState({
      deadline: 1000,
      waitUntilIdle: true,
      now: 1000,  // deadline reached
      lastChangeAt: 999, // but only 1ms since change → not idle
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(false);
  });

  it("follow+message: stops only after deadline AND idle", () => {
    // Initial state: deadline in the future, pane fresh.
    // Once deadline expires but pane keeps changing, we keep waiting for idle.
    // After lastChangeAt advances to the deadline, the stability window must
    // also elapse before shouldStop returns true.
    const beforeDeadline = makeState({
      deadline: 1000,
      waitUntilIdle: true,
      now: 1000,
      lastChangeAt: 999,
      stabilityMs: 100,
    });
    expect(shouldStop(beforeDeadline)).toBe(false);

    // Right at deadline: lastChangeAt just moved to `now` → not idle.
    const atDeadline = makeState({
      deadline: 1000,
      waitUntilIdle: true,
      now: 1000,
      lastChangeAt: 1000,
      stabilityMs: 100,
    });
    expect(shouldStop(atDeadline)).toBe(false);

    // After the stability window following the last change: stop.
    const afterStability = makeState({
      deadline: 1000,
      waitUntilIdle: true,
      now: 1100,
      lastChangeAt: 1000,
      stabilityMs: 100,
    });
    expect(shouldStop(afterStability)).toBe(true);
  });

  // --- Scenario 4: /follow 0 — deadline = now, waitUntilIdle=false -----
  it("/follow 0: stops immediately when deadline is now and no waitUntilIdle", () => {
    const state = makeState({
      deadline: 0,
      waitUntilIdle: false,
      now: 0,
      lastChangeAt: 0,
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(true);
  });

  // --- Scenario 5: unfollow after message keeps waitUntilIdle -------------
  it("unfollow after message: keeps waitUntilIdle and stops only when idle", () => {
    // Unfollow clears the deadline (null) but leaves waitUntilIdle=true so
    // the loop drains once the agent settles.
    const state = makeState({
      deadline: null,
      waitUntilIdle: true,
      now: 100,
      lastChangeAt: 0,
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(true);
  });

  it("unfollow after message: does not stop before the stability window elapses", () => {
    const state = makeState({
      deadline: null,
      waitUntilIdle: true,
      now: 50,
      lastChangeAt: 0,
      stabilityMs: 100,
    });
    expect(shouldStop(state)).toBe(false);
  });
});