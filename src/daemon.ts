import { TelegramClient } from "./telegram-client.js";
import { registerCommands, type CommandDeps } from "./commands.js";
import { isPaired, updatePairing } from "./pairing.js";
import { reconcile, findMapping, seedKnownTabs, restoreKnownTabMappings } from "./mapping.js";
import { runAgentTurn, runAgentFollowLoop } from "./wait-loop.js";
import { getAgents, readPane, sendText, getAgentInfo, sendEscape } from "./herdr-client.js";
import { createAgentCommunicator } from "./agent-sessions.js";
import { cleanPaneOutput, stripStatusBar } from "./output-format.js";
import { loadConfig } from "./config.js";
import { loadState, saveState, rememberUpdateId } from "./state.js";
import { createLogger, type Logger } from "./logger.js";
import { startWatcher } from "./watcher.js";
import { FollowManager } from "./follow-manager.js";
import { TurnDispatcher } from "./turn-dispatcher.js";
import { parseActionCallback } from "./keyboards.js";
import { getLastReadback, formatStatus } from "./commands.js";
import type { DaemonState } from "./types.js";
import * as path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export interface StartDaemonOptions {
  /** Directory holding config.toml. Defaults to env HERDR_TG_CONFIG_DIR. */
  configDir?: string;
  /** Directory holding state.json + pid. Defaults to XDG_STATE_HOME/herdr-telegram. */
  stateDir?: string;
  /**
   * When true, skip the Telegram polling loop. Tests inject a mocked bot
   * and dispatch updates via bot.handleUpdate instead, so they don't need
   * network access or a real bot token. Defaults to false (real start).
   */
  skipTelegramStart?: boolean;
  /**
   * Custom fetch implementation passed to grammy. Tests use this to keep
   * grammy from hitting api.telegram.org. Production leaves this unset.
   */
  customFetch?: typeof fetch;
}

