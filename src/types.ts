export interface PaneInfo {
  pane_id: string;
  label: string;
  agent: string;
  tab_id: string;
  workspace_id: string;
  status: "idle" | "working" | "blocked" | "unknown";
}

export interface ThreadMapping {
  pane_id: string;
  label: string;
  agent: string;
  created_at: string;
}

export interface TopicInfo {
  message_thread_id: number;
  name: string;
}

export interface DaemonState {
  authorized_chat_id: number | null;
  paired_at: string | null;
  thread_mappings: Record<number, ThreadMapping>;
  /** Topics the bot has ever created in this chat. Maps thread_id -> { name, created_at }.
   *  Used for dedup because getForumTopics returns 404 in private chats. */
  known_topics?: Record<number, { name: string; created_at: string }>;
  /** Tabs the bot has observed. Maps tab_id -> { label, thread_id }.
   *  Used by the watcher to detect new/closed/renamed tabs. */
  known_tabs?: Record<string, { label: string; thread_id: number }>;
  /** Recently handled Telegram update ids, retained to prevent replay after restart. */
  processed_update_ids?: number[];
}
