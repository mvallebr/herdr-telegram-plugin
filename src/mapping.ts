import type { PaneInfo, TopicInfo, ThreadMapping } from "./types.js";
import { getAgents } from "./herdr-client.js";
import type { TelegramClient } from "./telegram-client.js";

export function matchTopic(
  pane: PaneInfo,
  topics: TopicInfo[]
): number | undefined {
  const label = pane.label.toLowerCase();
  const match = topics.find((t) => t.name.toLowerCase() === label);
  return match?.message_thread_id;
}

export function resolveOrphanTopics(
  panes: PaneInfo[],
  topics: TopicInfo[],
  existingMappings: Map<number, ThreadMapping>
): TopicInfo[] {
  return topics.filter((t) => !existingMappings.has(t.message_thread_id));
}

export async function reconcile(
  chatId: number,
  tg: TelegramClient,
  existingMappings: Map<number, ThreadMapping> = new Map(),
  knownTopics: Record<number, { name: string; created_at: string }> = {}
): Promise<Map<number, ThreadMapping>> {
  const panes = getAgents();
  // Telegram appends topics to the bottom, so reverse to get the right visual order
  panes.reverse();
  const map = new Map<number, ThreadMapping>();
  const created: string[] = [];
  const deleted: string[] = [];
  const failed: string[] = [];

  // Step 1: Deduplicate based on known_topics (works without getForumTopics).
  // Group known topics by name; for any name with >1 topic, delete all but the
  // one that's currently bound (or the first).
  const byName = new Map<string, number[]>();
  for (const [tidStr, info] of Object.entries(knownTopics)) {
    const tid = Number(tidStr);
    const name = info.name.toLowerCase();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(tid);
  }
  for (const [name, tids] of byName.entries()) {
    if (tids.length <= 1) continue;
    const bound = tids.find((t) => existingMappings.has(t));
    const keep = bound ?? tids[0];
    const toDelete = tids.filter((t) => t !== keep);
    for (const tid of toDelete) {
      try {
        await tg.deleteForumTopic(chatId, tid);
        deleted.push(`${name} (#${tid})`);
        delete knownTopics[tid];
      } catch {
        // best-effort; if delete fails, leave it in known_topics for next time
      }
    }
  }

  // Step 2: For each pane, find or create a topic.
  for (const pane of panes) {
    const labelLower = pane.label.toLowerCase();

    // Check if any existing mapping already covers this pane by pane_id.
    let threadId: number | undefined;
    for (const [tid, m] of existingMappings.entries()) {
      if (m.pane_id === pane.pane_id) {
        threadId = tid;
        break;
      }
    }
    // Else check known_topics for a topic with the right name.
    if (!threadId) {
      for (const [tidStr, info] of Object.entries(knownTopics)) {
        if (info.name.toLowerCase() === labelLower) {
          threadId = Number(tidStr);
          break;
        }
      }
    }
    // Else create a new topic.
    if (!threadId) {
      try {
        threadId = await tg.createForumTopic(chatId, pane.label);
        knownTopics[threadId] = {
          name: pane.label,
          created_at: new Date().toISOString(),
        };
        created.push(pane.label);
      } catch {
        failed.push(pane.label);
        continue;
      }
    }

    map.set(threadId, {
      pane_id: pane.pane_id,
      label: pane.label,
      agent: pane.agent,
      created_at: new Date().toISOString(),
    });
  }

  (reconcile as any).lastResult = { created, deleted, failed, total: panes.length };

  return map;
}

export function findMapping(
  threadId: number,
  map: Map<number, ThreadMapping>
): ThreadMapping | undefined {
  return map.get(threadId);
}
