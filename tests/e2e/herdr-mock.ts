/**
 * Mock implementation of the `herdr` binary for end-to-end tests.
 *
 * The daemon normally spawns the real `herdr` CLI to read pane content and
 * submit text. In E2E tests we replace that binary with this script so we
 * can control pane content, send-text acknowledgements, and agent status
 * deterministically.
 *
 * State is read from a JSON file on disk on every call (cheap; spawnSync
 * already pays a fork cost). The state layout:
 *
 *   { "panes": { "<pane_id>": { "reads": ["line1\n", "line2\n", ...],
 *                                  "text_history": ["received1", ...] } },
 *     "agents": { "<pane_id>": { "status": "idle" | "working" | "done" | "unknown" } },
 *     "tabs": [{ "tab_id": "w1:t1", "workspace_id": "w1", "pane_id": "...",
 *                 "label": "...", "agent": "pi" }, ...] }
 *
 * Reads from `pane read` return one read per call (advances a per-pane
 * index). When the reads queue is exhausted, the last entry is repeated
 * so a stable pane stays stable.
 *
 * `pane send-text` and `pane send-keys` just append to the pane's
 * `text_history` so tests can assert what the daemon sent.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface PaneState {
  reads: string[];
  text_history: string[];
  key_history: string[];
}

export interface AgentState {
  status: "idle" | "working" | "done" | "unknown";
}

export interface TabSpec {
  tab_id: string;
  workspace_id: string;
  pane_id: string;
  label: string;
  agent: string;
}

export interface HerdrMockState {
  panes: Record<string, PaneState>;
  agents: Record<string, AgentState>;
  tabs: TabSpec[];
  /** Counter so the test can correlate readPane calls. */
  read_counts: Record<string, number>;
  /** Counter for pane-list calls. */
  list_count: number;
}

