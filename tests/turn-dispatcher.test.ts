import { describe, expect, it } from "vitest";
import { TurnDispatcher } from "../src/turn-dispatcher.js";

describe("TurnDispatcher (PR #10 single-turn model)", () => {
  it("runs one turn per pane and resolves when it finalises", async () => {
    const dispatcher = new TurnDispatcher();
    const events: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    void dispatcher.start("p1", async () => {
      events.push("first:start");
      await first;
      events.push("first:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first:start"]);
    release();
    await dispatcher.waitForIdle("p1");
    expect(events).toEqual(["first:start", "first:end"]);
    expect(dispatcher.isBusy("p1")).toBe(false);
  });

  it("rejects when starting a second turn for the same pane while one is in flight", async () => {
    const dispatcher = new TurnDispatcher();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    void dispatcher.start("p1", async () => { await blocked; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(dispatcher.start("p1", async () => {})).rejects.toThrow(/already running/);
    release();
  });

  it("runs turns for different panes independently", async () => {
    const dispatcher = new TurnDispatcher();
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    void dispatcher.start("codex", async () => { await blocked; events.push("codex"); });
    void dispatcher.start("opencode", async () => { events.push("opencode"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["opencode"]);
    release();
  });

  describe("isBusy", () => {
    it("returns false for an unknown pane", () => {
      const dispatcher = new TurnDispatcher();
      expect(dispatcher.isBusy("never-started")).toBe(false);
    });

    it("returns true while a turn is still running", async () => {
      const dispatcher = new TurnDispatcher();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      void dispatcher.start("p1", async () => { await blocked; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatcher.isBusy("p1")).toBe(true);
      release();
      await dispatcher.waitForIdle("p1");
      expect(dispatcher.isBusy("p1")).toBe(false);
    });
  });

  describe("waitForIdle", () => {
    it("resolves immediately when no turn is running", async () => {
      const dispatcher = new TurnDispatcher();
      await dispatcher.waitForIdle("p1"); // does not hang
    });

    it("resolves once the active turn finishes", async () => {
      const dispatcher = new TurnDispatcher();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      void dispatcher.start("p1", async () => { await blocked; });
      let waited = false;
      const waiting = dispatcher.waitForIdle("p1").then(() => { waited = true; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(waited).toBe(false);
      release();
      await waiting;
      expect(waited).toBe(true);
    });
  });

  describe("abort", () => {
    it("returns false when no turn is active", () => {
      const dispatcher = new TurnDispatcher();
      expect(dispatcher.abort("missing")).toBe(false);
    });

    it("signals the running turn's AbortController and returns true", async () => {
      const dispatcher = new TurnDispatcher();
      const seen: { aborted: boolean } = { aborted: false };
      void dispatcher.start("p1", async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            seen.aborted = true;
            resolve();
          });
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatcher.abort("p1")).toBe(true);
      await dispatcher.waitForIdle("p1");
      expect(seen.aborted).toBe(true);
    });

    it("returns false on a second invocation (signal already fired)", async () => {
      const dispatcher = new TurnDispatcher();
      void dispatcher.start("p1", async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
        // After abort, sleep forever to keep the turn in flight.
        await new Promise(() => {});
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatcher.abort("p1")).toBe(true);
      expect(dispatcher.abort("p1")).toBe(false);
    });

    it("isolates aborts per pane", async () => {
      const dispatcher = new TurnDispatcher();
      const seen = { p1: false, p2: false };
      void dispatcher.start("p1", async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { seen.p1 = true; resolve(); });
        });
      });
      void dispatcher.start("p2", async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { seen.p2 = true; resolve(); });
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      dispatcher.abort("p1");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(seen.p1).toBe(true);
      expect(seen.p2).toBe(false);
    });
  });

  it("cleans up the controller and active map even when the turn rejects", async () => {
    const dispatcher = new TurnDispatcher();
    // Attach a catch so the rejection does not become an unhandled error.
    dispatcher.start("p1", async () => { throw new Error("boom"); }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(dispatcher.isBusy("p1")).toBe(false);
    expect(dispatcher.abort("p1")).toBe(false);
  });
});