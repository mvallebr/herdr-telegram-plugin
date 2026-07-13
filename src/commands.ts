import { Bot, type Context } from "grammy";
import type { PaneInfo, ThreadMapping } from "./types.js";
import { getAgents, sendText } from "./herdr-client.js";
import { findMapping } from "./mapping.js";
import { isPaired } from "./pairing.js";
import type { DaemonState } from "./types.js";
import { loadState } from "./state.js";

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
}

export function registerCommands(bot: Bot<Context>, deps: CommandDeps): void {
  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "/help — this message",
        "/agents — list agents with status and topic IDs",
        "/status — bridge uptime and connection info",
        "/interrupt — send Ctrl+C to this topic's agent",
        "/trust — send 'trust, always allow' to this topic's agent",
        "/digest — today's activity (coming soon)",
        "",
        "Plain text in any topic is sent to that topic's pane.",
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
    sendText(mapping.pane_id, "\x03");
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
}