const SCRIPT_HEADER = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const statePath = process.env.MOCK_HERDR_STATE;
function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}
function writeState(s) {
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
}
function getPane(id) {
  const s = readState();
  if (!s.panes[id]) {
    s.panes[id] = { reads: [""], text_history: [], key_history: [] };
    writeState(s);
  }
  return s.panes[id];
}
function getAgent(id) {
  const s = readState();
  if (!s.agents[id]) s.agents[id] = { status: "unknown" };
  return s.agents[id];
}
const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === "tab") {
  const sub = args[1];
  if (sub === "list") {
    const s = readState();
    s.list_count = (s.list_count ?? 0) + 1;
    writeState(s);
    const out = { result: { tabs: s.tabs }, type: "tab_list" };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  process.stderr.write("tab " + sub + " not implemented in mock\\n");
  process.exit(1);
}
if (cmd === "agent") {
  const sub = args[1];
  if (sub === "list") {
    const s = readState();
    const agents = Object.entries(s.agents).map(([pane_id, a]) => ({ pane_id, agent_status: a.status, agent: "pi" }));
    process.stdout.write(JSON.stringify({ result: { agents }, type: "agent_list" }));
    process.exit(0);
  }
  if (sub === "get") {
    const target = args[2];
    const s = readState();
    const a = s.agents[target] ?? { status: "unknown" };
    process.stdout.write(JSON.stringify({ result: { agent: { pane_id: target, agent: "pi", agent_status: a.status, agent_session: { agent: "pi", kind: "path", source: "mock", value: "/tmp/session.jsonl" }, cwd: "/tmp", focused: true, foreground_cwd: "/tmp", tab_id: "t1", workspace_id: "w1", terminal_id: "term1" } }, type: "agent_info" }));
    process.exit(0);
  }
}
if (cmd === "pane") {
  const sub = args[1];
  if (sub === "list") {
    const s = readState();
    process.stdout.write(JSON.stringify({ result: { panes: Object.entries(s.panes).map(([pane_id, p]) => ({ pane_id, agent: "pi", agent_status: s.agents[pane_id]?.status ?? "unknown", cwd: "/tmp", focused: false, foreground_cwd: "/tmp", tab_id: "t1", workspace_id: "w1", terminal_id: "term1", scroll: { max_offset_from_bottom: 100, offset_from_bottom: 0, viewport_rows: 24 } })) }, type: "pane_list" }));
    process.exit(0);
  }
  if (sub === "read") {
    const paneId = args[2];
    const s = readState();
    s.read_counts = s.read_counts ?? {};
    s.read_counts[paneId] = (s.read_counts[paneId] ?? 0) + 1;
    const pane = s.panes[paneId] ?? { reads: [""] };
    const idx = Math.min(s.read_counts[paneId] - 1, pane.reads.length - 1);
    const content = pane.reads[idx] ?? "";
    process.stdout.write(content);
    process.exit(0);
  }
  if (sub === "send-text" || sub === "run") {
    const paneId = args[2];
    const text = args.slice(3).join(" ");
    const s = readState();
    const pane = getPane(paneId);
    pane.text_history.push(text);
    s.panes[paneId] = pane;
    writeState(s);
    process.exit(0);
  }
  if (sub === "send-keys") {
    const paneId = args[2];
    const key = args[3];
    const s = readState();
    const pane = getPane(paneId);
    pane.key_history.push(key);
    s.panes[paneId] = pane;
    writeState(s);
    process.exit(0);
  }
}
process.stderr.write("mock-herdr: unknown command " + JSON.stringify(args) + "\\n");
process.exit(2);
`;

export class MockHerdr {
  readonly dir: string;
  readonly bin: string;
  readonly statePath: string;
  private state: HerdrMockState;

  constructor(initial?: Partial<HerdrMockState>) {
    this.dir = mkdtempSync(join(tmpdir(), "herdr-mock-"));
    this.bin = join(this.dir, "herdr");
    this.statePath = join(this.dir, "state.json");
    writeFileSync(this.bin, SCRIPT_HEADER);
    chmodSync(this.bin, 0o755);
    this.state = {
      panes: initial?.panes ?? {},
      agents: initial?.agents ?? {},
      tabs: initial?.tabs ?? [],
      read_counts: {},
      list_count: 0,
    };
    this.persist();
  }

  /** Replace the state wholesale. Useful for simulating a follow subscription
   *  completing or an agent flipping status. */
  setState(next: HerdrMockState): void {
    this.state = next;
    this.persist();
  }

  setPaneContent(paneId: string, reads: string[]): void {
    this.state.panes[paneId] = {
      reads,
      text_history: this.state.panes[paneId]?.text_history ?? [],
      key_history: this.state.panes[paneId]?.key_history ?? [],
    };
    this.persist();
  }

  appendPaneRead(paneId: string, next: string): void {
    if (!this.state.panes[paneId]) {
      this.state.panes[paneId] = { reads: [""], text_history: [], key_history: [] };
    }
    this.state.panes[paneId].reads.push(next);
    this.persist();
  }

  setAgentStatus(paneId: string, status: AgentState["status"]): void {
    this.state.agents[paneId] = { status };
    this.persist();
  }

  addTab(tab: TabSpec): void {
    this.state.tabs.push(tab);
    this.persist();
  }

  /** Run the mock herdr binary in a child process. Helper for tests that
   *  need to inspect the resulting state. */
  run(args: string[]): SpawnSyncReturns<string> {
    return spawnSync(this.bin, args, {
      encoding: "utf8",
      env: { ...process.env, MOCK_HERDR_STATE: this.statePath },
    });
  }

  textHistory(paneId: string): string[] {
    return this.state.panes[paneId]?.text_history ?? [];
  }

  keyHistory(paneId: string): string[] {
    return this.state.panes[paneId]?.key_history ?? [];
  }

  readCount(paneId: string): number {
    return this.state.read_counts[paneId] ?? 0;
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private persist(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }
}
