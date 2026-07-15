/**
 * Herdr adapters behind the AgentWrapper seam.
 *
 * The coordinator never needs to know whether an agent exposes a JSONL
 * session log or only a terminal pane.  Every adapter accepts one submit and
 * exposes the same polled status contract.
 */
import type { AgentWrapper, AgentStatus } from "./agent-wrapper.js";
import type { OutputSource } from "./output-reader.js";
import { getAgentInfo, readPane, sendText } from "./herdr-client.js";
import { pickOutputStrategy, readAgentSessionProgress, type AgentResponse } from "./agent-sessions.js";
import { cleanPaneOutput, extractScreenDelta, extractScreenResponse, stripStatusBar } from "./wait-loop.js";

export interface ScreenWrapperDeps {
  sendText: (paneId: string, text: string) => void;
  readPane: (paneId: string, lines: number) => string;
  now: () => number;
  getStatus?: () => string;
}

/** Terminal-only adapter. It only returns text anchored after this turn's prompt. */
export class ScreenScrapeWrapper implements AgentWrapper {
  private prompt = "";
  private lastStableContent = "";
  private initialContent = "";
  private changedAt = 0;
  private scanLines: number;

  constructor(
    private readonly paneId: string,
    private readonly maxLines: number,
    private readonly stabilityWindowMs: number,
    private readonly deps: ScreenWrapperDeps,
    private readonly maxScanLines = Math.max(maxLines, 4_000)
  ) {
    this.scanLines = maxLines;
  }

  async submit(prompt: string): Promise<void> {
    this.prompt = prompt;
    this.deps.sendText(this.paneId, prompt);
    try {
      this.lastStableContent = this.deps.readPane(this.paneId, this.scanLines);
    } catch {
      this.lastStableContent = "";
    }
    this.lastStableContent = stripStatusBar(this.lastStableContent);
    this.initialContent = this.lastStableContent;
    this.changedAt = this.deps.now();
  }

  async status(): Promise<AgentStatus> {
    let current: string;
    try {
      current = this.deps.readPane(this.paneId, this.scanLines);
    } catch {
      return { state: "working" };
    }
    const stableCurrent = stripStatusBar(current);
    const anchored = extractScreenResponse(current, this.prompt) || extractScreenDelta(this.initialContent, stableCurrent);
    const isIdle = this.deps.getStatus?.() === "idle" || this.deps.getStatus?.() === "done";
    // OpenCode can erase both the prompt and the shared terminal prefix. If
    // Herdr independently confirms idle and the pane changed after submit,
    // the cleaned current screen is safer than dropping a completed answer.
    const response = anchored || (isIdle && stableCurrent !== this.initialContent ? cleanScreen(current) : "");
    if (!response.trim()) {
      // A long response can scroll its prompt out of a short recent-pane
      // window. Expand the scan before declaring this turn unextractable.
      if (this.scanLines < this.maxScanLines) {
        this.scanLines = Math.min(this.maxScanLines, this.scanLines * 2);
      }
      return { state: "working" };
    }

    if (stableCurrent !== this.lastStableContent) {
      this.lastStableContent = stableCurrent;
      this.changedAt = this.deps.now();
      return { state: "working", preview: response };
    }
    if (this.deps.now() - this.changedAt < this.stabilityWindowMs) {
      return { state: "working", preview: response };
    }
    return { state: "final", text: response, source: "screen-scrape" };
  }
}

/** Structured-log adapter (Codex, Pi, OMP and future session-log agents). */
export class JsonlSessionWrapper implements AgentWrapper {
  private prompt = "";
  private submittedAt = 0;

  constructor(
    private readonly source: OutputSource,
    private readonly readResponse: (sinceMs: number, prompt: string) => AgentResponse | null,
    private readonly send: (prompt: string) => void,
    private readonly now: () => number,
    private readonly readProgress?: (sinceMs: number, prompt: string) => AgentResponse | null
  ) {}

  async submit(prompt: string): Promise<void> {
    this.prompt = prompt;
    this.submittedAt = this.now();
    this.send(prompt);
  }

  async status(): Promise<AgentStatus> {
    const response = this.readResponse(this.submittedAt, this.prompt);
    if (response?.text) return { state: "final", text: response.text, source: this.source };
    const progress = this.readProgress?.(this.submittedAt, this.prompt);
    return progress?.text ? { state: "working", preview: progress.text } : { state: "working" };
  }
}

export interface WrapperFactoryDeps extends ScreenWrapperDeps {
  getAgentInfo: typeof getAgentInfo;
}

export const defaultWrapperDeps: WrapperFactoryDeps = {
  sendText,
  readPane,
  now: () => Date.now(),
  getAgentInfo,
};

/** Select the narrowest reliable adapter for the pane, once per turn. */
export function createAgentWrapper(
  paneId: string,
  options: { maxOutputLines: number; maxScanLines?: number; stabilityWindowMs: number },
  supplied: Partial<WrapperFactoryDeps> = {}
): AgentWrapper {
  const deps = { ...defaultWrapperDeps, ...supplied };
  let info: ReturnType<typeof getAgentInfo> = null;
  try { info = deps.getAgentInfo(paneId); } catch { /* screen fallback */ }
  const strategy = pickOutputStrategy(info?.agent_session, info?.agent ?? "?");
  if (strategy.strategy === "jsonl") {
    const source: OutputSource = info?.agent === "omp" ? "omp-jsonl" :
      info?.agent === "codex" ? "codex-jsonl" : "pi-jsonl";
    return new JsonlSessionWrapper(
      source,
      strategy.reader,
      (prompt) => deps.sendText(paneId, prompt),
      deps.now,
      info?.agent === "codex"
        ? (sinceMs, prompt) => readAgentSessionProgress(info!.agent_session, "codex", sinceMs, prompt)
        : undefined
    );
  }
  return new ScreenScrapeWrapper(paneId, options.maxOutputLines, options.stabilityWindowMs, {
    ...deps,
    getStatus: () => deps.getAgentInfo(paneId)?.agent_status ?? "unknown",
  }, options.maxScanLines);
}

function cleanScreen(content: string): string {
  return cleanPaneOutput(content);
}
