import { Bot } from "grammy";
import type { TopicInfo } from "./types.js";

export type PollingState = "starting" | "running" | "retrying" | "failed" | "stopped";

export interface PollingStatus {
  state: PollingState;
  attempt: number;
  nextRetryAt?: number;
  error?: string;
}

type PollingObserver = (status: PollingStatus) => void;

const RETRYABLE_HTTP_CODES = new Set([409, 429, 500, 502, 503, 504]);

function errorCode(err: unknown): number | undefined {
  const e = err as { error_code?: unknown; error?: { error_code?: unknown } };
  const value = e?.error_code ?? e?.error?.error_code;
  return typeof value === "number" ? value : undefined;
}

function retryAfterMs(err: unknown, attempt: number): number {
  const e = err as { parameters?: { retry_after?: unknown }; error?: { parameters?: { retry_after?: unknown } } };
  const retryAfter = e?.parameters?.retry_after ?? e?.error?.parameters?.retry_after;
  if (typeof retryAfter === "number" && retryAfter > 0) return retryAfter * 1000;
  // Telegram can retain a previous getUpdates connection for about 30 seconds.
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  const minimum = errorCode(err) === 409 ? 30_000 : base;
  return minimum + Math.floor(Math.random() * Math.min(1_000, minimum / 10));
}

function isPermanent(err: unknown): boolean {
  return errorCode(err) === 401;
}

function isRetryable(err: unknown): boolean {
  const code = errorCode(err);
  // Network failures frequently have no HTTP response/code at all.
  return code === undefined || RETRYABLE_HTTP_CODES.has(code);
}

function describePollingError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export class TelegramClient {
  public bot: Bot;
  private pollingTask?: Promise<void>;
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryWake?: () => void;
  private status: PollingStatus = { state: "stopped", attempt: 0 };

  constructor(token: string, private readonly observe?: PollingObserver, bot?: Bot) {
    this.bot = bot ?? new Bot(token);
  }

  getPollingStatus(): PollingStatus {
    return { ...this.status };
  }

  private setStatus(status: PollingStatus): void {
    this.status = status;
    this.observe?.(this.getPollingStatus());
  }

  /** Initialise credentials, then keep one long-poll loop alive in the background. */
  async start(): Promise<void> {
    if (this.pollingTask) return;
    this.stopped = false;
    this.setStatus({ state: "starting", attempt: 0 });
    // This makes invalid bot tokens fail during daemon startup, before a PID is published.
    await this.bot.init();
    this.pollingTask = this.runPollingLoop();
  }

  private async runPollingLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.setStatus({ state: "running", attempt });
        await this.bot.start({ onStart: () => this.setStatus({ state: "running", attempt }) });
        if (!this.stopped) throw new Error("Telegram polling stopped unexpectedly");
      } catch (err) {
        if (this.stopped) break;
        const message = describePollingError(err);
        if (isPermanent(err) || !isRetryable(err)) {
          this.setStatus({ state: "failed", attempt, error: message });
          return;
        }
        attempt += 1;
        const delay = retryAfterMs(err, attempt);
        this.setStatus({ state: "retrying", attempt, nextRetryAt: Date.now() + delay, error: message });
        await new Promise<void>((resolve) => {
          this.retryWake = resolve;
          this.retryTimer = setTimeout(resolve, delay);
        });
        this.retryTimer = undefined;
        this.retryWake = undefined;
      }
    }
    this.setStatus({ state: "stopped", attempt });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryWake?.();
    this.retryTimer = undefined;
    this.retryWake = undefined;
    if (this.bot.isRunning()) await this.bot.stop();
    await this.pollingTask;
    this.pollingTask = undefined;
  }

  async createForumTopic(chatId: number, name: string): Promise<number> {
    const result = await this.bot.api.createForumTopic(chatId, name);
    return result.message_thread_id;
  }

  async deleteForumTopic(chatId: number, messageThreadId: number): Promise<void> {
    await this.bot.api.deleteForumTopic(chatId, messageThreadId);
  }

  async editForumTopic(chatId: number, messageThreadId: number, name: string): Promise<void> {
    await this.bot.api.editForumTopic(chatId, messageThreadId, { name });
  }

  async getForumTopics(chatId: number): Promise<TopicInfo[]> {
    try {
      // grammy 1.x doesn't expose getForumTopics on typed API; use raw
      const result: any[] = await (this.bot.api as any).raw.getForumTopics({ chat_id: chatId });
      return result.map((t: any) => ({
        message_thread_id: t.message_thread_id,
        name: t.name,
      }));
    } catch {
      return [];
    }
  }

  async sendChatAction(chatId: number, threadId: number): Promise<void> {
    // Use 'typing' action; silent (no user-visible notification) and fails
    // with TOPIC_ID_INVALID if the thread was deleted.
    await this.bot.api.sendChatAction(chatId, "typing", { message_thread_id: threadId });
  }

  async sendMessage(
    chatId: number,
    threadId: number,
    text: string,
    opts?: { disable_notification?: boolean }
  ): Promise<number> {
    const msg = await this.bot.api.sendMessage(chatId, text, {
      message_thread_id: threadId,
      disable_notification: opts?.disable_notification ?? false,
    });
    return msg.message_id;
  }

  async validatePermissions(chatId: number): Promise<string[]> {
    const errors: string[] = [];

    try {
      const chat = await this.bot.api.getChat(chatId);
      const chatType = chat.type;
      // Allow private chats, groups, and supergroups (with or without topics).
      // Only supergroups with is_forum require admin + can_manage_topics.
      // Private chats only need the chat to be reachable.
      if (chatType === "supergroup" && chat.is_forum) {
        try {
          const me = await this.bot.api.getMe();
          const member = await this.bot.api.getChatMember(chatId, me.id);
          if (!["creator", "administrator"].includes(member.status)) {
            errors.push(
              "Bot is not an administrator. Promote via Group Settings → Administrators → Add Administrator."
            );
            return errors;
          }
          if (member.status === "administrator" && !(member as any).can_manage_topics) {
            errors.push(
              "Bot lacks 'Manage Topics' permission. Enable in Group Settings → Administrators → @yourbot → Manage Topics."
            );
          }
        } catch (err: any) {
          errors.push(`Cannot check bot permissions. ${err.message}`);
        }
      } else if (chatType === "group") {
        // Legacy group (no forum) — bot just needs to be reachable.
        // No admin requirement; user already started the bot.
      }
      // private / channel: no extra checks
    } catch (err: any) {
      errors.push(
        `Cannot access chat. Make sure the bot has been added. (${err.message})`
      );
    }

    return errors;
  }
}
