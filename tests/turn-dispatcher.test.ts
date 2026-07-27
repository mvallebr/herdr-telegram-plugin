import { describe, expect, it } from "vitest";
import { TurnDispatcher } from "../src/turn-dispatcher.js";

describe("TurnDispatcher", () => {
  it("serializes turns for one pane", async () => {
    const dispatcher = new TurnDispatcher();
    const events: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    dispatcher.enqueue("p1", async () => { events.push("first:start"); await first; events.push("first:end"); });
    dispatcher.enqueue("p1", async () => { events.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first:start"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("runs turns for different panes independently", async () => {
    const dispatcher = new TurnDispatcher();
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    dispatcher.enqueue("codex", async () => { await blocked; events.push("codex"); });
    dispatcher.enqueue("opencode", async () => { events.push("opencode"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["opencode"]);
    release();
  });

  describe("isBusy", () => {
    it("returns false for an unknown pane", () => {
      const dispatcher = new TurnDispatcher();
      expect(dispatcher.isBusy("never-enqueued")).toBe(false);
    });

    it("returns true while an enqueued turn is still running", async () => {
      const dispatcher = new TurnDispatcher();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      dispatcher.enqueue("p1", async () => { await blocked; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatcher.isBusy("p1")).toBe(true);
      release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(dispatcher.isBusy("p1")).toBe(false);
    });

    it("does not flag other panes as busy", async () => {
      const dispatcher = new TurnDispatcher();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      dispatcher.enqueue("p1", async () => { await blocked; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatcher.isBusy("p2")).toBe(false);
      release();
    });
  });

  describe("attachAbortController / abort", () => {
    it("abort() returns false when no controller is attached", () => {
      const dispatcher = new TurnDispatcher();
      expect(dispatcher.abort("missing")).toBe(false);
    });

    it("abort() returns false if the controller was never attached", () => {
      const dispatcher = new TurnDispatcher();
      const c = new AbortController();
      expect(dispatcher.abort("missing")).toBe(false);
      expect(c.signal.aborted).toBe(false);
    });

    it("abort() signals the attached controller and returns true", async () => {
      const dispatcher = new TurnDispatcher();
      const c = new AbortController();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      dispatcher.enqueue("p1", async () => { await blocked; });
      dispatcher.attachAbortController("p1", c);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(c.signal.aborted).toBe(false);
      expect(dispatcher.abort("p1")).toBe(true);
      expect(c.signal.aborted).toBe(true);
      release();
    });

    it("abort() returns false on a second invocation (signal already fired)", async () => {
      const dispatcher = new TurnDispatcher();
      const c = new AbortController();
      dispatcher.enqueue("p1", async () => { await new Promise(() => {}); /* never settles */ });
      dispatcher.attachAbortController("p1", c);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatcher.abort("p1")).toBe(true);
      expect(dispatcher.abort("p1")).toBe(false);
    });

    it("abort() rotates to whichever controller is attached at call time", async () => {
      const dispatcher = new TurnDispatcher();
      const stale = new AbortController();
      const fresh = new AbortController();
      // First turn: attach a controller, then enqueue again with a fresh
      // one before the first turn finishes (simulating a new message
      // arriving before the previous turn finalises).
      const blocked = new Promise<void>(() => {});
      dispatcher.enqueue("p1", async () => { await blocked; });
      dispatcher.attachAbortController("p1", stale);
      dispatcher.enqueue("p1", async () => { await blocked; });
      dispatcher.attachAbortController("p1", fresh);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The fresh controller is the one wired in; aborting it should NOT
      // re-fire the stale one (stale is silently replaced).
      expect(dispatcher.abort("p1")).toBe(true);
      expect(fresh.signal.aborted).toBe(true);
      // The stale controller is no longer reachable via dispatcher so its
      // signal stays untouched — the caller never asked us to fire it.
      expect(stale.signal.aborted).toBe(false);
    });
  });
});
