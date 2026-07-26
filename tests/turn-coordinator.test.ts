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

  describe("stabilityWindowMs (universal, applies to all wrappers)", () => {
    function makeClock() {
      let now = 0;
      return {
        now: () => now,
        sleep: async (ms: number) => { now += ms; },
      };
    }

    it("does not close immediately on first final; waits for stability window", async () => {
      // Two final polls only — far short of the 30s window.
      const statuses = [
        { state: "final" as const, text: "early answer", source: "codex-jsonl" as const },
        { state: "final" as const, text: "early answer", source: "codex-jsonl" as const },
      ];
      const events: string[] = [];
      const clock = makeClock();
      await coordinateTurn(
        { submit: async () => {}, status: async () => statuses.shift() ?? { state: "working" } },
        {
          progress: async () => {},
          final: async (text, source) => { events.push(`final:${source}:${text}`); },
          failed: async () => {},
        },
        { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 60_000, stabilityWindowMs: 30_000 },
        clock,
      );
      expect(events).toEqual([]);
    });

    it("publishes final once the same response persists past stabilityWindowMs", async () => {
      const statuses = Array.from({ length: 60 }, () => ({
        state: "final" as const,
        text: "stable answer",
        source: "pi-jsonl" as const,
      }));
      const events: string[] = [];
      const clock = makeClock();
      await coordinateTurn(
        { submit: async () => {}, status: async () => statuses.shift() ?? { state: "working" } },
        {
          progress: async () => {},
          final: async (text, source) => { events.push(`final:${source}:${text}`); },
          failed: async () => {},
        },
        { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 120_000, stabilityWindowMs: 30_000 },
        clock,
      );
      expect(events).toEqual(["final:pi-jsonl:stable answer"]);
    });

    it("discards a pending final when status returns to working (JSONL flicker)", async () => {
      // Insert a single "working" poll halfway through the streak. After
      // the reset, only 15 more final polls follow — not enough to complete
      // the 30s window from the new starting point.
      const statuses: any[] = [];
      for (let i = 0; i < 15; i++) {
        statuses.push({ state: "final", text: "early", source: "codex-jsonl" });
      }
      statuses.push({ state: "working", preview: "still typing" });
      for (let i = 0; i < 20; i++) {
        statuses.push({ state: "final", text: "early", source: "codex-jsonl" });
      }
      const events: string[] = [];
      const clock = makeClock();
      await coordinateTurn(
        { submit: async () => {}, status: async () => statuses.shift() ?? { state: "working" } },
        {
          progress: async () => {},
          final: async (text, source) => { events.push(`final:${source}:${text}`); },
          failed: async () => {},
        },
        { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 120_000, stabilityWindowMs: 30_000 },
        clock,
      );
      expect(events).toEqual([]);
    });

    it("reports blocked even when a pending final exists", async () => {
      const statuses = [
        { state: "final" as const, text: "still computing", source: "codex-jsonl" as const },
        { state: "blocked" as const, question: "Need approval" },
      ];
      const events: string[] = [];
      const clock = makeClock();
      await coordinateTurn(
        { submit: async () => {}, status: async () => statuses.shift() ?? { state: "working" } },
        {
          progress: async () => {},
          final: async () => events.push("final"),
          blocked: async (q) => events.push(`blocked:${q}`),
          failed: async () => events.push("failed"),
        },
        { prompt: "hello", progressIntervalMs: 1000, maxWaitMs: 60_000, stabilityWindowMs: 30_000 },
        clock,
      );
      expect(events).toEqual(["blocked:Need approval"]);
    });
  });

  describe("abort signal", () => {
    it("forces a final report with the latest preview when aborted mid-loop", async () => {
      const controller = new AbortController();
      let statusCalls = 0;
      // status() returns working with previews until the signal fires; we
      // abort after a few calls to trigger the force-final branch.
      const wrapper: AgentWrapper = {
        submit: async () => {},
        status: async () => {
          statusCalls++;
          if (statusCalls === 4) controller.abort();
          return { state: "working", preview: "thinking about it" };
        },
      };
      const events: string[] = [];
      const clock = fakeClock();
      await coordinateTurn(
        wrapper,
        {
          progress: async (s) => { events.push(`progress:${s}`); },
          final: async (text, source) => { events.push(`final:${source}:${text}`); },
          failed: async (reason) => { events.push(`failed:${reason}`); },
          blocked: async () => { events.push("blocked"); },
        },
        { prompt: "hello", progressIntervalMs: 1, maxWaitMs: 60_000, signal: controller.signal },
        clock,
      );
      // The exact event count can vary with the abort timing; the
      // important invariant is a single force-final terminating the run.
      expect(events.filter((e) => e.startsWith("final:"))).toEqual([
        "final:abort:thinking about it",
      ]);
      expect(events.some((e) => e.startsWith("failed:"))).toBe(false);
    });

    it("emits a placeholder final when aborted before any preview was captured", async () => {
      const controller = new AbortController();
      const wrapper: AgentWrapper = {
        submit: async () => {},
        status: async () => {
          controller.abort();
          return { state: "working" };
        },
      };
      const events: string[] = [];
      const clock = fakeClock();
      await coordinateTurn(
        wrapper,
        {
          progress: async () => {},
          final: async (text, source) => { events.push(`final:${source}:${text}`); },
          failed: async (reason) => { events.push(`failed:${reason}`); },
          blocked: async () => {},
        },
        { prompt: "hello", progressIntervalMs: 1, maxWaitMs: 60_000, signal: controller.signal },
        clock,
      );
      expect(events).toEqual([
        "final:abort:(turn aborted by /stop — no response captured yet)",
      ]);
    });

    it("does nothing if signal is omitted and the wrapper runs to a normal final", async () => {
      // Sanity: existing behaviour must be unchanged when no signal is
      // passed — this guards against regressions in the force-final branch.
      const wrapper: AgentWrapper = {
        submit: async () => {},
        status: async () => ({ state: "final", text: "all good", source: "screen-scrape" }),
      };
      const events: string[] = [];
      await coordinateTurn(
        wrapper,
        {
          progress: async () => {},
          final: async (text, source) => { events.push(`final:${source}:${text}`); },
          failed: async () => {},
          blocked: async () => {},
        },
        { prompt: "hi", progressIntervalMs: 1, maxWaitMs: 1000 },
        fakeClock(),
      );
      expect(events).toEqual(["final:screen-scrape:all good"]);
    });
  });
});
