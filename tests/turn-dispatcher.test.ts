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
});
