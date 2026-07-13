import { execSync, spawnSync, spawn, type ChildProcess } from "node:child_process";
import type { PaneInfo } from "./types.js";

const DEFAULT_HERDR_BIN = "herdr";

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || DEFAULT_HERDR_BIN;
}

function execHerdrJson(args: string[]): string {
  const result = spawnSync(herdrBin(), args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `herdr exited with ${result.status}`);
  return result.stdout.trim();
}

function execHerdr(args: string[]): void {
  const result = spawnSync(herdrBin(), args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `herdr exited with ${result.status}`);
}

export function parseAgentList(raw: string, tabLabels?: Map<string, string>): PaneInfo[] {
  try {
    const parsed = JSON.parse(raw);
    const agents: any[] = parsed?.result?.agents ?? [];
    return agents.map((a: any) => {
      const tabId = String(a.tab_id);
      // Prefer tab label from herdr tab list, fall back to cwd dirname
      const label = tabLabels?.get(tabId) ?? a.foreground_cwd?.split("/").pop() ?? "?";
      return {
        pane_id: String(a.pane_id),
        label,
        agent: a.agent ?? "?",
        tab_id: tabId,
        workspace_id: String(a.workspace_id),
        status: String(a.agent_status || "unknown") as PaneInfo["status"],
      };
    });
  } catch {
    return [];
  }
}

export function getAgents(): PaneInfo[] {
  // Fetch tab labels first, preserving order (some agents on same host share a tab)
  let tabLabels = new Map<string, string>();
  const tabOrder: string[] = [];
  try {
    const tabRaw = execHerdrJson(["tab", "list"]);
    const tabs = JSON.parse(tabRaw);
    const tabItems: any[] = tabs?.result?.tabs ?? [];
    for (const t of tabItems) {
      if (t.tab_id && t.label) {
        tabLabels.set(String(t.tab_id), String(t.label));
        tabOrder.push(String(t.tab_id));
      }
    }
  } catch {
    // Tab list failed — fall back to cwd dirnames
  }
  const raw = execHerdrJson(["agent", "list"]);
  const agents = parseAgentList(raw, tabLabels);
  // Sort by tab order from herdr
  const orderMap = new Map(tabOrder.map((id, i) => [id, i]));
  agents.sort((a, b) => {
    const ai = orderMap.get(a.tab_id) ?? 9999;
    const bi = orderMap.get(b.tab_id) ?? 9999;
    return ai - bi;
  });
  return agents;
}

export function buildSendTextArgs(paneId: string, text: string): string[] {
  return ["pane", "run", paneId, text];
}

export function sendText(paneId: string, text: string): void {
  execHerdr(buildSendTextArgs(paneId, text));
}

export function buildWaitArgs(paneId: string, timeoutS: number): string[] {
  return ["agent", "wait", paneId, "--status", "idle", "--timeout", String(timeoutS * 1000)];
}

export function waitIdle(
  paneId: string,
  timeoutS: number
): { status: "idle" | "blocked" | "timeout" } {
  try {
    execHerdr(buildWaitArgs(paneId, timeoutS));
    return { status: "idle" };
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? "");
    if (msg.includes("timeout")) return { status: "timeout" };
    if (msg.includes("blocked")) return { status: "blocked" };
    throw err;
  }
}

export function readPane(paneId: string, lines: number): string {
  return execHerdrJson([
    "pane", "read", paneId, "--source", "recent",
    "--lines", String(lines), "--format", "text",
  ]);
}

export function spawnDaemon(args: string[], herdrBinPath?: string): ChildProcess {
  const bin = herdrBinPath || herdrBin();
  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}
