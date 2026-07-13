import { TelegramClient } from "./telegram-client.js";
import { registerCommands, type CommandDeps } from "./commands.js";
import { isPaired, updatePairing } from "./pairing.js";
import { reconcile, findMapping } from "./mapping.js";
import { runAgentTurn } from "./wait-loop.js";
import { getAgents } from "./herdr-client.js";
import { loadConfig } from "./config.js";
import { loadState, saveState } from "./state.js";
import { createLogger, type Logger } from "./logger.js";
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

  // Re-validate existing pairing
  if (isPaired(state) && state.authorized_chat_id) {
    const errors = await tg.validatePermissions(state.authorized_chat_id);
    if (errors.length > 0) {
      log.warn("Permission validation failed on startup", { errors });
      await tg.sendMessage(
        state.authorized_chat_id, 1, // send to General topic (thread 1)
        "⚠️ Permission check failed:\n" + errors.map(e => "- " + e).join("\n") +
        "\n\nBridge in read-only mode. Fix permissions and restart."
      );
    }
  }

  const map = isPaired(state) && state.authorized_chat_id
    ? await reconcile(state.authorized_chat_id!, tg)
    : new Map<number, typeof state.thread_mappings[keyof typeof state.thread_mappings]>();

  // Persist initial mapping
  const rawMappings: DaemonState["thread_mappings"] = {};
  for (const [tid, m] of map.entries()) rawMappings[tid] = m;
  saveState(statePath, { ...state, thread_mappings: rawMappings });

  const deps: CommandDeps = {
    map,
    stateDir: statePath,
    chatId: state.authorized_chat_id ?? 0,
    startTime: Date.now(),
    saveMappings: () => {
      const raw: DaemonState["thread_mappings"] = {};
      for (const [tid, m] of deps.map.entries()) raw[tid] = m;
      saveState(statePath, { ...state, thread_mappings: raw });
    },
  };

  registerCommands(tg.bot, deps);

  // Pairing flow
  tg.bot.command("pair", async (ctx) => {
    if (isPaired(state)) {
      await ctx.reply("Already paired. Send /unpair first to re-pair with a different chat.");
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
    const rawMappings: DaemonState["thread_mappings"] = {};
    for (const [tid, m] of newMap.entries()) rawMappings[tid] = m;
    saveState(statePath, { ...state, thread_mappings: rawMappings });
    const result = (reconcile as any).lastResult as { created: string[]; failed: string[]; total: number } | undefined;
    if (result && result.failed.length > 0) {
      await ctx.reply(
        `Reconciliation: ${newMap.size} panes mapped.\n` +
        `Auto-created ${result.created.length} topics.\n` +
        `Could not auto-create: ${result.failed.join(", ")}\n` +
        `For those, create a thread via Telegram UI and use /bind <pane-label>.`
      );
    } else {
      await ctx.reply(`Reconciliation complete: ${newMap.size} topics mapped. Send a message in any topic.`);
    }
  });

  // Handle plain text (routed via thread_id)
  tg.bot.on("message:text", async (ctx) => {
    if (!isPaired(state) || !state.authorized_chat_id) return;

    const chatId = ctx.chat.id;
    if (chatId !== state.authorized_chat_id) return;

    const text = ctx.message.text;
    // Commands are handled by their own handlers — don't fall through to the picker.
    if (!text || text.startsWith("/")) return;

    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      // Message in main chat (no thread) — ignore or prompt to use a thread
      await ctx.reply(
        "Send messages inside a thread (tap + or New Thread in the chat header). Use /bind <pane-label> inside the thread to bind it."
      );
      return;
    }

    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      const panes = getAgents();
      const buttons = panes.map((p) => [
        { text: `${p.label} (${p.agent})`, callback_data: `bind:${p.pane_id}:${threadId}` },
      ]);
      await ctx.reply(
        "This thread is not bound to a pane. Pick one:",
        { reply_markup: { inline_keyboard: buttons } }
      );
      return;
    }

    await runAgentTurn(mapping.pane_id, threadId, text, cfg, tg, chatId);
  });

  // Handle inline keyboard taps for thread binding
  tg.bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const match = data.match(/^bind:(.+?):(\d+)$/);
    if (!match) return;
    const [, paneId, threadIdStr] = match;
    const threadId = parseInt(threadIdStr, 10);
    const panes = getAgents();
    const pane = panes.find((p) => p.pane_id === paneId);
    if (!pane) {
      await ctx.answerCallbackQuery({ text: "Pane no longer exists." });
      return;
    }
    deps.map.set(threadId, {
      pane_id: pane.pane_id,
      label: pane.label,
      agent: pane.agent,
      created_at: new Date().toISOString(),
    });
    deps.saveMappings();
    await ctx.answerCallbackQuery({ text: `Bound to ${pane.label}` });
    await ctx.editMessageText(`Bound this thread to ${pane.label} (${pane.agent}). Send a message to start.`);
  });

  // Cleanup duplicates (list unbound topics so user can delete manually)
  tg.bot.command("cleanup", async (ctx) => {
    if (!isPaired(state) || !state.authorized_chat_id) {
      await ctx.reply("Not paired.");
      return;
    }
    const chatId = state.authorized_chat_id;
    let topics: { message_thread_id: number; name: string }[] = [];
    try {
      topics = await tg.getForumTopics(chatId);
    } catch (e: any) {
      await ctx.reply(`Cannot list topics (${e.message}). Delete duplicates manually in Telegram UI.`);
      return;
    }
    const boundIds = new Set(deps.map.keys());
    const bound: string[] = [];
    const unbound: string[] = [];
    for (const t of topics) {
      const line = `#${t.message_thread_id} "${t.name}"`;
      if (boundIds.has(t.message_thread_id)) bound.push(line);
      else unbound.push(line);
    }
    const lines = [
      `Bound: ${bound.length}`,
      ...bound,
      "",
      `Unbound (delete these manually): ${unbound.length}`,
      ...unbound,
    ];
    await ctx.reply(lines.join("\n"));
  });

  // Unpair (reset state)
  tg.bot.command("unpair", async (ctx) => {
    if (!isPaired(state)) {
      await ctx.reply("Not paired.");
      return;
    }
    saveState(statePath, { authorized_chat_id: null, paired_at: null, thread_mappings: {} });
    state = loadState(statePath);
    deps.map.clear();
    deps.chatId = 0;
    await ctx.reply("Unpaired. Send /pair to re-authorize this chat.");
  });

  // Re-reconcile (re-create topics for any unmapped panes)
  tg.bot.command("reconcile", async (ctx) => {
    if (!isPaired(state) || !state.authorized_chat_id) {
      await ctx.reply("Not paired.");
      return;
    }
    const chatId = state.authorized_chat_id;
    await ctx.reply("Reconciling...");
    const newMap = await reconcile(chatId, tg);
    for (const [tid, m] of newMap.entries()) deps.map.set(tid, m);
    const rawMappings: DaemonState["thread_mappings"] = {};
    for (const [tid, m] of newMap.entries()) rawMappings[tid] = m;
    saveState(statePath, { ...state, thread_mappings: rawMappings });
    const result = (reconcile as any).lastResult as { created: string[]; failed: string[]; total: number } | undefined;
    if (result && result.failed.length > 0) {
      await ctx.reply(
        `Reconciled: ${newMap.size} panes mapped.\n` +
        `Auto-created ${result.created.length} topics.\n` +
        `Could not auto-create: ${result.failed.join(", ")}\n` +
        `For those, create a thread via Telegram UI and use /bind <pane-label>.`
      );
    } else {
      await ctx.reply(`Reconciled: ${newMap.size} topics mapped.`);
    }
  });

  tg.start();
  log.info("Daemon started", { paired: isPaired(state), panes: map.size });

  return {
    stop: () => tg.bot.stop(),
  };
}