export async function startDaemon(
  configDirOrOpts?: string | StartDaemonOptions,
  stateDir?: string,
): Promise<{ stop: () => Promise<void> }> {
  const opts: StartDaemonOptions = typeof configDirOrOpts === "string"
    ? { configDir: configDirOrOpts, stateDir }
    : (configDirOrOpts ?? {});
  const log = createLogger("daemon");
  const cfg = loadConfig(opts.configDir);
  const statePath = opts.stateDir ?? path.join(
    process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".local", "state"),
    "herdr-telegram"
  );

  let state = loadState(statePath);
  // Ensure known_topics is always initialized so in-place mutations persist
  state.known_topics = state.known_topics ?? {};

  const pollingStatusPath = path.join(statePath, "polling-status.json");
  const tg = new TelegramClient(
    cfg.botToken,
    (polling) => {
      mkdirSync(statePath, { recursive: true });
      writeFileSync(pollingStatusPath, JSON.stringify({ ...polling, updatedAt: new Date().toISOString() }) + "\n");
      const data = { state: polling.state, attempt: polling.attempt, error: polling.error };
      if (polling.state === "retrying" || polling.state === "failed") log.warn("Telegram polling state", data);
      else log.info("Telegram polling state", data);
    },
    undefined,
    opts.customFetch,
  );

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

  const turns = new TurnDispatcher();
  const follows = new FollowManager();
  /** Active background follow loops, keyed by threadId. Cancel the runner to stop. */
  const followLoops = new Map<number, { cancel: () => void }>();

  const deps: CommandDeps = {
    map,
    stateDir: statePath,
    chatId: state.authorized_chat_id ?? 0,
    startTime: Date.now(),
    knownTopics: state.known_topics,
    turns,
    follows,
    follows_default_minutes: cfg.followTimeoutMinutes,
    agentPaths: cfg.agentPaths,
    opencodeReadOptions: {
      includeTools: cfg.opencodeIncludeTools,
      includeThoughts: cfg.opencodeIncludeThoughts,
    },
    onFollowStart: (threadId: number) => {
      // Idempotent: stop any existing loop first.
      followLoops.get(threadId)?.cancel();
      const sub = follows.get(threadId);
      if (!sub) return;
      const mapping = sub.mapping;
      const controller = new AbortController();
      followLoops.set(threadId, { cancel: () => controller.abort() });
      // Fire and forget — the loop runs in background.
      void (async () => {
        try {
          await runAgentFollowLoop({
            paneId: mapping.pane_id,
            threadId,
            cfg,
            tg,
            chatId: state.authorized_chat_id!,
            signal: controller.signal,
            // The closure re-reads the subscription each tick so user
            // messages (which call follows.touch) push the deadline out.
            expiresAt: () => {
              const current = follows.get(threadId);
              return current ? current.expiresAt : null;
            },
            onExpired: () => { follows.remove(threadId); },
          });
        } catch (err) {
          log.error("Follow loop crashed", {
            paneId: mapping.pane_id,
            threadId,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          followLoops.delete(threadId);
        }
      })();
    },
    onFollowStop: (threadId: number) => {
      followLoops.get(threadId)?.cancel();
      followLoops.delete(threadId);
    },
    saveMappings: () => {
      const raw: DaemonState["thread_mappings"] = {};
      for (const [tid, m] of deps.map.entries()) raw[tid] = m;
      saveState(statePath, { ...state, thread_mappings: raw });
    },
  };

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

  /*   * Send the last few lines of each pane's output as the first message in its topic. */
  async function seedTopics(
    newMap: Map<number, typeof state.thread_mappings[keyof typeof state.thread_mappings]>,
    chatId: number
  ): Promise<void> {
    for (const [threadId, mapping] of newMap.entries()) {
      try {
        const comm = createAgentCommunicator({
          paneId: mapping.pane_id,
          getAgentInfo,
          readPane,
          agentPaths: cfg.agentPaths,
          opencodeReadOptions: {
            includeTools: cfg.opencodeIncludeTools,
            includeThoughts: cfg.opencodeIncludeThoughts,
          },
          logger: log,
        });
        const output = comm.getAgentOutput(5);
        // Apply same cleaning as /last — strip status bars and filter out
        // terminal chrome that the OpenCode TUI captures into its SQLite log.
        const cleaned = cleanPaneOutput(stripStatusBar(output));
        if (cleaned.trim()) {
          const truncated = cleaned.length > 2000 ? cleaned.slice(-2000) : cleaned;
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
      {
        ...deps,
        agentPaths: cfg.agentPaths,
        opencodeReadOptions: {
          includeTools: cfg.opencodeIncludeTools,
          includeThoughts: cfg.opencodeIncludeThoughts,
        },
      }
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
    void turns.start(mapping.pane_id, async (signal) => {
      try {
        await runAgentTurn(
          mapping.pane_id, threadId,
          "Keep it under 4000 characters. Summarize what we've been working on: original goal, progress, blockers, next steps.",
          cfg, tg, state.authorized_chat_id!,
          { signal }
        );
      } catch (err) {
        log.error("Digest turn failed", {
          paneId: mapping.pane_id,
          threadId,
          message: err instanceof Error ? err.message : String(err),
        });
        if (!signal.aborted) {
          await tg.sendMessage(state.authorized_chat_id!, threadId, "⚠️ The bridge could not complete this digest. Please try again.");
        }
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

    // Give the user a visible "seen, queued" hint when their pane already
    // has a turn in progress. Without this, messages arriving during a long
    // turn look silently swallowed — the queue serialises per pane but
    // gives no feedback until the current turn finalises. /stop aborts
    // the in-progress turn and releases the queue immediately.
    if (turns.isBusy(mapping.pane_id)) {
      try {
        await ctx.api.setMessageReaction(ctx.chat!.id, ctx.message!.message_id, [{ type: "emoji", emoji: "👀" }]);
      } catch {
        // reactions may be unavailable in some chats; ignore.
      }
    }

    // Do not await an agent turn in Grammy's update handler: a slow Codex
    // turn must not stop Telegram from routing a new message to OpenCode.
    // PR #10: if a turn is already running for this pane, pass the message
    // straight to the pane instead of enqueueing another turn. The
    // already-running turn continues and observes the new lines; the
    // follow timer is reset either way. 👀 confirms to the user that we
    // saw the message and the agent will pick it up.
    if (deps.follows) deps.follows.touch(threadId);
    if (turns.isBusy(mapping.pane_id)) {
      try {
        sendText(mapping.pane_id, text);
        await ctx.api.setMessageReaction(ctx.chat!.id, ctx.message!.message_id, [{ type: "emoji", emoji: "👀" }]);
      } catch {
        // reactions may be unavailable; ignore.
      }
      return;
    }
    void turns.start(mapping.pane_id, async (signal) => {
      try {
        await runAgentTurn(mapping.pane_id, threadId, text, cfg, tg, chatId, { signal });
      } catch (err) {
        log.error("Agent turn failed", {
          paneId: mapping.pane_id,
          threadId,
          message: err instanceof Error ? err.message : String(err),
        });
        if (!signal.aborted) {
          await tg.sendMessage(chatId, threadId, "⚠️ The bridge could not complete this agent turn. Please try again.");
        }
      }
    });
  });

  // Handle inline keyboard taps for thread binding
  tg.bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    // Inline-keyboard action buttons (Stop / Unfollow / Last / Status /
    // Follow Nm). They do not need a pane selection — the threadId in the
    // callback carries the binding context.
    if (data.startsWith("act:")) {
      const parsed = parseActionCallback(data);
      if (!parsed) {
        await ctx.answerCallbackQuery({ text: "Unknown action." });
        return;
      }
      const { command, args, threadId } = parsed;
      log.info("Inline action callback", { command, args, threadId });
      const mapping = findMapping(threadId, deps.map);
      if (!mapping) {
        await ctx.answerCallbackQuery({ text: "Thread not bound." });
        return;
      }
      try {
        switch (command) {
          case "stop":
            sendEscape(mapping.pane_id);
            const wasBusy = turns.abort(mapping.pane_id);
            await ctx.answerCallbackQuery({ text: wasBusy ? "Stopped." : "Nothing in flight." });
            return;
          case "unfollow":
            if (deps.follows?.remove(threadId)) {
              deps.onFollowStop?.(threadId);
            }
            await ctx.answerCallbackQuery({ text: "Unfollowed." });
            return;
          case "follow":
            if (!deps.follows) {
              await ctx.answerCallbackQuery({ text: "Subscriptions not available." });
              return;
            }
            const minutes = parseInt(args, 10);
            if (!Number.isFinite(minutes) || minutes < 0) {
              await ctx.answerCallbackQuery({ text: "Invalid minutes." });
              return;
            }
            // If a subscription is already active for this thread, just
            // reset the timer instead of restarting the loop. Restarting
            // would emit a confusing 'Follow cancelled.' immediately after
            // the user clicked to extend the subscription.
            if (deps.follows.get(threadId)) {
              deps.follows.touch(threadId);
              await ctx.answerCallbackQuery({ text: `Timer reset to ${minutes}m.` });
              return;
            }
            deps.follows.subscribe(threadId, mapping, minutes);
            deps.onFollowStart?.(threadId);
            await ctx.answerCallbackQuery({ text: `Following ${minutes}m.` });
            return;
          case "last":
            await ctx.answerCallbackQuery({ text: "Reading last snapshot…" });
            try {
              await ctx.api.sendMessage(ctx.chat!.id, "Reading last snapshot…\u200B", { message_thread_id: threadId });
              const comm = createAgentCommunicator({
                paneId: mapping.pane_id,
                getAgentInfo,
                readPane,
                agentPaths: cfg.agentPaths,
                opencodeReadOptions: {
                  includeTools: cfg.opencodeIncludeTools,
                  includeThoughts: cfg.opencodeIncludeThoughts,
                },
                logger: log,
              });
              const body = getLastReadback({
                mapping,
                communicator: comm,
                busy: turns.isBusy(mapping.pane_id),
                now: () => new Date().toISOString(),
                truncateAt: 3000,
              });
              await ctx.api.sendMessage(ctx.chat!.id, body, { message_thread_id: threadId });
            } catch (e) {
              log.error("Last readback failed", { threadId, message: e instanceof Error ? e.message : String(e) });
            }
            return;
          case "status":
            await ctx.answerCallbackQuery({ text: "Status requested." });
            try {
              await ctx.api.sendMessage(ctx.chat!.id, formatStatus({ uptime: "", paired: true, panesCount: 0 }) + "\nthreadId: " + threadId, { message_thread_id: threadId });
            } catch (e) {
              log.error("Status callback failed", { threadId, message: e instanceof Error ? e.message : String(e) });
            }
            return;
          default:
            await ctx.answerCallbackQuery({ text: "Unknown action." });
            return;
        }
      } catch (err) {
        log.error("Action callback failed", { command, args, threadId, message: err instanceof Error ? err.message : String(err) });
        await ctx.answerCallbackQuery({ text: "Failed." });
      }
      return;
    }
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

  if (!opts.skipTelegramStart) {
    await tg.start();
  }
  log.info("Daemon started", { paired: isPaired(state), panes: map.size });

  maybeStartWatcher();
  deps.stopWatcher = () => watcherController.abort();

  const result: { stop: () => Promise<void> } & Record<string, unknown> = {
    stop: () => tg.stop(),
  };
  // Tests using skipTelegramStart: true need to dispatch updates to the
  // daemon's bot instance. Expose it under a non-standard key so the
  // production return type stays { stop }.
  if (opts.skipTelegramStart) {
    result.tg = tg;
    result.follows = follows;
  }
  return result;
}
