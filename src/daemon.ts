import { TelegramClient } from "./telegram-client.js";
import { registerCommands, type CommandDeps } from "./commands.js";
import { isPaired, updatePairing } from "./pairing.js";
import { reconcile, findMapping } from "./mapping.js";
import { runAgentTurn } from "./wait-loop.js";
import { loadConfig } from "./config.js";
import { loadState, saveState } from "./state.js";
import { createLogger } from "./logger.js";
import type { DaemonState } from "./types.js";
import * as path from "node:path";

export async function startDaemon(configDir?: string, stateDir?: string): Promise<{ stop: () => void }> {
  const log = createLogger("daemon");
  const cfg = loadConfig(configDir);
  const statePath = stateDir ?? path.join(
    process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".local", "state"),
    "herdr-telegram"
  );

  let state = loadState(statePath);
  const tg = new TelegramClient(cfg.botToken);

  if (isPaired(state) && state.authorized_chat_id) {
    const errors = await tg.validatePermissions(state.authorized_chat_id);
    if (errors.length > 0) {
      log.warn("Permission validation failed on startup", { errors });
      await tg.sendMessage(
        state.authorized_chat_id, 1,
        "⚠️ Permission check failed:\n" + errors.map(e => "- " + e).join("\n") +
        "\n\nBridge in read-only mode. Fix permissions and restart."
      );
    }
  }

  const map = isPaired(state) && state.authorized_chat_id
    ? await reconcile(state.authorized_chat_id!, tg)
    : new Map<number, DaemonState["thread_mappings"][keyof DaemonState["thread_mappings"]]>();

  const rawMappings: DaemonState["thread_mappings"] = {};
  for (const [tid, m] of map.entries()) rawMappings[tid] = m;
  saveState(statePath, { ...state, thread_mappings: rawMappings });

  const deps: CommandDeps = {
    map,
    stateDir: statePath,
    chatId: state.authorized_chat_id ?? 0,
    startTime: Date.now(),
  };

  registerCommands(tg.bot, deps);

  tg.bot.command("pair", async (ctx) => {
    if (isPaired(state)) {
      await ctx.reply("Already paired. Delete state.json to re-pair.");
      return;
    }
    const chatId = ctx.chat.id;
    const errors = await tg.validatePermissions(chatId);
    if (errors.length > 0) {
      await ctx.reply("Cannot pair:\n" + errors.map(e => "- " + e).join("\n"));
      return;
    }
    state = updatePairing(statePath, chatId);
    deps.chatId = chatId;
    await ctx.reply("✅ Chat authorized. Reconciling tabs...");
    const newMap = await reconcile(chatId, tg);
    for (const [tid, m] of newMap.entries()) deps.map.set(tid, m);
    await ctx.reply("Reconciliation complete. Send a message in any topic.");
  });

  tg.bot.on("message:text", async (ctx) => {
    if (!isPaired(state) || !state.authorized_chat_id) return;
    const chatId = ctx.chat.id;
    if (chatId !== state.authorized_chat_id) return;

    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;

    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("Topic not mapped to a pane. Run /agents to see status.");
      return;
    }

    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return;

    await runAgentTurn(mapping.pane_id, threadId, text, cfg, tg, chatId);
  });

  tg.start();
  log.info("Daemon started", { paired: isPaired(state), panes: map.size });

  return {
    stop: () => tg.bot.stop(),
  };
}
