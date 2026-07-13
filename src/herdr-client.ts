import { execSync, spawn, type ChildProcess } from "node:child_process";
import type { PaneInfo } from "./types.js";

const DEFAULT_HERDR_BIN = "herdr";

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || DEFAULT_HERDR_BIN;
}

function execHerdrJson(args: string[]): string {
  return execSync([herdrBin(), ...args].join(" "), {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function execHerdr(args: string[]): void {
  execSync([herdrBin(), ...args].join(" "), { encoding: "utf8", timeout: 30_000 });
}

export function parseAgentList(raw: string): PaneInfo[] {
  try {
    const parsed = JSON.parse(raw);
    const agents: any[] = parsed?.result?.agents ?? [];
    return agents.map((a: any) => ({
      pane_id: String(a.pane_id),
      label: a.foreground_cwd?.split("/").pop() ?? "?",
      agent: a.agent ?? "?",
      tab_id: String(a.tab_id),
      workspace_id: String(a.workspace_id),
      status: String(a.agent_status || "unknown") as PaneInfo["status"],
    }));
  } catch {
    return [];
  }
}

export function getAgents(): PaneInfo[] {
  const raw = execHerdrJson(["agent", "list"]);
  return parseAgentList(raw);
}

export function buildSendTextArgs(paneId: string, text: string): string[] {
  return ["pane", "send-text", paneId, text];
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
