import { Bot, type Context, InlineKeyboard } from "grammy";
import type { PaneInfo, ThreadMapping } from "./types.js";
import { getAgents, readPane, sendText } from "./herdr-client.js";
import { findMapping } from "./mapping.js";
import { isPaired } from "./pairing.js";
import type { DaemonState } from "./types.js";
import { loadState, saveState } from "./state.js";
import { cleanPaneOutput, stripStatusBar } from "./wait-loop.js";
import type { FollowManager } from "./follow-manager.js";

export function formatAgentList(panes: PaneInfo[], map: Map<number, ThreadMapping>): string {
  if (panes.length === 0) return "No agents active.";
  const lines = ["Agents:"];
  for (const p of panes) {
    let threadId = "?";
    for (const [tid, m] of map.entries()) {
      if (m.pane_id === p.pane_id) { threadId = String(tid); break; }
    }
    lines.push(`  ${p.label} (${p.agent}, ${p.status}) — topic ${threadId}`);
  }
  return lines.join("\n");
}

export function formatStatus(opts: {
  uptime: string;
  paired: boolean;
  panesCount: number;
  follows?: Array<{
    threadId: number;
    mapping: ThreadMapping;
    expiresAt: number;
    timeoutMs: number;
    now: number;
  }>;
}): string {
  const lines = [
    `Bridge uptime: ${opts.uptime}`,
    `Paired: ${opts.paired ? "yes" : "no"}`,
    `Active panes: ${opts.panesCount}`,
  ];
  if (opts.follows && opts.follows.length > 0) {
    lines.push("");
    lines.push("Active follows:");
    for (const f of opts.follows) {
      const label =
        f.timeoutMs === 0
          ? "manual (no timeout)"
          : `${Math.max(0, Math.ceil((f.expiresAt - f.now) / 60_000))} min left`;
      lines.push(`  thread ${f.threadId} (${f.mapping.label}) — ${label}`);
    }
  }
  return lines.join("\n");
}

export interface CommandDeps {
  map: Map<number, ThreadMapping>;
  stateDir: string;
  chatId: number;
  startTime: number;
  saveMappings: () => void;
  /** Bot-created topic registry (for dedup). Mutated in-place by reconcile. */
  knownTopics?: Record<number, { name: string; created_at: string }>;
  /** Stops the tab watcher (called on /unpair). */
  stopWatcher?: () => void;
  /** Optional dispatcher, used to hint when a pane is mid-turn. */
  turns?: { isBusy(paneId: string): boolean };
  /** Optional subscription registry. /follow registers, /unfollow removes. */
  follows?: FollowManager;
  /** Default minutes when /follow is invoked without an explicit argument. */
  follows_default_minutes?: number;
  /** Optional hook called by /follow after registering a subscription, so
   *  the daemon can spawn the background poll loop. */
  onFollowStart?: (threadId: number) => void;
  /** Optional hook called by /unfollow after dropping a subscription, so
   *  the daemon can stop the background poll loop. */
  onFollowStop?: (threadId: number) => void;
}

/** Format the body of a /last readback. Pure function: easy to unit-test. */
export function formatLastReadback(opts: {
  mapping: ThreadMapping;
  rawPane: string;
  busy: boolean;
  now: () => string;
  truncateAt: number;
}): string {
  const cleaned = cleanPaneOutput(stripStatusBar(opts.rawPane));
  const truncated =
    cleaned.length > opts.truncateAt
      ? `(... ${cleaned.length - opts.truncateAt} chars omitted)\n${cleaned.slice(-opts.truncateAt)}`
      : cleaned;
  const ts = opts.now();
  const busyHint = opts.busy
    ? "\n\n_(painel imprimindo — pode estar parcial)_"
    : "";
  return `[${ts}] ${opts.mapping.label}\n\n${truncated}${busyHint}`;
}

