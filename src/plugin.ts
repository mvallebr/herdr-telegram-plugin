// This file is called by herdr on `pane.agent_status_changed` events.
// Its only job: ensure the daemon is running. If not, spawn it.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const stateDir = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "herdr-telegram"
);

const pidFile = join(stateDir, "daemon.pid");

function isRunning(): boolean {
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8"), 10);
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

if (!isRunning()) {
  // Spawn daemon
  spawn(
    process.execPath,
    [join(process.env.HERDR_PLUGIN_ROOT ?? __dirname, "dist", "index.js"), "--daemon"],
    { detached: true, stdio: "ignore" }
  ).unref();
}
