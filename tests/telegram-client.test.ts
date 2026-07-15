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
