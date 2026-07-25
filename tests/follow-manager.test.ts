import { describe, it, expect } from "vitest";
import { FollowManager } from "../src/follow-manager.js";
import type { ThreadMapping } from "../src/types.js";

const MAPPING: ThreadMapping = {
  pane_id: "w1:p1",
  label: "test",
  agent: "codex",
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("FollowManager", () => {
  function fakeClock() {
    let now = 0;
    return {
      now: () => now,
      setTimeout: (cb: () => void, ms: number) => {
        // Capture the timer for manual firing
        const handle = { ms, cb, fired: false };
        handle.id = (fakeClock as any)._timers.push(handle) - 1;
        return handle.id;
      },
      clearTimeout: (id: number) => {
        const arr = (fakeClock as any)._timers as any[];
        const t = arr[id];
        if (t) t.cancelled = true;
      },
      fireExpired: () => {
        const arr = (fakeClock as any)._timers as any[];
        for (const t of arr) {
          if (!t.cancelled && !t.fired) {
            t.fired = true;
            t.cb();
          }
        }
      },
      _timers: [] as any[],
    };
  }

  describe("subscribe / unsubscribe", () => {
    it("returns null when querying a never-subscribed thread", () => {
      const fm = new FollowManager(fakeClock() as any);
      expect(fm.get(140)).toBeNull();
    });

    it("creates a subscription with the given timeout", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      fm.subscribe(140, MAPPING, 30);
      const sub = fm.get(140);
      expect(sub).not.toBeNull();
      expect(sub!.threadId).toBe(140);
      expect(sub!.mapping).toBe(MAPPING);
      expect(sub!.timeoutMs).toBe(30 * 60_000);
      expect(sub!.expiresAt).toBe(30 * 60_000);
    });

    it("replaces an existing subscription when subscribing twice", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      fm.subscribe(140, MAPPING, 30);
      clock.now = () => 5 * 60_000; // 5 min in
      fm.subscribe(140, MAPPING, 60);
      const sub = fm.get(140);
      expect(sub!.timeoutMs).toBe(60 * 60_000);
      // expiresAt relative to NEW subscribe call (5 min mark)
      expect(sub!.expiresAt).toBe(5 * 60_000 + 60 * 60_000);
    });

    it("remove() returns true when subscription existed, false otherwise", () => {
      const fm = new FollowManager(fakeClock() as any);
      expect(fm.remove(140)).toBe(false);
      fm.subscribe(140, MAPPING, 30);
      expect(fm.remove(140)).toBe(true);
      expect(fm.get(140)).toBeNull();
    });

    it("supports multiple concurrent subscriptions on different threads", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      const other: ThreadMapping = { ...MAPPING, pane_id: "w1:p2", label: "two" };
      fm.subscribe(140, MAPPING, 30);
      fm.subscribe(141, other, 60);
      expect(fm.get(140)?.mapping.pane_id).toBe("w1:p1");
      expect(fm.get(141)?.mapping.pane_id).toBe("w1:p2");
      fm.remove(140);
      expect(fm.get(140)).toBeNull();
      expect(fm.get(141)).not.toBeNull();
    });
  });

  describe("touch() — reset timer on user message", () => {
    it("extends expiresAt by timeoutMs from now", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      fm.subscribe(140, MAPPING, 30);
      clock.now = () => 10 * 60_000; // 10 min in
      fm.touch(140);
      const sub = fm.get(140)!;
      expect(sub.expiresAt).toBe(10 * 60_000 + 30 * 60_000);
    });

    it("no-ops when there is no active subscription", () => {
      const fm = new FollowManager(fakeClock() as any);
      fm.touch(140); // does not throw
      expect(fm.get(140)).toBeNull();
    });
  });

  describe("expiration", () => {
    it("isExpired returns false before expiresAt, true after", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      fm.subscribe(140, MAPPING, 30);
      const sub = fm.get(140)!;
      clock.now = () => sub.expiresAt - 1;
      expect(fm.isExpired(140)).toBe(false);
      clock.now = () => sub.expiresAt + 1;
      expect(fm.isExpired(140)).toBe(true);
    });

    it("expires correctly when timeoutMs = 0 (no timeout, never expires)", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      fm.subscribe(140, MAPPING, 0);
      clock.now = () => Number.MAX_SAFE_INTEGER / 2;
      expect(fm.isExpired(140)).toBe(false);
    });

    it("listExpired returns threadIds whose subscription expired", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      const other: ThreadMapping = { ...MAPPING, pane_id: "w1:p2", label: "two" };
      fm.subscribe(140, MAPPING, 30);
      fm.subscribe(141, other, 60);
      // 31 minutes in: 140 expired, 141 not yet
      clock.now = () => 31 * 60_000;
      expect(fm.listExpired()).toEqual([140]);
    });

    it("listExpired returns empty when timeoutMs = 0 for all", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      fm.subscribe(140, MAPPING, 0);
      fm.subscribe(141, { ...MAPPING, pane_id: "w1:p2", label: "two" }, 0);
      clock.now = () => Number.MAX_SAFE_INTEGER / 2;
      expect(fm.listExpired()).toEqual([]);
    });
  });

  describe("size / listAll", () => {
    it("size reflects number of active subscriptions", () => {
      const fm = new FollowManager(fakeClock() as any);
      expect(fm.size).toBe(0);
      fm.subscribe(140, MAPPING, 30);
      fm.subscribe(141, { ...MAPPING, pane_id: "w1:p2", label: "two" }, 30);
      expect(fm.size).toBe(2);
      fm.remove(140);
      expect(fm.size).toBe(1);
    });

    it("listAll returns snapshots of every active subscription", () => {
      const clock = fakeClock();
      const fm = new FollowManager(clock as any);
      const other: ThreadMapping = { ...MAPPING, pane_id: "w1:p2", label: "two" };
      fm.subscribe(140, MAPPING, 30);
      fm.subscribe(141, other, 60);
      const all = fm.listAll();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.threadId).sort()).toEqual([140, 141]);
    });
  });
});
