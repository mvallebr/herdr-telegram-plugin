import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { DaemonState } from "./types.js";

export function loadState(stateDir?: string): DaemonState {
  const dir = stateDir ?? path.join(os.homedir(), ".local", "state", "herdr-telegram");
  const filePath = path.join(dir, "state.json");

  if (!fs.existsSync(filePath)) {
    return {
      authorized_chat_id: null,
      paired_at: null,
      thread_mappings: {},
      known_topics: {},
      known_tabs: {},
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as DaemonState;
  // Backfill new fields for older state files
  if (!parsed.known_topics) parsed.known_topics = {};
  if (!parsed.known_tabs) parsed.known_tabs = {};
  if (!parsed.processed_update_ids) parsed.processed_update_ids = [];
  return parsed;
}

/** Records an update id and returns true when it has already been processed. */
export function rememberUpdateId(state: DaemonState, updateId: number, maxEntries = 200): boolean {
  const ids = state.processed_update_ids ?? [];
  if (ids.includes(updateId)) return true;
  state.processed_update_ids = [...ids, updateId].slice(-maxEntries);
  return false;
}

export function saveState(stateDir: string | undefined, state: DaemonState): void {
  const dir = stateDir ?? path.join(os.homedir(), ".local", "state", "herdr-telegram");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}
