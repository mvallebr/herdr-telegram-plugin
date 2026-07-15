import { describe, expect, it } from "vitest";
import { JsonlSessionWrapper, ScreenScrapeWrapper } from "../src/agent-wrappers.js";

function clock() {
  let value = 0;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

describe("agent wrappers", () => {
  it("submits once and exposes a correlated JSONL final only through status", async () => {
    const sent: string[] = [];
    let reads = 0;
    const c = clock();
    const wrapper = new JsonlSessionWrapper(
      "codex-jsonl",
      (_since, prompt) => ++reads === 1 ? null : { text: `answer to ${prompt}`, timestamp: "", source: "codex-jsonl" },
      (prompt) => sent.push(prompt),
      c.now
    );
    await wrapper.submit("hello");
    expect(sent).toEqual(["hello"]);
    expect(await wrapper.status()).toEqual({ state: "working" });
    expect(await wrapper.status()).toEqual({ state: "final", text: "answer to hello", source: "codex-jsonl" });
  });

  it("does not leak pre-existing terminal content and waits for stable scraped output", async () => {
    const c = clock();
    let pane = "old unrelated answer";
    const sent: string[] = [];
    const wrapper = new ScreenScrapeWrapper("pane", 100, 1000, {
      now: c.now,
      sendText: (_pane, text) => sent.push(text),
      readPane: () => pane,
    });
    await wrapper.submit("new prompt");
    expect(await wrapper.status()).toEqual({ state: "working" });
    pane = "old unrelated answer\nnew prompt\nnew response";
    expect(await wrapper.status()).toEqual({ state: "working", preview: "new response" });
    c.advance(999);
    expect(await wrapper.status()).toEqual({ state: "working", preview: "new response" });
    c.advance(1);
    expect(await wrapper.status()).toEqual({ state: "final", text: "new response", source: "screen-scrape" });
    expect(sent).toEqual(["new prompt"]);
  });

  it("ignores status-bar refreshes while deciding whether screen output is stable", async () => {
    const c = clock();
    let pane = "prompt\nanswer\nModel: one";
    const wrapper = new ScreenScrapeWrapper("pane", 100, 1000, {
      now: c.now, sendText: () => {}, readPane: () => pane,
    });
    await wrapper.submit("prompt");
    c.advance(500);
    pane = "prompt\nanswer\nModel: two";
    expect(await wrapper.status()).toEqual({ state: "working", preview: "answer" });
    c.advance(500);
    expect(await wrapper.status()).toEqual({ state: "final", text: "answer", source: "screen-scrape" });
  });

  it("widens its terminal window when a long response scrolls the prompt away", async () => {
    const c = clock();
    const requested: number[] = [];
    const wrapper = new ScreenScrapeWrapper("pane", 50, 1000, {
      now: c.now,
      sendText: () => {},
      readPane: (_pane, lines) => {
        requested.push(lines);
        return lines < 100 ? "response without the prompt" : "prompt\nrecovered response";
      },
    }, 100);
    await wrapper.submit("prompt");
    expect(await wrapper.status()).toEqual({ state: "working" });
    expect(await wrapper.status()).toEqual({ state: "working", preview: "recovered response" });
    expect(requested).toEqual([50, 50, 100]);
  });

  it("uses a changed idle screen only when anchor and delta are unavailable", async () => {
    const c = clock();
    let pane = "old screen";
    const wrapper = new ScreenScrapeWrapper("pane", 50, 1000, {
      now: c.now, sendText: () => {}, readPane: () => pane, getStatus: () => "idle",
    });
    await wrapper.submit("prompt");
    pane = "unrelated final answer";
    expect(await wrapper.status()).toEqual({ state: "working", preview: "unrelated final answer" });
    c.advance(1000);
    expect(await wrapper.status()).toEqual({ state: "final", text: "unrelated final answer", source: "screen-scrape" });
  });

  it("reports a Herdr-blocked interactive question instead of a final screen response", async () => {
    const wrapper = new ScreenScrapeWrapper("pane", 50, 1000, {
      now: () => 0,
      sendText: () => {},
      getStatus: () => "blocked",
      readPane: () => "→ Asked 1 question\n\nWhat should happen next?\n1. Continue\n2. Stop",
    });
    await wrapper.submit("prompt");
    expect(await wrapper.status()).toEqual({
      state: "blocked",
      question: "What should happen next?\n1. Continue\n2. Stop",
    });
  });
});