export function registerCommands(bot: Bot<Context>, deps: CommandDeps): void {
  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "/help — this message",
        "/agents — list agents with status and bound threads",
        "/bind <pane-label> — bind this thread to a pane (use in a new thread)",
        "/unbind — unbind this thread",
        "/topics — list bound topic ids (use /delete <id> to remove)",
        "/delete <id> — delete a forum topic by its thread id",
        "/unpair — reset pairing (re-authorize with /pair)",
        "/status — bridge uptime and connection info (incl. active follows)",
        "/interrupt — send Ctrl+C to this thread's agent",
        "/trust — send 'trust, always allow' to this thread's agent",
        "/digest — today's activity (coming soon)",
        "/last — show current pane output (read-only, no turn)",
        "/follow [minutes] — keep listening after the agent responds; expires N min after your last message (default 30, 0 = manual)",
        "/unfollow — stop listening on this thread",
        "",
        "Plain text in any thread is sent to that thread's pane.",
      ].join("\n")
    );
  });

  bot.command("agents", async (ctx) => {
    const panes = getAgents();
    await ctx.reply(formatAgentList(panes, deps.map));
  });

  bot.command("status", async (ctx) => {
    const state = loadState(deps.stateDir);
    const uptime = Math.floor((Date.now() - deps.startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    const now = Date.now();
    const followsSnapshot = deps.follows
      ? deps.follows.listAll().map((f) => ({
          threadId: f.threadId,
          mapping: f.mapping,
          expiresAt: f.expiresAt,
          timeoutMs: f.timeoutMs,
          now,
        }))
      : undefined;
    await ctx.reply(formatStatus({
      uptime: `${h}h ${m}m ${s}s`,
      paired: isPaired(state),
      panesCount: deps.map.size,
      follows: followsSnapshot,
    }));
  });

  bot.command("interrupt", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    sendText(mapping.pane_id, "\x03"); // Ctrl+C
    await ctx.reply(`Interrupted ${mapping.label}`);
  });

  bot.command("trust", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    sendText(mapping.pane_id, "trust, always allow");
    await ctx.reply(`Trusted ${mapping.label}`);
  });

  bot.command("last", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Send /last inside a thread.");
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("No pane for this topic.");
      return;
    }
    let raw: string;
    try {
      // Match wait-loop's max scan lines (ScreenScrapeWrapper expands up to 4000)
      // so /last can show recent output that scrolled off a 500-line buffer.
      raw = readPane(mapping.pane_id, 4_000);
    } catch (err: any) {
      await ctx.reply(`Failed to read pane: ${err.message}`);
      return;
    }
    const body = formatLastReadback({
      mapping,
      rawPane: raw,
      busy: deps.turns?.isBusy(mapping.pane_id) ?? false,
      now: () => new Date().toISOString(),
      truncateAt: 3000,
    });
    await ctx.reply(body);
  });

  bot.command("bind", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply(
        "Send /bind inside a thread (tap + or New Thread in the chat first)."
      );
      return;
    }
    const arg = (ctx.match ?? "").trim();
    const panes = getAgents();

    if (!arg) {
      const available = panes
        .map((p) => `- ${p.label} (${p.agent}, ${p.status})`)
        .join("\n");
      await ctx.reply(
        `Usage: /bind <pane-label>\n\nAvailable panes:\n${available}\n\nExample: /bind analisedefiis`
      );
      return;
    }

    const pane = panes.find(
      (p) =>
        p.label.toLowerCase() === arg.toLowerCase() ||
        p.pane_id.toLowerCase() === arg.toLowerCase()
    );
    if (!pane) {
      await ctx.reply(
        `Pane "${arg}" not found. Use /bind with no args to see available panes.`
      );
      return;
    }

    deps.map.set(threadId, {
      pane_id: pane.pane_id,
      label: pane.label,
      agent: pane.agent,
      created_at: new Date().toISOString(),
    });
    deps.saveMappings();
    await ctx.reply(
      `Bound this thread to ${pane.label} (${pane.agent}). Send a message to start.`
    );
  });

  bot.command("unbind", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Send /unbind inside a thread.");
      return;
    }
    const mapping = deps.map.get(threadId);
    if (!mapping) {
      await ctx.reply("This thread is not bound.");
      return;
    }
    deps.map.delete(threadId);
    deps.saveMappings();
    await ctx.reply(`Unbound thread from ${mapping.label}.`);
  });

  bot.command("topics", async (ctx) => {
    if (deps.map.size === 0) {
      await ctx.reply("No bound topics.");
      return;
    }
    const lines: string[] = ["Bound topics:"];
    for (const [tid, m] of deps.map.entries()) {
      lines.push(`  #${tid} → ${m.label} (${m.agent})`);
    }
    await ctx.reply(lines.join("\n") + "\n\nUse /delete <id> to remove a topic by id.");
  });

  bot.command("delete", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const threadId = parseInt(arg, 10);
    if (!threadId || isNaN(threadId)) {
      await ctx.reply("Usage: /delete <thread_id>\n\nGet thread ids from /topics or Telegram UI (long-press a topic to see its id).");
      return;
    }
    const wasBound = deps.map.has(threadId);
    try {
      await ctx.api.deleteForumTopic(ctx.chat.id, threadId);
      deps.map.delete(threadId);
      if (deps.knownTopics) delete deps.knownTopics[threadId];
      deps.saveMappings();
      await ctx.reply(`Deleted topic #${threadId}.${wasBound ? " (was bound)" : ""}`);
    } catch (err: any) {
      await ctx.reply(`Failed to delete #${threadId}: ${err.message}`);
    }
  });

  bot.command("follow", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Send /follow inside a thread.");
      return;
    }
    if (!deps.follows) {
      await ctx.reply("Subscriptions not available.");
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("No pane for this topic.");
      return;
    }
    const arg = (ctx.match ?? "").trim();
    let minutes: number;
    if (arg === "") {
      minutes = deps.follows_default_minutes ?? 30;
    } else {
      const parsed = parseInt(arg, 10);
      if (isNaN(parsed) || parsed < 0) {
        await ctx.reply("Usage: /follow [minutes] — minutes must be a non-negative integer (0 = no timeout).");
        return;
      }
      minutes = parsed;
    }
    const sub = deps.follows.subscribe(threadId, mapping, minutes);
    deps.onFollowStart?.(threadId);
    // React to the user's /follow message so they see confirmation inline.
    try {
      await ctx.api.setMessageReaction(ctx.chat!.id, ctx.message!.message_id, [{ type: "emoji", emoji: "👀" }]);
    } catch {
      // reactions may be unavailable in some chats; ignore.
    }
    const hint =
      minutes === 0
        ? "no timeout — /unfollow to stop"
        : `expires in ${minutes} min from your last message`;
    await ctx.reply(`Following ${mapping.label}. ${hint}.`);
  });

  bot.command("unfollow", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Send /unfollow inside a thread.");
      return;
    }
    if (!deps.follows) {
      await ctx.reply("Subscriptions not available.");
      return;
    }
    const had = deps.follows.remove(threadId);
    deps.onFollowStop?.(threadId);
    // Clear the 👀 reaction if we had set one.
    if (had) {
      try {
        await ctx.api.setMessageReaction(ctx.chat!.id, ctx.message!.message_id, []);
      } catch {
        // ignore
      }
    }
    await ctx.reply(had ? "Unfollowed." : "Was not following this thread.");
  });
}
