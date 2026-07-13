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
  existingMappings: Map<number, ThreadMapping> = new Map()
): Promise<Map<number, ThreadMapping>> {
  const panes = getAgents();
  const map = new Map<number, ThreadMapping>();
  const created: string[] = [];
  const deleted: string[] = [];
  const failed: string[] = [];

  // Try to list existing topics first (works in supergroups with forum).
  // For private chats, this may 404 — that's fine, we just try to create blindly.
  let topics: TopicInfo[] = [];
  try {
    topics = await tg.getForumTopics(chatId);
  } catch {
    // getForumTopics not supported in this chat — proceed to try createForumTopic
  }

  // Deduplicate: for each pane, if multiple existing topics share its name,
  // keep the one that's already mapped (or the first), delete the rest.
  for (const pane of panes) {
    const labelLower = pane.label.toLowerCase();
    const matches = topics.filter((t) => t.name.toLowerCase() === labelLower);
    if (matches.length > 1) {
      // Prefer the one that's already mapped; otherwise keep the first.
      const preferred =
        matches.find((m) => existingMappings.has(m.message_thread_id)) ??
        matches[0];
      const toDelete = matches.filter((m) => m.message_thread_id !== preferred.message_thread_id);
      for (const dup of toDelete) {
        try {
          await tg.deleteForumTopic(chatId, dup.message_thread_id);
          deleted.push(`${dup.name} (#${dup.message_thread_id})`);
          topics = topics.filter((t) => t.message_thread_id !== dup.message_thread_id);
        } catch {
          // best-effort
        }
      }
    }
  }

  for (const pane of panes) {
    let threadId = matchTopic(pane, topics);
    if (!threadId) {
      try {
        threadId = await tg.createForumTopic(chatId, pane.label);
        topics.push({ message_thread_id: threadId, name: pane.label });
        created.push(pane.label);
      } catch {
        // Can't auto-create in this chat — user will bind manually with /bind
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

  // Stash diagnostics so the daemon can report them
  (reconcile as any).lastResult = { created, deleted, failed, total: panes.length };

  return map;
}

export function findMapping(
  threadId: number,
  map: Map<number, ThreadMapping>
): ThreadMapping | undefined {
  return map.get(threadId);
}
