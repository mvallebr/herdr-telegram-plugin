import { Bot, type Context } from "grammy";
import type { PaneInfo, ThreadMapping } from "./types.js";
import { getAgents, sendText, sendEscape } from "./herdr-client.js";
import { isPaired } from "./pairing.js";
import { loadState, saveState } from "./state.js";
import { stripStatusBar, cleanPaneOutput } from "./output-format.js";
import type { PaneAgent } from "./pane-agent.js";
import type { AgentCommunicator } from "./agent-sessions.js";

/** Look up the ThreadMapping for a Telegram thread id. Pure local read; the
 *  watcher/reconcile logic that used to live in `mapping.ts` is now owned
 *  by `PaneManager`. */
const findMapping = (threadId: number, map: Map<number, ThreadMapping>): ThreadMapping | undefined =>
  map.get(threadId);

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
}): string {
  const lines = [
    `Bridge uptime: ${opts.uptime}`,
    `Paired: ${opts.paired ? "yes" : "no"}`,
    `Active panes: ${opts.panesCount}`,
  ];
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
  /** Default minutes when /follow is invoked without an explicit argument. */
  follows_default_minutes?: number;
  /** Resolve the PaneAgent that owns a given pane. The daemon wires this. */
  getPaneAgent?: (paneId: string) => PaneAgent | undefined;
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

/**
 * Read the last snapshot for a bound thread, preferring the agent's
 * structured jsonl/SQLite session log when available. Returns whatever the
 * communicator produces — if no structured source is available, the
 * communicator itself falls back to screen scraping.
 *
 * Returns the formatted readback string ready to send to Telegram.
 */
export function getLastReadback(opts: {
  mapping: ThreadMapping;
  /** AgentCommunicator instance — owns the read strategy decision. */
  communicator: AgentCommunicator;
  busy: boolean;
  now: () => string;
  truncateAt: number;
  maxLines?: number;
}): string {
  const rawPane = opts.communicator.getAgentOutput(opts.maxLines ?? 4_000);

  return formatLastReadback({
    mapping: opts.mapping,
    rawPane,
    busy: opts.busy,
    now: opts.now,
    truncateAt: opts.truncateAt,
  });
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
        "/status — bridge uptime and connection info",
        "/interrupt — send Ctrl+C to this thread's agent (hard interrupt)",
        "/stop — send ESC to this thread's agent (soft cancel of current operation)",
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
    await ctx.reply(formatStatus({
      uptime: `${h}h ${m}m ${s}s`,
      paired: isPaired(state),
      panesCount: deps.map.size,
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

  bot.command("stop", async (ctx) => {
    // Send ESC to the pane — same as pressing ESC in the agent's TUI.
    // Soft-cancels the current operation (tool call, generation) without
    // killing the agent process. For a hard interrupt, use /interrupt.
    //
    // Uses herdr pane send-keys with the named 'Escape' key. Raw ESC
    // bytes via 'pane run' are interpreted as the start of an ANSI CSI
    // sequence and silently swallowed; send-keys routes the named key
    // through the terminal input pipeline and triggers the real handler.
    //
    // PaneAgent.stop() aborts the in-flight loop so the next user
    // message starts a fresh controller. Without this, a stuck turn
    // (e.g. agent outputting in a way that never stabilises for the
    // loop's stability window) would keep the loop alive until the
    // next idle detection.
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    const agent = deps.getPaneAgent?.(mapping.pane_id);
    if (!agent) { await ctx.reply("Pane agent unavailable."); return; }
    sendEscape(mapping.pane_id);
    agent.stop();
    await ctx.reply(`Stopped ${mapping.label}.`);
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
    try {
  const agent = deps.getPaneAgent?.(mapping.pane_id);
       const body = getLastReadback({
         mapping,
         communicator: agent ? ({ getAgentOutput: (n: number) => agent.getLastOutput(), getLatestOutput: () => agent.getLastOutput() } as AgentCommunicator) : (() => { throw new Error("Pane agent unavailable"); })(),
         busy: agent?.isLoopActive() ?? false,
         now: () => new Date().toISOString(),
         truncateAt: 3000,
       });
      await ctx.reply(body);
    } catch (err: any) {
      await ctx.reply(`Failed to read pane: ${err.message}`);
    }
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
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("No pane for this topic.");
      return;
    }
    const agent = deps.getPaneAgent?.(mapping.pane_id);
    if (!agent) { await ctx.reply("Pane agent unavailable."); return; }
    const arg = (ctx.match ?? "").trim();
    const minutes = arg === "" ? (deps.follows_default_minutes ?? 30) : Number.parseInt(arg, 10);
    if (!Number.isFinite(minutes) || minutes < 0) {
      await ctx.reply("Usage: /follow [minutes] — minutes must be a non-negative integer (0 = no timeout).");
      return;
    }
    agent.enableFollow(minutes === 0 ? Date.now() : Date.now() + minutes * 60_000);
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
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("No pane for this topic.");
      return;
    }
    const agent = deps.getPaneAgent?.(mapping.pane_id);
    if (!agent) { await ctx.reply("Pane agent unavailable."); return; }
    agent.disableFollow();
    await ctx.reply("Unfollowed.");
  });
}
