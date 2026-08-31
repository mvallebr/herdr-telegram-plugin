import { describe, it, expect } from "vitest";
import type { TopicInfo } from "../src/types.js";
import { TelegramClient } from "../src/telegram-client.js";

describe("TopicInfo", () => {
  it("matches expected shape from Telegram API", () => {
    const info: TopicInfo = {
      message_thread_id: 140,
      name: "Echo",
    };
    expect(typeof info.message_thread_id).toBe("number");
    expect(typeof info.name).toBe("string");
    const errors: string[] = [];
    expect(Array.isArray(errors)).toBe(true);
  });
});

function fakeBot(start: () => Promise<void>) {
  return {
    init: async () => {},
    start,
    stop: async () => {},
    isRunning: () => false,
    api: {},
  };
}

describe("TelegramClient polling lifecycle", () => {
  it("records a permanent polling failure instead of retrying forever", async () => {
    const client = new TelegramClient("test", undefined, fakeBot(async () => {
      throw { error_code: 401, message: "Unauthorized" };
    }) as any);

    await client.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.getPollingStatus()).toMatchObject({ state: "failed", error: "Unauthorized" });
    await client.stop();
  });

  it("enters retrying on a polling conflict and can be stopped during backoff", async () => {
    const client = new TelegramClient("test", undefined, fakeBot(async () => {
      throw { error_code: 409, message: "Conflict" };
    }) as any);

    await client.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.getPollingStatus()).toMatchObject({ state: "retrying", attempt: 1, error: "Conflict" });
    await client.stop();
    expect(client.getPollingStatus().state).toBe("stopped");
  });
});

describe("TelegramClient message delivery", () => {
  it("retries transient send failures with exponential backoff", async () => {
    const delays: number[] = [];
    let now = 0;
    let calls = 0;
    const client = new TelegramClient("test", undefined, {
      api: {
        sendMessage: async () => {
          calls += 1;
          if (calls < 3) throw new Error("network unavailable");
          return { message_id: 42 };
        },
      },
    } as any, undefined, {
      now: () => now,
      sleep: async (ms) => { delays.push(ms); now += ms; },
    });

    await expect(client.sendMessage(1, 2, "hello")).resolves.toBe(42);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it("stops retrying after ten minutes", async () => {
    const delays: number[] = [];
    let now = 0;
    const client = new TelegramClient("test", undefined, {
      api: { sendMessage: async () => { throw new Error("network unavailable"); } },
    } as any, undefined, {
      now: () => now,
      sleep: async (ms) => { delays.push(ms); now += ms; },
    });

    await expect(client.sendMessage(1, 2, "hello")).rejects.toThrow("network unavailable");
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(10 * 60_000);
    expect(delays.at(-1)).toBe(89_000);
  });

  it("does not retry permanent Telegram errors", async () => {
    let calls = 0;
    const client = new TelegramClient("test", undefined, {
      api: { sendMessage: async () => { calls += 1; throw { error_code: 400, message: "Bad Request" }; } },
    } as any);

    await expect(client.sendMessage(1, 2, "hello")).rejects.toMatchObject({ error_code: 400 });
    expect(calls).toBe(1);
  });
});
