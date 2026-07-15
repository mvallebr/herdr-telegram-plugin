import { describe, expect, it } from "vitest";
import { TelegramTurnReporter } from "../src/telegram-reporter.js";

describe("TelegramTurnReporter", () => {
  it("publishes neutral progress and a tagged final without agent diagnostics", async () => {
    let now = 0;
    const messages: Array<{ text: string; opts?: unknown }> = [];
    const reporter = new TelegramTurnReporter({
      sendMessage: async (_chat, _thread, text, opts) => { messages.push({ text, opts }); return 1; },
    } as any, 1, 2, () => now, now);
    now = 2000;
    await reporter.progress(2);
    await reporter.final("final answer", "codex-jsonl");
    expect(messages[0].text).toBe("⏳ Working (2s).");
    expect(messages[0].opts).toEqual({ disable_notification: true });
    expect(messages[1].text).toContain("[codex session log]");
    expect(messages[1].text).toContain("final answer");
  });

  it("keeps Codex correlation failures fail-closed", async () => {
    const messages: string[] = [];
    const reporter = new TelegramTurnReporter({
      sendMessage: async (_chat, _thread, text) => { messages.push(text); return 1; },
    } as any, 1, 2, () => 0, 0);
    await reporter.failed("Codex JSONL did not contain a response correlated to this prompt");
    expect(messages[0]).toContain("No terminal output was forwarded");
  });

  it("formats an interactive agent question as blocked instead of Working", async () => {
    const messages: string[] = [];
    const reporter = new TelegramTurnReporter({
      sendMessage: async (_chat, _thread, text) => { messages.push(text); return 1; },
    } as any, 1, 2, () => 0, 0);
    await reporter.blocked("Choose one:\n1. Continue\n2. Stop");
    expect(messages[0]).toBe("⚠️ Agent needs input:\n\nChoose one:\n1. Continue\n2. Stop");
  });

  it("labels a progress preview as Working rather than a final response", async () => {
    const messages: string[] = [];
    const reporter = new TelegramTurnReporter({
      sendMessage: async (_chat, _thread, text) => { messages.push(text); return 1; },
    } as any, 1, 2, () => 0, 0);
    await reporter.progress(15, "I am checking the files.");
    expect(messages[0]).toBe("⏳ Working (15s):\n\nI am checking the files.");
  });

  it("sends only completion when the final was already shown as progress", async () => {
    const messages: string[] = [];
    const reporter = new TelegramTurnReporter({
      sendMessage: async (_chat, _thread, text) => { messages.push(text); return 1; },
    } as any, 1, 2, () => 2_000, 0);
    await reporter.final("already shown", "screen-scrape", true);
    expect(messages[0]).toBe("✅ (2s).");
  });
});
