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
}
