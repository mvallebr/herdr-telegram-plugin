import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spawn tests for `node dist/index.js`. These verify the CLI behaves the same
 * way regardless of the cwd it's invoked from (the post-install scenario where
 * herdr plugin install places the bundle in ~/.config/herdr/plugins/... and
 * the user runs `node dist/index.js --status` from there).
 */

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ENTRY = join(PLUGIN_ROOT, "dist/index.js");

function runCli(args: string[], opts: { cwd?: string } = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("node", [DIST_ENTRY, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? PLUGIN_ROOT,
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("CLI: --help", () => {
  it("prints usage and exits 0", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("herdr-telegram-plugin");
    expect(r.stdout).toContain("--daemon");
    expect(r.stdout).toContain("--status");
  });
});

describe("CLI: --status", () => {
  it("runs without error from any cwd (plugin-install scenario)", () => {
    // Simulate running from the post-install dir (e.g. ~/.config/herdr/plugins/...)
    // We just use /tmp here — the point is cwd must not matter.
    const r = runCli(["--status"], { cwd: "/tmp" });
    // Either exits 0 (running or not running) — must not crash with ENOENT or similar.
    expect([0, 1]).toContain(r.status);
    expect(r.stdout).toMatch(/^(Daemon: (running|not running))/);
  });

  it("reports the persisted polling state for a live PID", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "herdr-status-test-"));
    const daemonDir = join(stateRoot, "herdr-telegram");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(join(daemonDir, "daemon.pid"), String(process.pid));
    writeFileSync(join(daemonDir, "state.json"), JSON.stringify({ authorized_chat_id: null }));
    writeFileSync(join(daemonDir, "polling-status.json"), JSON.stringify({ state: "retrying" }));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateRoot;
    try {
      const r = runCli(["--status"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Polling: retrying");
    } finally {
      process.env.XDG_STATE_HOME = previous;
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("CLI: --daemon (lifecycle)", () => {
  let stateDir: string;
  let configDir: string;

  beforeEach(() => {
    // Point state at a temp dir so we don't disturb the user's actual state.
    stateDir = mkdtempSync(join(tmpdir(), "herdr-cli-test-"));
    configDir = mkdtempSync(join(tmpdir(), "herdr-cli-config-test-"));
    process.env.XDG_STATE_HOME = stateDir;
    process.env.HERDR_TG_CONFIG_DIR = configDir;
    // Kill any daemon from a previous test run
    const pidFile = join(stateDir, "herdr-telegram/daemon.pid");
    if (existsSync(pidFile)) {
      const pid = parseInt(require("node:fs").readFileSync(pidFile, "utf8"), 10);
      try { process.kill(pid, 9); } catch {}
    }
  });

  afterEach(() => {
    const pidFile = join(stateDir, "herdr-telegram/daemon.pid");
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(require("node:fs").readFileSync(pidFile, "utf8"), 10);
        process.kill(pid, 9);
      } catch {}
    }
    delete process.env.XDG_STATE_HOME;
    delete process.env.HERDR_TG_CONFIG_DIR;
    if (existsSync(stateDir)) {
      try { rmSync(stateDir, { recursive: true }); } catch {}
    }
    if (existsSync(configDir)) {
      try { rmSync(configDir, { recursive: true }); } catch {}
    }
  });

  // NOTE: starting a real daemon requires a bot token in config + network.
  // We skip this in CI; the unit tests for daemon internals cover the logic.

  it("does not leave a PID file when startup validation fails", () => {
    const result = runCli(["--daemon"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bot_token not found");
    expect(existsSync(join(stateDir, "herdr-telegram/daemon.pid"))).toBe(false);
  });

  it.skip("starts a daemon, second invocation refuses to double-start", () => {
    // Skipped because requires real Telegram bot config. To run locally:
    //   1. Set HERDR_TG_BOT_TOKEN env var
    //   2. Remove .skip from this test
    const first = runCli(["--daemon"]);
    expect(first.status).toBe(0);
    const second = runCli(["--daemon"]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already running");
  });
});
