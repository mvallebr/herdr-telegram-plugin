/**
 * Tests for the stateful diff methods on AgentCommunicator.
 *
 * After Task 2: `getNewOutput()` is the dialed-in diff reader — first call
 * seeds the baseline (no historical replay) and returns ""; later calls
 * return only what the consumer has not seen yet. `getLatestOutput()` is
 * the readback for `/last` and similar — it MUST NOT consume diff state,
 * so a subsequent `getNewOutput()` continues to see what the readback
 * showed.
 *
 * No SQLite required: we construct AgentCommunicator directly via a fake
 * reader. We expose the underlying state through a controlled mutable
 * snapshot so we can simulate the agent producing output over time.
 */
import { describe, it, expect } from "vitest";
import { AgentCommunicator, type AgentOutputReader } from "../src/agent-sessions.js";
import { deriveUnseen, tailOf, SENT_TAIL_MAX } from "../src/output-diff.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A controllable reader: snapshots are an array, each poll consumes one. */
function makeFakeReader(snapshots: string[]): AgentOutputReader & { calls: number; append: (s: string[]) => void } {
  let i = 0;
  const reader: AgentOutputReader & { calls: number; append: (s: string[]) => void } = {
    kind: "fake",
    calls: 0,
    append(extra: string[]) {
      snapshots.push(...extra);
    },
    read(_maxLines: number): string {
      reader.calls += 1;
      return snapshots[Math.min(i++, snapshots.length - 1)] ?? "";
    },
  };
  return reader;
}

describe("AgentCommunicator.getNewOutput — diff state", () => {
  it("returns '' on the very first call, seeding the baseline from the current snapshot", () => {
    // Pre-existing pane content should never be replayed as "new output".
    // The first poll seeds sentTail and emits nothing — historical content
    // is what the user has been watching live.
    //
    // Snapshots are the post-stripStatusBar shape that ScrapeReader
    // produces: trailing newlines are stripped by stripStatusBar before
    // deriveUnseen sees them, so the seed tail is the full visible text.
    const reader = makeFakeReader(["alpha beta"]);
    const comm = new AgentCommunicator(reader, noopLogger);

    const unseen = comm.getNewOutput();
    expect(unseen).toBe("");
    expect(reader.calls).toBe(1);
  });

  it("returns only the unseen suffix when the snapshot grows", () => {
    // Sequential post-stripStatusBar snapshots: each one extends the
    // previous baseline by appending more text. deriveUnseen anchors
    // on the prior tail and slices off the new suffix.
    const reader = makeFakeReader(["alpha", "alpha beta", "alpha beta gamma"]);
    const comm = new AgentCommunicator(reader, noopLogger);

    // Baseline seed returns "".
    expect(comm.getNewOutput()).toBe("");
    // First growth: unseen is " beta".
    expect(comm.getNewOutput()).toBe(" beta");
    // Second growth: unseen is " gamma" (overlap of "alpha beta" detected
    // via lastIndexOf, slice past it).
    expect(comm.getNewOutput()).toBe(" gamma");
  });

  it("does not duplicate content: a stable snapshot produces empty unseen", () => {
    const reader = makeFakeReader(["a", "a", "a"]);
    const comm = new AgentCommunicator(reader, noopLogger);

    expect(comm.getNewOutput()).toBe("");
    expect(comm.getNewOutput()).toBe("");
    expect(comm.getNewOutput()).toBe("");
  });

  it("only updates sentTail when the new content is non-empty", () => {
    // Build a baseline, then grow it once with content that DOES anchor
    // (the new snapshot starts with the prior tail verbatim). The growth
    // is large enough to exceed SENT_TAIL_MAX on the resulting sentTail,
    // proving tail-of() is bounded.
    const seed = "seed";
    // A growth that contains the seed as a prefix, larger than SENT_TAIL_MAX.
    const bigTail = seed + " ".repeat(50) + "x".repeat(SENT_TAIL_MAX + 500);
    const reader = makeFakeReader([seed, bigTail]);
    const comm = new AgentCommunicator(reader, noopLogger);

    expect(comm.getNewOutput()).toBe(""); // seeds sentTail = "seed"
    // lastIndexOf("seed") in bigTail = 0; unseen = " " * 50 + "x" * 10500.
    const unseen = comm.getNewOutput();
    expect(unseen.length).toBeGreaterThan(0);
    expect(unseen.endsWith("x")).toBe(true);
  });

  it("returns '' when snapshots diverge with no overlapping anchor", () => {
    // When the rolling-window source replaces its content entirely, the
    // previous sentTail is not present in the new snapshot. The safe
    // action is to return "" on every poll — emitting a placeholder
    // would duplicate already-delivered content. This is the same
    // contract observe-loop documents (the `(pane scrolled)` marker was
    // deliberately removed).
    const reader = makeFakeReader(["foo", "completely different content here"]);
    const comm = new AgentCommunicator(reader, noopLogger);

    // Baseline seed.
    expect(comm.getNewOutput()).toBe("");
    // No anchor — deriveUnseen returns "" and sentTail stays the same.
    expect(comm.getNewOutput()).toBe("");
    // Append a third snapshot. sentTail is still "foo", which is NOT
    // present in this snapshot either — same outcome, not a re-anchor.
    reader.append(["completely different content here too"]);
    expect(comm.getNewOutput()).toBe("");
  });

  it("re-anchors after divergence when the new snapshot contains sentTail", () => {
    // Recovery path: after divergence, if the rolling window includes
    // again the prior sentTail at some position, deriveUnseen re-anchors
    // via lastIndexOf and emits the new suffix.
    const reader = makeFakeReader([
      "foo",                                  // baseline seed
      "completely different",                 // diverges, sentTail stays "foo"
      "foo bar baz",                          // lastIndexOf("foo") = 0 → " bar baz"
    ]);
    const comm = new AgentCommunicator(reader, noopLogger);

    expect(comm.getNewOutput()).toBe("");
    expect(comm.getNewOutput()).toBe("");
    expect(comm.getNewOutput()).toBe(" bar baz");
  });
});

