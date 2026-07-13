import type { DaemonState, PaneInfo } from "./types.js";
import type { TelegramClient } from "./telegram-client.js";
import { getAgents, readPane } from "./herdr-client.js";
import { createLogger } from "./logger.js";

const log = createLogger("watcher");

/**
 * Watch for herdr tab changes and sync topics in Telegram.
 * - New agent pane (tab_id not in known_tabs) → create topic
 * - Closed agent pane (tab_id in known_tabs but not in current list) → delete topic
 * - Renamed tab (label changed) → edit topic name
 *
 * Returns the updated known_tabs and a log of changes for the caller to persist.
 */
export async function syncTabs(
  chatId: number,
  tg: TelegramClient,
  state: DaemonState
): Promise<{ changed: boolean; added: string[]; removed: string[]; renamed: string[] }> {
  const panes = getAgents();
  const knownTabs = state.known_tabs ?? {};

  const currentTabIds = new Set(panes.map((p) => p.tab_id));
  const knownTabIds = new Set(Object.keys(knownTabs));

  const added: string[] = [];
  const removed: string[] = [];
  const renamed: string[] = [];

  // Step 1: Detect removed tabs
  for (const tabId of knownTabIds) {
    if (!currentTabIds.has(tabId)) {
      const entry = knownTabs[tabId];
      try {
        await tg.deleteForumTopic(chatId, entry.thread_id);
        delete state.thread_mappings[entry.thread_id];
        delete knownTabs[tabId];
        removed.push(`${entry.label} (tab ${tabId})`);
      } catch (err: any) {
        log.warn("watcher: failed to delete topic", {
          tabId,
          threadId: entry.thread_id,
          error: err.message,
        });
      }
    }
  }

  // Step 2: Detect new tabs + renames
  for (const pane of panes) {
    const existing = knownTabs[pane.tab_id];
    if (!existing) {
      // New tab — create topic
      try {
        const threadId = await tg.createForumTopic(chatId, pane.label);
        knownTabs[pane.tab_id] = { label: pane.label, thread_id: threadId };
        state.thread_mappings[threadId] = {
          pane_id: pane.pane_id,
          label: pane.label,
          agent: pane.agent,
          created_at: new Date().toISOString(),
        };
        // Seed with last 5 lines
        try {
          const seed = readPane(pane.pane_id, 5);
          const trimmed = seed
            .split("\n")
            .filter((l) =>
              !l.includes("context-mode active") &&
              !l.startsWith("<session_") &&
              !l.startsWith("</session_") &&
              !l.match(/^ctx_\w+ >/) &&
              !l.match(/^[─━═]{20,}/) &&
              l.length < 300
            )
            .join("\n")
            .trim();
          if (trimmed) {
            await tg.sendMessage(chatId, threadId, `📝 Last output:\n\n${trimmed}`);
          }
        } catch {
          // best-effort seeding
        }
        added.push(`${pane.label} (tab ${pane.tab_id})`);
      } catch (err: any) {
        log.warn("watcher: failed to create topic", {
          pane: pane.label,
          error: err.message,
        });
      }
    } else if (existing.label !== pane.label) {
      // Renamed tab — edit topic name
      try {
        await tg.editForumTopic(chatId, existing.thread_id, pane.label);
        existing.label = pane.label;
        const mapping = state.thread_mappings[existing.thread_id];
        if (mapping) mapping.label = pane.label;
        renamed.push(`${pane.label} (tab ${pane.tab_id})`);
      } catch (err: any) {
        log.warn("watcher: failed to rename topic", {
          pane: pane.label,
          error: err.message,
        });
      }
    }
  }

  state.known_tabs = knownTabs;
  const changed = added.length + removed.length + renamed.length > 0;

  if (changed) {
    log.info("watcher: tab sync", { added, removed, renamed });
  }

  return { changed, added, removed, renamed };
}

/**
 * Start the watcher loop. Polls every `intervalMs` and calls syncTabs.
 * Stops when the abort signal fires.
 */
export function startWatcher(
  chatId: number,
  tg: TelegramClient,
  state: DaemonState,
  saveState: () => void,
  intervalMs: number = 30_000,
  abortSignal?: AbortSignal
): void {
  const tick = async () => {
    try {
      const result = await syncTabs(chatId, tg, state);
      if (result.changed) saveState();
      // Log every tick at debug level so we can verify it's actually running
      log.debug("watcher: tick", {
        added: result.added.length,
        removed: result.removed.length,
        renamed: result.renamed.length,
        knownTabs: Object.keys(state.known_tabs ?? {}).length,
      });
    } catch (err: any) {
      log.error("watcher: sync error", { error: err.message });
    }
  };

  // Run an initial sync immediately
  tick();

  const handle = setInterval(tick, intervalMs);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => clearInterval(handle));
  }
  log.info("watcher: started", { intervalMs });
}