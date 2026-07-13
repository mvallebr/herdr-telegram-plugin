import type { DaemonState } from "./types.js";
import { loadState, saveState } from "./state.js";

export function isPaired(state: DaemonState): boolean {
  return state.authorized_chat_id !== null;
}

export function updatePairing(stateDir: string, chatId: number): DaemonState {
  const state = loadState(stateDir);
  state.authorized_chat_id = chatId;
  state.paired_at = new Date().toISOString();
  saveState(stateDir, state);
  return state;
}