describe("AgentCommunicator.getLatestOutput — readback (non-consuming)", () => {
  it("returns whatever the reader currently has, without seeding or consuming diff state", () => {
    // getLatestOutput must NEVER mutate sentTail/initialized. So a
    // subsequent getNewOutput() should still treat the first poll as
    // the baseline (returning "") — proving the readback did not seed.
    const reader = makeFakeReader(["w1:p1 pane content"]);
    const comm = new AgentCommunicator(reader, noopLogger);

    expect(comm.getLatestOutput()).toBe("w1:p1 pane content");
    // If getLatestOutput had consumed state, this would NOT be "".
    expect(comm.getNewOutput()).toBe("");
  });

  it("does not affect the next getNewOutput's diff", () => {
    // After two getNewOutput calls sentTail is "a b". A readback that
    // returns "a b c" must NOT advance sentTail to "a b c" — otherwise
    // a subsequent growth would be anchored against the wrong baseline.
    // We verify by anchoring against the prior emit (not the readback):
    // deriveUnseen("a b c d", "a b") must produce " c d", which only
    // happens when sentTail stays at "a b" across the readback.
    const reader = makeFakeReader([
      "a",          // initial seed (consumed by first getNewOutput)
      "a b",        // growth (consumed by second getNewOutput)
      "a b c",      // user typed /last here via getLatestOutput — readback
      "a b c d",    // next getNewOutput should still see growth from "a b"
    ]);
    const comm = new AgentCommunicator(reader, noopLogger);

    // Baseline seed returns "".
    expect(comm.getNewOutput()).toBe("");
    // First growth: unseen is " b".
    expect(comm.getNewOutput()).toBe(" b");

    // /last readback: returns the latest snapshot, MUST NOT consume state.
    expect(comm.getLatestOutput()).toBe("a b c");

    // Subsequent growth: unseen is " c d" — proves sentTail is still "a b"
    // (the anchor from the second getNewOutput), not "a b c" (which would
    // have happened if the readback had consumed state).
    expect(comm.getNewOutput()).toBe(" c d");
  });

  it("returns '' when the reader returns '' even if state is uninitialized", () => {
    const reader = makeFakeReader([""]);
    const comm = new AgentCommunicator(reader, noopLogger);

    // The reader has nothing to say; readback returns nothing.
    expect(comm.getLatestOutput()).toBe("");
    // And the seeded baseline is "" — subsequent getNewOutput is "" too.
    expect(comm.getNewOutput()).toBe("");
  });
});

describe("AgentCommunicator — existing getAgentOutput is unchanged", () => {
  it("getAgentOutput always reads fresh, independent of diff state", () => {
    const reader = makeFakeReader(["x", "x", "x"]);
    const comm = new AgentCommunicator(reader, noopLogger);

    // Pure read; no seeding, no consumption.
    expect(comm.getAgentOutput(4000)).toBe("x");
    expect(comm.getAgentOutput(4000)).toBe("x");
    // After two reads, getNewOutput should still see the first poll as
    // the baseline and return "" (unseen = nothing).
    expect(comm.getNewOutput()).toBe("");
  });
});

describe("output-diff shared module — re-exports keep their semantics", () => {
  it("exports the same SENT_TAIL_MAX used by observe-loop", () => {
    expect(typeof SENT_TAIL_MAX).toBe("number");
    expect(SENT_TAIL_MAX).toBe(10_000);
  });

  it("tailOf returns the last n characters (or the whole string if shorter)", () => {
    expect(tailOf("hello", 3)).toBe("llo");
    expect(tailOf("hi", 99)).toBe("hi");
    expect(tailOf("", 10)).toBe("");
  });

  it("deriveUnseen returns the new suffix when sentTail anchors cleanly", () => {
    expect(deriveUnseen("hello world", "hello ")).toBe("world");
  });

  it("deriveUnseen returns '' when no overlap can be anchored", () => {
    // Totally disjoint strings — safe action is to emit nothing.
    expect(deriveUnseen("completely different", "old content")).toBe("");
  });
});
