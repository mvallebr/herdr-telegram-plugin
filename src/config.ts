import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface Config {
  botToken: string;
  chatId: number | null;
  throttleMs: number;
  waitTimeoutS: number;
  maxTotalWaitS: number;
  /** Max Working progress updates before giving up (-1 = unlimited). Default 60. */
  maxProgressUpdates: number;
}

function parseTomlLine(line: string): [string, string] | null {
  const i = line.indexOf("=");
  if (i === -1) return null;
  const key = line.slice(0, i).trim();
  let val = line.slice(i + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return [key, val];
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? path.join(os.homedir(), ".config", "herdr-telegram");
  const filePath = path.join(dir, "config.toml");

  let fileBotToken = "";
  let fileChatId: number | null = null;
  let fileThrottleMs = 60_000;
  let fileWaitTimeoutS = 300;
  let fileMaxTotalWaitS = 1800;
  let fileMaxProgressUpdates = 60;

  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    let inTelegram = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line === "[telegram]") { inTelegram = true; continue; }
      if (line.startsWith("[")) { inTelegram = false; continue; }
      const kv = parseTomlLine(line);
      if (!kv) continue;
      if (inTelegram) {
        if (kv[0] === "bot_token") fileBotToken = kv[1];
        else if (kv[0] === "chat_id") fileChatId = parseInt(kv[1], 10);
        else if (kv[0] === "throttle_ms") fileThrottleMs = parseInt(kv[1], 10);
        else if (kv[0] === "wait_timeout_s") fileWaitTimeoutS = parseInt(kv[1], 10);
        else if (kv[0] === "max_total_wait_s") fileMaxTotalWaitS = parseInt(kv[1], 10);
        else if (kv[0] === "max_progress_updates") fileMaxProgressUpdates = parseInt(kv[1], 10);
      } else if (kv[0] === "bot_token") {
        fileBotToken = kv[1];
      }
    }
  }

  const botToken = process.env.HERDR_TG_BOT_TOKEN || fileBotToken;
  if (!botToken) {
    throw new Error(
      "bot_token not found. Set HERDR_TG_BOT_TOKEN env var or add bot_token to " + filePath
    );
  }

  const chatId =
    process.env.HERDR_TG_CHAT_ID !== undefined
      ? parseInt(process.env.HERDR_TG_CHAT_ID, 10)
      : fileChatId;

  return {
    botToken,
    chatId,
    throttleMs: fileThrottleMs,
    waitTimeoutS: fileWaitTimeoutS,
    maxTotalWaitS: fileMaxTotalWaitS,
    maxProgressUpdates: fileMaxProgressUpdates,
  };
}
