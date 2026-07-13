#!/usr/bin/env node
import { startDaemon } from "./daemon.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const stateDir = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "herdr-telegram"
);

const args = process.argv.slice(2);

if (args.includes("--status")) {
  const pidFile = join(stateDir, "daemon.pid");
  const running = existsSync(pidFile)
    ? (() => { try { process.kill(parseInt(readFileSync(pidFile, "utf8"), 10), 0); return true; } catch { return false; } })()
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
  // Write PID file (use top-level imports already available)
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "daemon.pid"), String(process.pid), "utf8");

  process.stdout.write(`Daemon started (PID ${process.pid})\n`);
  startDaemon();

  // Clean PID on exit
  process.on("exit", () => {
    try { unlinkSync(join(stateDir, "daemon.pid")); } catch {}
  });
}
