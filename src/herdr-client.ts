import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PaneInfo } from "./types.js";

const DEFAULT_HERDR_BIN = "herdr";
const COMMON_PATHS = [
  "/usr/local/bin/herdr",
  "/usr/bin/herdr",
  join(homedir(), ".local/bin/herdr"),
  join(homedir(), ".cargo/bin/herdr"),
];
let cachedBin: string | undefined;

/**
 * Resolve the herdr binary path. Tries in order:
 *   1. HERDR_BIN_PATH env var (explicit override)
 *   2. `which herdr` lookup
 *   3. Common install paths (/usr/local/bin, ~/.local/bin, ~/.cargo/bin)
 *   4. Falls back to "herdr" (resolved by spawnSync via PATH)
 *
 * Result is cached after the first successful resolution.
 */
export function herdrBin(): string {
  if (cachedBin) return cachedBin;
  // 1. Explicit override
  if (process.env.HERDR_BIN_PATH && existsSync(process.env.HERDR_BIN_PATH)) {
    cachedBin = process.env.HERDR_BIN_PATH;
    return cachedBin;
  }
  // 2. which herdr
  try {
    const which = spawnSync("which", ["herdr"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (which.status === 0 && which.stdout.trim()) {
      cachedBin = which.stdout.trim();
      return cachedBin;
    }
  } catch {
    // which not available
  }
  // 3. Common paths
  for (const p of COMMON_PATHS) {
    if (existsSync(p)) {
      cachedBin = p;
      return cachedBin;
    }
  }
  // 4. Fall back to bare name (PATH lookup)
  cachedBin = DEFAULT_HERDR_BIN;
  return cachedBin;
}

/** Reset the cached herdr binary path (for testing). */
export function resetHerdrBinCache(): void {
  cachedBin = undefined;
}

function describeError(args: string[]): string {
  return `herdr ${args.join(" ")}`;
}

function execHerdrJson(args: string[]): string {
  const bin = herdrBin();
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new Error(
      `${describeError(args)} failed: ${result.error.message}` +
        (code ? ` (errno ${code}; binary: ${bin})` : ` (binary: ${bin})`)
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${describeError(args)} exited ${result.status}: ${result.stderr.trim() || "(no stderr)"}`
    );
  }
  return result.stdout.trim();
}

function execHerdr(args: string[]): void {
  const bin = herdrBin();
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new Error(
      `${describeError(args)} failed: ${result.error.message}` +
        (code ? ` (errno ${code}; binary: ${bin})` : ` (binary: ${bin})`)
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${describeError(args)} exited ${result.status}: ${result.stderr.trim() || "(no stderr)"}`
    );
  }
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
