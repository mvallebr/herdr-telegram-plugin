import { Bot } from "grammy";
import type { TopicInfo } from "./types.js";

export class TelegramClient {
  public bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  start(): void {
    this.bot.start({
      onStart: () => {
        // grammy logging is handled by our logger
      },
    });
  }

  async createForumTopic(chatId: number, name: string): Promise<number> {
    const result = await this.bot.api.createForumTopic(chatId, name);
    return result.message_thread_id;
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
      // DEBUG: dump full chat object to stderr when is_forum is falsy
      if (!chat.is_forum) {
        console.error("[DEBUG] getChat response:", JSON.stringify({ type: chat.type, is_forum: chat.is_forum, keys: Object.keys(chat) }));
        errors.push(
          "Topics are not enabled. Enable them in Group Settings → Topics."
        );
        return errors;
      }
    } catch (err: any) {
      errors.push(
        `Cannot access chat. Make sure the bot has been added to the group. (${err.message})`
      );
      return errors;
    }

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

    return errors;
  }
}
