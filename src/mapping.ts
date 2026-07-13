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
  tg: TelegramClient
): Promise<Map<number, ThreadMapping>> {
  const panes = getAgents();
  const topics = await tg.getForumTopics(chatId);
  const map = new Map<number, ThreadMapping>();

  for (const pane of panes) {
    let threadId = matchTopic(pane, topics);
    if (!threadId) {
      threadId = await tg.createForumTopic(chatId, pane.label);
      topics.push({ message_thread_id: threadId, name: pane.label });
    }
    map.set(threadId, {
      pane_id: pane.pane_id,
      label: pane.label,
      agent: pane.agent,
      created_at: new Date().toISOString(),
    });
  }

  return map;
}

export function findMapping(
  threadId: number,
  map: Map<number, ThreadMapping>
): ThreadMapping | undefined {
  return map.get(threadId);
}
