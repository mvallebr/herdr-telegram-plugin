#!/usr/bin/env node
import { startDaemon } from "./daemon.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Always chdir to the script's own directory so paths like `./dist/` resolve
// correctly even when invoked from a different cwd (e.g. via `herdr plugin`).
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  process.chdir(__dirname);
} catch {
  // chdir can fail in some restricted environments — fall back to absolute paths later
}

const stateDir = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "herdr-telegram"
);

const args = process.argv.slice(2);

function usage(): void {
  process.stdout.write(`herdr-telegram-plugin

Usage:
  node dist/index.js --daemon    Start the daemon (background)
  node dist/index.js --status     Check if daemon is running
  node dist/index.js --help       Show this help

Config: $HOME/.config/herdr-telegram/config.toml (with bot_token)
State:  ${stateDir}/state.json

Tip: prefer "herdr plugin ..." commands over calling node directly.
     The herdr CLI handles dependency installation and lifecycle correctly.
`);
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

if (args.includes("--status")) {
  const pidFile = join(stateDir, "daemon.pid");
  const running = existsSync(pidFile)
    ? (() => {
        try {
          process.kill(parseInt(readFileSync(pidFile, "utf8"), 10), 0);
          return true;
        } catch {
          return false;
        }
      })()
    : false;
  if (running) {
    const pid = readFileSync(pidFile, "utf8").trim();
    const stateFile = join(stateDir, "state.json");
    const paired = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, "utf8")).authorized_chat_id !== null
      : false;
    process.stdout.write(`Daemon: running (PID ${pid}) | Paired: ${paired ? "yes" : "no"}\n`);
    process.exit(0);
  } else {
    process.stdout.write("Daemon: not running\n");
    process.exit(0);
  }
}

if (args.includes("--daemon")) {
  // Refuse to double-start
  const pidFile = join(stateDir, "daemon.pid");
  if (existsSync(pidFile)) {
    const oldPid = parseInt(readFileSync(pidFile, "utf8"), 10);
    try {
      process.kill(oldPid, 0);
      process.stderr.write(`Daemon already running (PID ${oldPid}). Use 'node dist/index.js --status' to check.\n`);
      process.exit(1);
    } catch {
      // Stale PID — overwrite below
    }
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pidFile, String(process.pid), "utf8");

  process.stdout.write(`Daemon started (PID ${process.pid})\n`);
  try {
    startDaemon();
  } catch (err: any) {
    process.stderr.write(`Daemon failed to start: ${err.message}\n`);
    try {
      unlinkSync(pidFile);
    } catch {}
    process.exit(1);
  }

  process.on("exit", () => {
    try {
      unlinkSync(pidFile);
    } catch {}
  });
}
