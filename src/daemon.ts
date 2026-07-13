import { TelegramClient } from "./telegram-client.js";
import { registerCommands, type CommandDeps } from "./commands.js";
import { isPaired, updatePairing } from "./pairing.js";
import { reconcile, findMapping } from "./mapping.js";
import { runAgentTurn } from "./wait-loop.js";
import { getAgents, readPane } from "./herdr-client.js";
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
  // Ensure known_topics is always initialized so in-place mutations persist
  state.known_topics = state.known_topics ?? {};

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
    ? await reconcile(
        state.authorized_chat_id!,
        tg,
        new Map(), // no existing mappings on cold start
        state.known_topics!
      )
    : new Map<number, typeof state.thread_mappings[keyof typeof state.thread_mappings]>();

  // Persist initial mapping (reconcile mutated state.known_topics in-place)
  const rawMappings: DaemonState["thread_mappings"] = {};
  for (const [tid, m] of map.entries()) rawMappings[tid] = m;
  saveState(statePath, {
    ...state,
    thread_mappings: rawMappings,
  });

  const deps: CommandDeps = {
    map,
    stateDir: statePath,
    chatId: state.authorized_chat_id ?? 0,
    startTime: Date.now(),
    knownTopics: state.known_topics,
    saveMappings: () => {
      const raw: DaemonState["thread_mappings"] = {};
      for (const [tid, m] of deps.map.entries()) raw[tid] = m;
      saveState(statePath, { ...state, thread_mappings: raw });
    },
  };

  registerCommands(tg.bot, deps);

  // Don't crash on errors — log and continue
  tg.bot.catch((err) => {
    log.error("Unhandled bot error", { message: err.message, name: err.name });
  });

  /** Send the last few lines of each pane's output as the first message in its topic. */
  async function seedTopics(
    newMap: Map<number, typeof state.thread_mappings[keyof typeof state.thread_mappings]>,
    chatId: number
  ): Promise<void> {
    for (const [threadId, mapping] of newMap.entries()) {
      try {
        const output = readPane(mapping.pane_id, 5);
        if (output.trim()) {
          const truncated = output.length > 2000 ? output.slice(-2000) : output;
          await tg.sendMessage(chatId, threadId, `📋 *${mapping.label}*\n\n\`\`\`\n${truncated}\n\`\`\``);
        }
      } catch {
        // Pane may be busy or unreadable — skip
      }
    }
  }

  // Catch-all message handler (highest priority) for commands that must always work
  tg.bot.on("message", async (ctx, next) => {
    const text = ctx.message?.text ?? "";
    // /unpair — must work even if grammy command matching is flaky
    if (text.startsWith("/unpair")) {
      log.info("unpair caught via message handler", { chatId: ctx.chat.id });
      try {
        if (!isPaired(state)) {
          await ctx.reply("Not paired.");
          return;
        }
        // Delete all bot-created topics before resetting state
        const kt = state.known_topics ?? {};
        const tids = Object.keys(kt).map(Number);
        let deleted = 0;
        for (const tid of tids) {
          try {
            await ctx.api.deleteForumTopic(ctx.chat.id, tid);
            deleted++;
          } catch {
            // skip — topic may already be gone
          }
        }
        saveState(statePath, { authorized_chat_id: null, paired_at: null, thread_mappings: {}, known_topics: {} });
        state = loadState(statePath);
        state.known_topics = {};
        deps.map.clear();
        deps.chatId = 0;
        deps.knownTopics = state.known_topics;
        await ctx.reply(`Unpaired. Deleted ${deleted} topic(s). Send /pair to re-authorize.`);
      } catch (err: any) {
        log.error("unpair failed", { error: err.message });
        await ctx.reply("Unpair failed: " + err.message);
      }
      return;
    }
    // /pair — handle here too for reliability
    if (text.startsWith("/pair")) {
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
      state.known_topics = state.known_topics ?? {};
      deps.chatId = chatId;
      deps.knownTopics = state.known_topics;
      await ctx.reply("✅ Chat authorized. Reconciling tabs...");
      const newMap = await reconcile(chatId, tg, deps.map, state.known_topics);
      for (const [tid, m] of newMap.entries()) deps.map.set(tid, m);
      const rawMappings: DaemonState["thread_mappings"] = {};
      for (const [tid, m] of newMap.entries()) rawMappings[tid] = m;
      saveState(statePath, { ...state, thread_mappings: rawMappings });
      // Seed topics with last output (fire-and-forget — don't block reply)
      seedTopics(newMap, chatId).catch(() => {});
      const result = (reconcile as any).lastResult as { created: string[]; deleted: string[]; failed: string[]; total: number } | undefined;
      const parts = [`Reconciled: ${newMap.size} panes mapped.`];
      if (result?.deleted.length) parts.push(`Deleted ${result.deleted.length} duplicate(s): ${result.deleted.join(", ")}`);
      if (result?.created.length) parts.push(`Auto-created: ${result.created.join(", ")}`);
      if (result?.failed.length) parts.push(`Could not create (bind manually with /bind): ${result.failed.join(", ")}`);
      await ctx.reply(parts.join("\n"));
      return;
    }
    // Pass through to other handlers (command, message:text, etc.)
    await next();
  });

  // Digest: ask the current pane's agent for a summary
  tg.bot.command("digest", async (ctx) => {
    if (!isPaired(state) || !state.authorized_chat_id) {
      await ctx.reply("Not paired.");
      return;
    }
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Use /digest inside a thread to ask that pane's agent for a summary.");
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) return; // unbound thread — ignore
    await ctx.reply(`Asking *${mapping.label}* for a summary...`, { parse_mode: "Markdown" });
    await runAgentTurn(
      mapping.pane_id, threadId,
      "Give me a concise summary of what we've been working on in this session. Keep it under 200 words. Include: original goal, progress made, blockers, and next steps.",
      cfg, tg, state.authorized_chat_id!
    );
  });

  // Pairing flow (grammy command handler — kept for when grammy works)
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
    state.known_topics = state.known_topics ?? {};
    deps.chatId = chatId;
    await ctx.reply("✅ Chat authorized. Reconciling tabs...");
    const newMap = await reconcile(chatId, tg, deps.map, state.known_topics);
    for (const [tid, m] of newMap.entries()) deps.map.set(tid, m);
    const rawMappings: DaemonState["thread_mappings"] = {};
    for (const [tid, m] of newMap.entries()) rawMappings[tid] = m;
    saveState(statePath, { ...state, thread_mappings: rawMappings });
    const result = (reconcile as any).lastResult as { created: string[]; deleted: string[]; failed: string[]; total: number } | undefined;
    const parts = [`Reconciled: ${newMap.size} panes mapped.`];
    if (result?.deleted.length) parts.push(`Deleted ${result.deleted.length} duplicate(s): ${result.deleted.join(", ")}`);
    if (result?.created.length) parts.push(`Auto-created: ${result.created.join(", ")}`);
    if (result?.failed.length) parts.push(`Could not create (bind manually with /bind): ${result.failed.join(", ")}`);
    await ctx.reply(parts.join("\n"));
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

  // Cleanup: show all known topics (bot-created + bound) so user can delete manually
  tg.bot.command("cleanup", async (ctx) => {
    if (!isPaired(state) || !state.authorized_chat_id) {
      await ctx.reply("Not paired.");
      return;
    }
    const boundIds = new Set(deps.map.keys());
    const kt = state.known_topics ?? {};
    const lines: string[] = [];
    // Show known (bot-created) topics
    if (Object.keys(kt).length > 0) {
      lines.push("📋 Bot-created topics (from known_topics):");
      for (const [tid, info] of Object.entries(kt)) {
        const bid = Number(tid);
        const marker = boundIds.has(bid) ? "🔗" : "  ";
        lines.push(`  ${marker} #${tid} "${info.name}"`);
      }
    }
    // Show bound topics (in case some were bound via /bind, not bot-created)
    if (deps.map.size > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("🔗 Bound mappings:");
      for (const [tid, m] of deps.map.entries()) {
        lines.push(`  #${tid} → ${m.label} (${m.agent})`);
      }
    }
    if (lines.length === 0) {
      lines.push("No topics tracked.");
    }
    lines.push("", "Use /delete <id> to remove a topic.");
    await ctx.reply(lines.join("\n"));
  });

  // Re-reconcile (re-create topics for any unmapped panes)
  tg.bot.command("reconcile", async (ctx) => {
    if (!isPaired(state) || !state.authorized_chat_id) {
      await ctx.reply("Not paired.");
      return;
    }
    const chatId = state.authorized_chat_id;
    await ctx.reply("Reconciling...");
    state.known_topics = state.known_topics ?? {};
    const newMap = await reconcile(chatId, tg, deps.map, state.known_topics);
    for (const [tid, m] of newMap.entries()) deps.map.set(tid, m);
    const rawMappings: DaemonState["thread_mappings"] = {};
    for (const [tid, m] of newMap.entries()) rawMappings[tid] = m;
    saveState(statePath, { ...state, thread_mappings: rawMappings });
    seedTopics(newMap, chatId).catch(() => {});
    const result = (reconcile as any).lastResult as { created: string[]; deleted: string[]; failed: string[]; total: number } | undefined;
    const parts = [`Reconciled: ${newMap.size} panes mapped.`];
    if (result?.deleted.length) parts.push(`Deleted ${result.deleted.length} duplicate(s): ${result.deleted.join(", ")}`);
    if (result?.created.length) parts.push(`Auto-created: ${result.created.join(", ")}`);
    if (result?.failed.length) parts.push(`Could not create (bind manually with /bind): ${result.failed.join(", ")}`);
    await ctx.reply(parts.join("\n"));
  });

  tg.start();
  log.info("Daemon started", { paired: isPaired(state), panes: map.size });

  return {
    stop: () => tg.bot.stop(),
  };
}
