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
  /** How often the coordinator asks a wrapper for status. */
  progressIntervalMs: number;
  /** Min ms the pane must remain unchanged before a screen-scrape turn is
   *  declared final. Larger values tolerate herdr's idle-flicker during long
   *  tool calls. Default 30000. */
  stabilityWindowMs: number;
  /** Default minutes a /follow subscription stays alive after the last user
   *  message before expiring. 0 = no timeout, manual /unsubscribe required.
   *  Default 30. */
  followTimeoutMinutes: number;
  /** Per-agent paths to data stores. Each key is an agent name (e.g. "opencode",
   *  "codex"); value is a map from data key to path. Default paths are inferred
   *  from $HOME (e.g. ~/.local/share/opencode/opencode.db). Override per-agent
   *  paths via [agents] section in config.toml. */
  agentPaths: Record<string, Record<string, string>>;
  /** [agents.opencode] include_tools = true — surface compact tool summaries
   *  prefixed `🔧` in the cumulative snapshot. Default false. */
  opencodeIncludeTools: boolean;
  /** [agents.opencode] include_thoughts = true — surface reasoning/thinking
   *  parts prefixed `💭` in the cumulative snapshot. Default false. */
  opencodeIncludeThoughts: boolean;
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
  let fileProgressIntervalMs = 15_000;
  let fileStabilityWindowMs = 30_000;
  let fileFollowTimeoutMinutes = 30;
  let fileAgentPaths: Record<string, Record<string, string>> = {};
  let fileOpencodeIncludeTools = false;
  let fileOpencodeIncludeThoughts = false;

  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    let inTelegram = false;
    let inAgents = false;
    let currentAgent: string | null = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line === "[telegram]") { inTelegram = true; inAgents = false; continue; }
      if (line.startsWith("[agents.") && line.endsWith("]")) {
        // e.g. [agents.opencode]
        inTelegram = false;
        inAgents = true;
        currentAgent = line.slice(8, -1);
        if (!fileAgentPaths[currentAgent]) fileAgentPaths[currentAgent] = {};
        continue;
      }
      if (line === "[agents]") {
        inTelegram = false;
        inAgents = true;
        currentAgent = null;
        continue;
      }
      if (line.startsWith("[")) { inTelegram = false; inAgents = false; currentAgent = null; continue; }
      const kv = parseTomlLine(line);
      if (!kv) continue;
      if (inTelegram) {
        if (kv[0] === "bot_token") fileBotToken = kv[1];
        else if (kv[0] === "chat_id") fileChatId = parseInt(kv[1], 10);
        else if (kv[0] === "throttle_ms") fileThrottleMs = parseInt(kv[1], 10);
        else if (kv[0] === "wait_timeout_s") fileWaitTimeoutS = parseInt(kv[1], 10);
        else if (kv[0] === "max_total_wait_s") fileMaxTotalWaitS = parseInt(kv[1], 10);
        else if (kv[0] === "max_progress_updates") fileMaxProgressUpdates = parseInt(kv[1], 10);
        else if (kv[0] === "progress_interval_ms") fileProgressIntervalMs = parseInt(kv[1], 10);
        else if (kv[0] === "stability_window_ms") fileStabilityWindowMs = parseInt(kv[1], 10);
        else if (kv[0] === "follow_timeout_minutes") fileFollowTimeoutMinutes = parseInt(kv[1], 10);
      } else if (inAgents && currentAgent) {
        // Per-agent data paths, e.g. db = "/path/to/db"
        if (currentAgent === "opencode") {
          if (kv[0] === "include_tools") fileOpencodeIncludeTools = kv[1] === "true";
          else if (kv[0] === "include_thoughts") fileOpencodeIncludeThoughts = kv[1] === "true";
          else fileAgentPaths[currentAgent][kv[0]] = kv[1];
        } else {
          fileAgentPaths[currentAgent][kv[0]] = kv[1];
        }
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
    progressIntervalMs: fileProgressIntervalMs,
    stabilityWindowMs: fileStabilityWindowMs,
    followTimeoutMinutes: fileFollowTimeoutMinutes,
    agentPaths: fileAgentPaths,
    opencodeIncludeTools: fileOpencodeIncludeTools,
    opencodeIncludeThoughts: fileOpencodeIncludeThoughts,
  };
}
