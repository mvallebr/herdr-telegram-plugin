import type { Config } from "./config.js";
import type { TelegramClient } from "./telegram-client.js";
import { sendText, waitIdle, readPane } from "./herdr-client.js";

export function shouldThrottle(lastSentAt: number, throttleMs: number): boolean {
  return Date.now() - lastSentAt < throttleMs;
}

export function formatElapsed(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export async function runAgentTurn(
  paneId: string,
  threadId: number,
  text: string,
  cfg: Config,
  tg: TelegramClient,
  chatId: number,
  maxOutputLines: number = 200
): Promise<void> {
  sendText(paneId, text);

  let lastSent = 0;
  const startTime = Date.now();

  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed >= cfg.maxTotalWaitS) {
      await tg.sendMessage(chatId, threadId, `⏳ Tempo limite excedido (${formatElapsed(elapsed)})`);
      break;
    }

    const result = waitIdle(paneId, cfg.waitTimeoutS);

    if (result.status === "idle") {
      const content = readPane(paneId, maxOutputLines);
      const truncated = content.length > 3900
        ? content.slice(0, 3900) + `\n\n... (truncated, ${content.length} chars total)`
        : content;
      await tg.sendMessage(chatId, threadId, `✅ (${formatElapsed(elapsed)}):\n\n${truncated}`);
      break;
    }

    if (result.status === "timeout") {
      if (shouldThrottle(lastSent, cfg.throttleMs)) continue;
      const content = readPane(paneId, 15);
      const truncated = content.length > 2000
        ? content.slice(0, 2000) + "..."
        : content;
      await tg.sendMessage(chatId, threadId, `⏳ Working (${formatElapsed(elapsed)}):\n\n${truncated}`, { disable_notification: true });
      lastSent = Date.now();
    }

    if (result.status === "blocked") {
      const content = readPane(paneId, 30);
      const truncated = content.length > 2000
        ? content.slice(0, 2000) + "..."
        : content;
      await tg.sendMessage(chatId, threadId, `⚠️ Blocked (tool approval):\n\n${truncated}`);
      break;
    }
  }
}
