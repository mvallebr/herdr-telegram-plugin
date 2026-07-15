import { describe, expect, it } from "vitest";
import { coordinateTurn } from "../src/turn-coordinator.js";
import type { AgentWrapper } from "../src/agent-wrapper.js";

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

describe("coordinateTurn", () => {
  it("submits once, reports neutral progress, then forwards the final result", async () => {
    const statuses = [{ state: "working" as const }, { state: "working" as const }, { state: "final" as const, text: "done", source: "codex-jsonl" as const }];
    const submitted: string[] = [];
    const wrapper: AgentWrapper = {
      submit: async (prompt) => { submitted.push(prompt); },
      status: async () => statuses.shift() ?? { state: "working" },
    };
    const calls: string[] = [];
    const clock = fakeClock();
    await coordinateTurn(wrapper, {
      progress: async (seconds) => { calls.push(`progress:${seconds}`); },
      final: async (text, source) => { calls.push(`final:${source}:${text}`); },
      failed: async (reason) => { calls.push(`failed:${reason}`); },
    }, { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 5000 }, clock);
    expect(submitted).toEqual(["hello"]);
    expect(calls).toEqual(["progress:1", "progress:2", "final:codex-jsonl:done"]);
  });

  it("reports a wrapper failure without publishing a final response", async () => {
    const wrapper: AgentWrapper = { submit: async () => {}, status: async () => ({ state: "failed", reason: "jsonl unavailable" }) };
    const calls: string[] = [];
    await coordinateTurn(wrapper, {
      progress: async () => { calls.push("progress"); },
      final: async () => { calls.push("final"); },
      failed: async (reason) => { calls.push(reason); },
    }, { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 5000 }, fakeClock());
    expect(calls).toEqual(["jsonl unavailable"]);
  });

  it("publishes a blocked question and releases the turn without waiting for timeout", async () => {
    const wrapper: AgentWrapper = {
      submit: async () => {},
      status: async () => ({ state: "blocked", question: "1. Continue\n2. Stop" }),
    };
    const calls: string[] = [];
    await coordinateTurn(wrapper, {
      progress: async () => { calls.push("progress"); },
      final: async () => { calls.push("final"); },
      blocked: async (question) => { calls.push(`blocked:${question}`); },
      failed: async () => { calls.push("failed"); },
    }, { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 5000 }, fakeClock());
    expect(calls).toEqual(["blocked:1. Continue\n2. Stop"]);
  });

  it("forwards a changed preview once and suppresses repeated previews", async () => {
    const statuses = [
      { state: "working" as const, preview: "step one" },
      { state: "working" as const, preview: "step one" },
      { state: "final" as const, text: "done", source: "codex-jsonl" as const },
    ];
    const previews: Array<string | undefined> = [];
    await coordinateTurn({ submit: async () => {}, status: async () => statuses.shift() ?? { state: "working" } }, {
      progress: async (_seconds, preview) => { previews.push(preview); },
      final: async () => {}, failed: async () => {},
    }, { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 5000 }, fakeClock());
    expect(previews).toEqual(["step one", undefined]);
  });

  it("sends a later changed preview after an initial neutral Working message", async () => {
    const statuses = [
      { state: "working" as const },
      { state: "working" as const, preview: "now reading the session" },
      { state: "final" as const, text: "done", source: "codex-jsonl" as const },
    ];
    const previews: Array<string | undefined> = [];
    await coordinateTurn({ submit: async () => {}, status: async () => statuses.shift() ?? { state: "working" } }, {
      progress: async (_seconds, preview) => { previews.push(preview); },
      final: async () => {}, failed: async () => {},
    }, { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 5000 }, fakeClock());
    expect(previews).toEqual([undefined, "now reading the session"]);
  });

  it("marks an exact final already published as a preview", async () => {
    const statuses = [
      { state: "working" as const, preview: "same text" },
      { state: "final" as const, text: "same  text", source: "screen-scrape" as const },
    ];
    const finalFlags: boolean[] = [];
    await coordinateTurn({ submit: async () => {}, status: async () => statuses.shift() ?? { state: "working" } }, {
      progress: async () => {},
      final: async (_text, _source, alreadyPublished) => { finalFlags.push(!!alreadyPublished); },
      failed: async () => {},
    }, { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 5000 }, fakeClock());
    expect(finalFlags).toEqual([true]);
  });
});
