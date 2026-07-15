import { TelegramClient } from "./telegram-client.js";
import { registerCommands, type CommandDeps } from "./commands.js";
import { isPaired, updatePairing } from "./pairing.js";
import { reconcile, findMapping, seedKnownTabs, restoreKnownTabMappings } from "./mapping.js";
import { runAgentTurn } from "./wait-loop.js";
import { getAgents, readPane } from "./herdr-client.js";
import { loadConfig } from "./config.js";
import { loadState, saveState, rememberUpdateId } from "./state.js";
import { createLogger, type Logger } from "./logger.js";
import { startWatcher } from "./watcher.js";
import { TurnDispatcher } from "./turn-dispatcher.js";
import type { DaemonState } from "./types.js";
import * as path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export async function startDaemon(configDir?: string, stateDir?: string): Promise<{ stop: () => Promise<void> }> {
  const log = createLogger("daemon");
  const cfg = loadConfig(configDir);
  const statePath = stateDir ?? path.join(
    process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".local", "state"),
    "herdr-telegram"
  );

  let state = loadState(statePath);
  // Ensure known_topics is always initialized so in-place mutations persist
  state.known_topics = state.known_topics ?? {};

  const pollingStatusPath = path.join(statePath, "polling-status.json");
  const tg = new TelegramClient(cfg.botToken, (polling) => {
    mkdirSync(statePath, { recursive: true });
    writeFileSync(pollingStatusPath, JSON.stringify({ ...polling, updatedAt: new Date().toISOString() }) + "\n");
    const data = { state: polling.state, attempt: polling.attempt, error: polling.error };
    if (polling.state === "retrying" || polling.state === "failed") log.warn("Telegram polling state", data);
    else log.info("Telegram polling state", data);
  });

  // Re-validate existing pairing
  if (isPaired(state) && state.authorized_chat_id) {
    const errors = await tg.validatePermissions(state.authorized_chat_id);
    if (errors.length > 0) {
      log.warn("Permission validation failed on startup", { errors });
      // A transient Telegram outage must not make a healthy daemon impossible
      // to start. Polling has its own retry loop; this notification is best effort.
      try {
        await tg.sendMessage(
          state.authorized_chat_id, 1, // send to General topic (thread 1)
          "⚠️ Permission check failed:\n" + errors.map(e => "- " + e).join("\n") +
          "\n\nBridge in read-only mode. Fix permissions and restart."
        );
      } catch (err) {
        log.warn("Could not send permission warning", { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const startupPanes = isPaired(state) ? getAgents() : [];
  const previousMappings = new Map<number, DaemonState["thread_mappings"][keyof DaemonState["thread_mappings"]]>(
    Object.entries(state.thread_mappings).map(([threadId, mapping]) => [Number(threadId), mapping])
  );
  const startupMappings = restoreKnownTabMappings(startupPanes, state.known_tabs, previousMappings);
  const map = isPaired(state) && state.authorized_chat_id
    ? await reconcile(
        state.authorized_chat_id!,
        tg,
        startupMappings,
        state.known_topics!
      )
    : new Map<number, typeof state.thread_mappings[keyof typeof state.thread_mappings]>();

  // Persist initial mapping (reconcile mutated state.known_topics in-place)
  const rawMappings: DaemonState["thread_mappings"] = {};
  for (const [tid, m] of map.entries()) rawMappings[tid] = m;
  // Seed known_tabs from initial reconcile so the watcher has a baseline
  state.known_tabs = seedKnownTabs(map, startupPanes, state.known_tabs ?? {});
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
  const turns = new TurnDispatcher();

  // Telegram can replay an update when long polling is interrupted around a
  // restart. Persist a small update-id window so a replay never re-prompts an
  // agent (and never creates a duplicate Telegram reply).
  tg.bot.use(async (ctx, next) => {
    const latest = loadState(statePath);
    if (rememberUpdateId(latest, ctx.update.update_id)) {
      log.warn("Ignoring replayed Telegram update", { updateId: ctx.update.update_id });
      return;
    }
    log.info("Telegram update accepted", {
      updateId: ctx.update.update_id,
      messageId: ctx.message?.message_id,
      threadId: ctx.message?.message_thread_id,
      text: ctx.message?.text?.slice(0, 80),
    });
    state.processed_update_ids = latest.processed_update_ids;
    saveState(statePath, latest);
    await next();
  });

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

  // Lazy-start the watcher: handlers like /pair may need to start it
  // after the daemon initially launched unpaired.
  let watcherStarted = false;
  let watcherController = new AbortController();
  const saveStateCallback = () => {
    const raw: DaemonState["thread_mappings"] = {};
    for (const [tid, m] of deps.map.entries()) raw[tid] = m;
    saveState(statePath, { ...state, thread_mappings: raw });
  };
  function maybeStartWatcher() {
    if (watcherStarted) return;
    if (!isPaired(state) || !state.authorized_chat_id) return;
    watcherStarted = true;
    startWatcher(
      state.authorized_chat_id,
      tg,
      state,
      saveStateCallback,
      15_000,
      watcherController.signal,
      deps
    );
    log.info("watcher: lazily started after pair/reconcile");
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
        // Reply before deleting topics (deleting the current topic would break ctx.reply)
        await ctx.reply(`Unpairing...`);
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
        saveState(statePath, { authorized_chat_id: null, paired_at: null, thread_mappings: {}, known_topics: {}, known_tabs: {} });
        state = loadState(statePath);
        state.known_topics = {};
        state.known_tabs = {};
        deps.map.clear();
        deps.chatId = 0;
        deps.knownTopics = state.known_topics;
        deps.stopWatcher?.();
        watcherStarted = false;
        watcherController = new AbortController();
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
      // Seed known_tabs so watcher doesn't re-create duplicate topics
      state.known_tabs = seedKnownTabs(newMap, getAgents(), state.known_tabs ?? {});
      saveState(statePath, { ...state, thread_mappings: rawMappings });
      // Seed topics with last output (fire-and-forget — don't block reply)
      seedTopics(newMap, chatId).catch(() => {});
      const result = (reconcile as any).lastResult as { created: string[]; deleted: string[]; failed: string[]; total: number } | undefined;
      const parts = [`Reconciled: ${newMap.size} panes mapped.`];
      if (result?.deleted.length) parts.push(`Deleted ${result.deleted.length} duplicate(s): ${result.deleted.join(", ")}`);
      if (result?.created.length) parts.push(`Auto-created: ${result.created.join(", ")}`);
      if (result?.failed.length) parts.push(`Could not create (bind manually with /bind): ${result.failed.join(", ")}`);
      await ctx.reply(parts.join("\n"));
      maybeStartWatcher();
      return;
    }
    if (text.startsWith("/reconcile")) {
      log.info("reconcile via message handler", { chatId: ctx.chat.id });
      if (!isPaired(state) || !state.authorized_chat_id) { await ctx.reply("Not paired."); return; }
      const chatId = state.authorized_chat_id;
      await ctx.reply("Reconciling...");
      state.known_topics = state.known_topics ?? {};
      const newMap = await reconcile(chatId, tg, deps.map, state.known_topics);
      for (const [tid, m] of newMap.entries()) deps.map.set(tid, m);
      const raw: DaemonState["thread_mappings"] = {};
      for (const [tid, m] of newMap.entries()) raw[tid] = m;
      // Seed known_tabs to prevent watcher from creating duplicates
      state.known_tabs = seedKnownTabs(newMap, getAgents(), state.known_tabs ?? {});
      saveState(statePath, { ...state, thread_mappings: raw });
      seedTopics(newMap, chatId).catch(() => {});
      const result = (reconcile as any).lastResult as { created: string[]; deleted: string[]; failed: string[]; total: number } | undefined;
      const parts = [`Reconciled: ${newMap.size} panes mapped.`];
      if (result?.deleted.length) parts.push(`Deleted ${result.deleted.length} dups: ${result.deleted.join(", ")}`);
      if (result?.created.length) parts.push(`Created: ${result.created.join(", ")}`);
      if (result?.failed.length) parts.push(`Failed: ${result.failed.join(", ")}`);
      await ctx.reply(parts.join("\n"));
      return;
    }
    // /cleanup — list all tracked topics
    if (text.startsWith("/cleanup")) {
      log.info("cleanup via message handler", { chatId: ctx.chat.id });
      if (!isPaired(state) || !state.authorized_chat_id) { await ctx.reply("Not paired."); return; }
      const boundIds = new Set(deps.map.keys());
      const lines: string[] = [];
      if (deps.map.size > 0) {
        lines.push("🔗 Bound topics:");
        for (const [tid, m] of deps.map.entries()) {
          lines.push(`  #${tid} → ${m.label} (${m.agent})`);
        }
      } else {
        lines.push("No topics tracked.");
      }
      lines.push("", "Use /delete <id> to remove a topic.");
      await ctx.reply(lines.join("\n"));
      return;
    }
    // Pass through to other handlers (command, message:text, etc.)
    await next();
  });

  // Digest: ask the current pane's agent for a summary
  tg.bot.command("digest", async (ctx) => {
    log.info("digest: command FIRED", {
      hasMessage: !!ctx.message,
      hasReply: typeof ctx.reply === "function",
    });
    log.info("digest: command received", {
      threadId: ctx.message?.message_thread_id,
      chatId: ctx.chat.id,
    });
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
    log.info("digest: mapping", {
      threadId,
      found: !!mapping,
      label: mapping?.label,
    });
    if (!mapping) return; // unbound thread — ignore
    await ctx.reply(`Asking *${mapping.label}* for a summary...`, { parse_mode: "Markdown" });
    turns.enqueue(mapping.pane_id, async () => {
      try {
        await runAgentTurn(
          mapping.pane_id, threadId,
          "Keep it under 4000 characters. Summarize what we've been working on: original goal, progress, blockers, next steps.",
          cfg, tg, state.authorized_chat_id!
        );
      } catch (err) {
        log.error("Digest turn failed", {
          paneId: mapping.pane_id,
          threadId,
          message: err instanceof Error ? err.message : String(err),
        });
        await tg.sendMessage(state.authorized_chat_id!, threadId, "⚠️ The bridge could not complete this digest. Please try again.");
      }
    });
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
    log.info("message:text received", {
      threadId: ctx.message?.message_thread_id,
      chatId: ctx.chat.id,
      text: ctx.message.text?.slice(0, 50),
    });
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
      log.info("message:text: thread not bound", {
        threadId,
        chatId,
        knownMappings: Array.from(deps.map.keys()),
      });
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

    // Do not await an agent turn in Grammy's update handler: a slow Codex
    // turn must not stop Telegram from routing a new message to OpenCode.
    turns.enqueue(mapping.pane_id, async () => {
      try {
        await runAgentTurn(mapping.pane_id, threadId, text, cfg, tg, chatId);
      } catch (err) {
        log.error("Agent turn failed", {
          paneId: mapping.pane_id,
          threadId,
          message: err instanceof Error ? err.message : String(err),
        });
        await tg.sendMessage(chatId, threadId, "⚠️ The bridge could not complete this agent turn. Please try again.");
      }
    });
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

  await tg.start();
  log.info("Daemon started", { paired: isPaired(state), panes: map.size });

  maybeStartWatcher();
  deps.stopWatcher = () => watcherController.abort();

  return {
    stop: () => tg.stop(),
  };
}
