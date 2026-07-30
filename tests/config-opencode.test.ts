/**
 * Tests for [agents.opencode] include_tools / include_thoughts config.
 *
 * The defaults must be `false` — the cumulative OpenCode reader is text-only
 * out of the box, and the user must explicitly opt in to surface tool/thought
 * summaries in Telegram.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("loadConfig — [agents.opencode] include_* flags", () => {
  const tmpDir = path.join(os.tmpdir(), "herdr-tg-config-opencode-" + Date.now());
  const configFile = path.join(tmpDir, "config.toml");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    delete process.env.HERDR_TG_BOT_TOKEN;
    delete process.env.HERDR_TG_CHAT_ID;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults include_tools and include_thoughts to false", () => {
    fs.writeFileSync(configFile, 'bot_token = "t"');
    const cfg = loadConfig(tmpDir);
    expect(cfg.opencodeIncludeTools).toBe(false);
    expect(cfg.opencodeIncludeThoughts).toBe(false);
  });

  it("parses include_tools = true under [agents.opencode]", () => {
    fs.writeFileSync(
      configFile,
      'bot_token = "t"\n[agents.opencode]\ninclude_tools = true\n',
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.opencodeIncludeTools).toBe(true);
    expect(cfg.opencodeIncludeThoughts).toBe(false);
  });

  it("parses include_thoughts = true under [agents.opencode]", () => {
    fs.writeFileSync(
      configFile,
      'bot_token = "t"\n[agents.opencode]\ninclude_thoughts = true\n',
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.opencodeIncludeThoughts).toBe(true);
    expect(cfg.opencodeIncludeTools).toBe(false);
  });

  it("parses both flags under [agents.opencode]", () => {
    fs.writeFileSync(
      configFile,
      'bot_token = "t"\n[agents.opencode]\ninclude_tools = true\ninclude_thoughts = true\n',
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.opencodeIncludeTools).toBe(true);
    expect(cfg.opencodeIncludeThoughts).toBe(true);
  });

  it("coerces non-true values to false (no string truthiness surprise)", () => {
    fs.writeFileSync(
      configFile,
      'bot_token = "t"\n[agents.opencode]\ninclude_tools = "yes"\n',
    );
    const cfg = loadConfig(tmpDir);
    // "yes" is not "true" — must remain false so a typo never silently
    // opts the user in to tool dumps.
    expect(cfg.opencodeIncludeTools).toBe(false);
  });
});
