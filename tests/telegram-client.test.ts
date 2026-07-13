import { describe, it, expect } from "vitest";
import type { TopicInfo } from "../src/types.js";

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
