import { describe, it, expect } from "vitest";
import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("emits structured JSON objects", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.info("hello", { count: 1 });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      name: "test",
      level: "info",
      message: "hello",
      count: 1,
    });
  });

  it("logs without extra data", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.warn("bare");

    expect(logs[0]).toMatchObject({ level: "warn", message: "bare" });
  });

  it("filters sensitive keys from data", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.info("config loaded", { bot_token: "secret123", debug: true });

    expect((logs[0] as any).bot_token).toBeUndefined();
  });
});
