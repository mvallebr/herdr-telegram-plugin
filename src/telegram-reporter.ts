import type { TurnReporter } from "./turn-coordinator.js";
import type { TelegramClient } from "./telegram-client.js";

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function truncate(text: string): string {
  return text.length <= 3900 ? text : `${text.slice(0, 3900)}\n\n... (truncated, ${text.length} chars total)`;
}

function sourceTag(source: string): string {
  if (source === "codex-jsonl") return " [codex session log]";
  if (source === "pi-jsonl") return " [pi session log]";
  if (source === "omp-jsonl") return " [omp session log]";
  return "";
}

/** Telegram adapter: presentation only; it owns no agent or polling logic. */
export class TelegramTurnReporter implements TurnReporter {
  constructor(
    private readonly telegram: Pick<TelegramClient, "sendMessage">,
    private readonly chatId: number,
    private readonly threadId: number,
    private readonly now: () => number,
    private readonly startedAt: number
  ) {}

  async progress(elapsedSeconds: number, preview?: string): Promise<void> {
    const body = preview ? `:\n\n${truncate(preview)}` : ".";
    await this.telegram.sendMessage(this.chatId, this.threadId, `⏳ Working (${formatElapsed(elapsedSeconds)})${body}`, { disable_notification: true });
  }

  async final(text: string, source: string, alreadyPublished = false): Promise<void> {
    const elapsed = Math.floor((this.now() - this.startedAt) / 1000);
    const body = alreadyPublished ? "." : ` ${sourceTag(source)}:\n\n${truncate(text)}`;
    await this.telegram.sendMessage(this.chatId, this.threadId, `✅ (${formatElapsed(elapsed)})${body}`);
  }

  async blocked(question?: string): Promise<void> {
    const body = question?.trim() ? `:\n\n${truncate(question)}` : ". Send a reply in this topic to continue.";
    await this.telegram.sendMessage(this.chatId, this.threadId, `⚠️ Agent needs input${body}`);
  }

  async failed(reason: string): Promise<void> {
    if (reason.includes("Codex JSONL")) {
      await this.telegram.sendMessage(this.chatId, this.threadId, "⚠️ Codex finished, but the bridge could not safely correlate its session-log response. No terminal output was forwarded.");
      return;
    }
    const elapsed = Math.floor((this.now() - this.startedAt) / 1000);
    await this.telegram.sendMessage(this.chatId, this.threadId, `⚠️ No response from pane after ${formatElapsed(elapsed)}.`);
  }
}
