import { describe, it, expect, vi } from "vitest";
import * as herdrClient from "../src/herdr-client.js";
import { formatAgentList, formatStatus, registerCommands, type CommandDeps } from "../src/commands.js";
import type { PaneInfo, ThreadMapping } from "../src/types.js";

describe("formatAgentList", () => {
  it("formats agents with status", () => {
    const panes: PaneInfo[] = [
      { pane_id: "w1:pZ", label: "Echo", agent: "pi", tab_id: "tZ", workspace_id: "w1", status: "idle" },
    ];
    const map = new Map<number, ThreadMapping>();
    map.set(140, { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "x" });

    const result = formatAgentList(panes, map);
    expect(result).toContain("Echo");
    expect(result).toContain("pi");
    expect(result).toContain("140");
  });
});

describe("formatStatus", () => {
  it("includes uptime and counts", () => {
    const result = formatStatus({
      uptime: "10s",
      paired: true,
      panesCount: 3,
    });
    expect(result).toContain("10s");
    expect(result).toContain("panes: 3");
  });
});

// Minimal grammy-Bot stub. Captures handlers by command name and replays
// them with a fake ctx. Each handler returns the reply text via a Promise
// (matches the real Bot.command signature).
interface CapturedCommand {
  body: (ctx: any) => Promise<void>;
}
function makeFakeBot(): { bot: any; run: (name: string, ctx: any) => Promise<void>; replies: string[] } {
  const handlers = new Map<string, CapturedCommand>();
  const replies: string[] = [];
  const bot: any = {
    command(name: string, body: (ctx: any) => Promise<void>) {
      handlers.set(name, { body });
    },
  };
  return {
    bot,
    replies,
    async run(name: string, ctx: any) {
      const h = handlers.get(name);
      if (!h) throw new Error(`No handler for /${name}`);
      await h.body({
        ...ctx,
        reply: async (text: string) => { replies.push(text); },
      });
    },
  };
}

describe("/stop command handler", () => {
  it("sends the named 'Escape' key to the pane bound to the current thread", async () => {
    // ESC must be routed through herdr pane send-keys with the named key,
    // not sent as a raw \x1b byte via pane run: raw ESC is interpreted as
    // the start of an ANSI CSI sequence and silently swallowed.
    const sendEscapeSpy = vi.spyOn(herdrClient, "sendEscape").mockImplementation(() => {});
    const sendKeysSpy = vi.spyOn(herdrClient, "sendKeys").mockImplementation(() => {});
    const fake = makeFakeBot();
    const map = new Map<number, ThreadMapping>();
    map.set(140, { pane_id: "w1:p27", label: "dmarc", agent: "pi", created_at: "x" });
    registerCommands(fake.bot, {
      map,
      stateDir: "/tmp/no-such",
      chatId: -100,
      startTime: Date.now(),
      saveMappings: () => {},
    } as CommandDeps);
    await fake.run("stop", { message: { message_thread_id: 140 } });
    expect(sendEscapeSpy).toHaveBeenCalledTimes(1);
    expect(sendEscapeSpy).toHaveBeenCalledWith("w1:p27");
    expect(fake.replies.join("\n")).toContain("Stopped dmarc");
    sendEscapeSpy.mockRestore();
    sendKeysSpy.mockRestore();
  });

  it("is a no-op when called outside a thread", async () => {
    const sendEscapeSpy = vi.spyOn(herdrClient, "sendEscape").mockImplementation(() => {});
    const fake = makeFakeBot();
    const map = new Map<number, ThreadMapping>();
    registerCommands(fake.bot, {
      map,
      stateDir: "/tmp/no-such",
      chatId: -100,
      startTime: Date.now(),
      saveMappings: () => {},
    } as CommandDeps);
    await fake.run("stop", { message: {} });
    expect(sendEscapeSpy).not.toHaveBeenCalled();
    expect(fake.replies).toEqual([]);
    sendEscapeSpy.mockRestore();
  });

  it("informs the user when the thread is not bound", async () => {
    const sendEscapeSpy = vi.spyOn(herdrClient, "sendEscape").mockImplementation(() => {});
    const fake = makeFakeBot();
    registerCommands(fake.bot, {
      map: new Map<number, ThreadMapping>(),
      stateDir: "/tmp/no-such",
      chatId: -100,
      startTime: Date.now(),
      saveMappings: () => {},
    } as CommandDeps);
    await fake.run("stop", { message: { message_thread_id: 140 } });
    expect(sendEscapeSpy).not.toHaveBeenCalled();
    expect(fake.replies.join("\n")).toContain("No pane for this topic");
    sendEscapeSpy.mockRestore();
  });

  it("forwards a busy signal to the dispatcher so the in-flight turn is released", async () => {
    const sendEscapeSpy = vi.spyOn(herdrClient, "sendEscape").mockImplementation(() => {});
    const abortSpy = vi.fn(() => true);
    const isBusySpy = vi.fn(() => true);
    const fake = makeFakeBot();
    const map = new Map<number, ThreadMapping>();
    map.set(140, { pane_id: "w1:p27", label: "dmarc", agent: "pi", created_at: "x" });
    registerCommands(fake.bot, {
      map,
      stateDir: "/tmp/no-such",
      chatId: -100,
      startTime: Date.now(),
      saveMappings: () => {},
      turns: { abort: abortSpy, isBusy: isBusySpy },
    } as CommandDeps);
    await fake.run("stop", { message: { message_thread_id: 140 } });
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith("w1:p27");
    // The reply must mention that the turn was released — distinguishes
    // it from the no-op path.
    expect(fake.replies.join("\n")).toMatch(/released the in-progress turn/i);
    sendEscapeSpy.mockRestore();
  });

  it("tells the user the agent was stopped without mentioning queue release when idle", async () => {
    const sendEscapeSpy = vi.spyOn(herdrClient, "sendEscape").mockImplementation(() => {});
    // abort() is always invoked; the boolean it returns shapes the reply.
    // Returning false here means the dispatcher has no in-flight turn.
    const abortSpy = vi.fn(() => false);
    const fake = makeFakeBot();
    const map = new Map<number, ThreadMapping>();
    map.set(140, { pane_id: "w1:p27", label: "dmarc", agent: "pi", created_at: "x" });
    registerCommands(fake.bot, {
      map,
      stateDir: "/tmp/no-such",
      chatId: -100,
      startTime: Date.now(),
      saveMappings: () => {},
      turns: { abort: abortSpy, isBusy: () => false },
    } as CommandDeps);
    await fake.run("stop", { message: { message_thread_id: 140 } });
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith("w1:p27");
    // Reply must NOT mention the in-progress turn release — the user just
    // pressed /stop while their agent was idle.
    expect(fake.replies.join("\n")).not.toMatch(/in-progress turn/i);
    expect(fake.replies.join("\n")).toMatch(/Stopped dmarc/);
    sendEscapeSpy.mockRestore();
  });
});
