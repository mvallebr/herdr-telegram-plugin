import { Bot, type Context, InlineKeyboard } from "grammy";
import type { PaneInfo, ThreadMapping } from "./types.js";
import { getAgents, sendText } from "./herdr-client.js";
import { findMapping } from "./mapping.js";
import { isPaired } from "./pairing.js";
import type { DaemonState } from "./types.js";
import { loadState, saveState } from "./state.js";

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

export function formatStatus(opts: { uptime: string; paired: boolean; panesCount: number }): string {
  return [
    `Bridge uptime: ${opts.uptime}`,
    `Paired: ${opts.paired ? "yes" : "no"}`,
    `Active panes: ${opts.panesCount}`,
  ].join("\n");
}

export interface CommandDeps {
  map: Map<number, ThreadMapping>;
  stateDir: string;
  chatId: number;
  startTime: number;
  saveMappings: () => void;
}

export function registerCommands(bot: Bot<Context>, deps: CommandDeps): void {
  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "/help — this message",
        "/agents — list agents with status and bound threads",
        "/bind <pane-label> — bind this thread to a pane (use in a new thread)",
        "/unbind — unbind this thread",
        "/status — bridge uptime and connection info",
        "/interrupt — send Ctrl+C to this thread's agent",
        "/trust — send 'trust, always allow' to this thread's agent",
        "/digest — today's activity (coming soon)",
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

  bot.command("trust", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    sendText(mapping.pane_id, "trust, always allow");
    await ctx.reply(`Trusted ${mapping.label}`);
  });

  bot.command("digest", async (ctx) => {
    await ctx.reply("Digest coming soon. Use /agents for current status.");
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
}
