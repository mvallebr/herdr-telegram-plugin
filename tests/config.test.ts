import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("loadConfig", () => {
  const tmpDir = path.join(os.tmpdir(), "herdr-telegram-test-" + Date.now());
  const configFile = path.join(tmpDir, "config.toml");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    delete process.env.HERDR_TG_BOT_TOKEN;
    delete process.env.HERDR_TG_CHAT_ID;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads bot_token from config.toml", () => {
    fs.writeFileSync(configFile, 'bot_token = "test-token-123"');
    const cfg = loadConfig(tmpDir);
    expect(cfg.botToken).toBe("test-token-123");
    expect(cfg.chatId).toBeNull();
    expect(cfg.throttleMs).toBe(60_000);
    expect(cfg.progressIntervalMs).toBe(15_000);
    expect(cfg.maxProgressUpdates).toBe(60);
  });

  it("prefers env var over file", () => {
    process.env.HERDR_TG_BOT_TOKEN = "env-token";
    fs.writeFileSync(configFile, 'bot_token = "file-token"');
    const cfg = loadConfig(tmpDir);
    expect(cfg.botToken).toBe("env-token");
  });

  it("throws if no bot_token found", () => {
    expect(() => loadConfig(tmpDir)).toThrow(/bot_token/);
  });

  it("uses env chat_id if set", () => {
    process.env.HERDR_TG_CHAT_ID = "-100123";
    fs.writeFileSync(configFile, 'bot_token = "t"');
    const cfg = loadConfig(tmpDir);
    expect(cfg.chatId).toBe(-100123);
  });
});
