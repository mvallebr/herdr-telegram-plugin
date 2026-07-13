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
  const map = new Map<number, ThreadMapping>();

  // Detect whether the chat supports forum topics
  let useForum = false;
  let topics: TopicInfo[] = [];
  try {
    const chat = await tg.bot.api.getChat(chatId);
    useForum = chat.type === "supergroup" && Boolean((chat as any).is_forum);
    if (useForum) {
      topics = await tg.getForumTopics(chatId);
    }
  } catch {
    // ignore: fall back to manual binding via /bind
  }

  if (useForum) {
    for (const pane of panes) {
      let threadId = matchTopic(pane, topics);
      if (!threadId) {
        try {
          threadId = await tg.createForumTopic(chatId, pane.label);
          topics.push({ message_thread_id: threadId, name: pane.label });
        } catch {
          // forum topic creation failed; user must bind manually
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
  }
  // For private chats (or groups without forum), we return an empty map.
  // The user creates threads via Telegram UI and binds them with /bind.

  return map;
}

export function findMapping(
  threadId: number,
  map: Map<number, ThreadMapping>
): ThreadMapping | undefined {
  return map.get(threadId);
}
