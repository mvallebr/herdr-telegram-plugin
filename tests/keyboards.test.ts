import { describe, expect, it } from "vitest";
import { workingKeyboard, finalKeyboard, parseActionCallback } from "../src/keyboards.js";

describe("workingKeyboard", () => {
  it("returns Stop / Last / Status when no follow is active", () => {
    const kb = workingKeyboard(140, false);
    expect(kb.inline_keyboard).toEqual([[
      { text: "Stop", callback_data: "act:stop:140" },
      { text: "Last", callback_data: "act:last:140" },
      { text: "Status", callback_data: "act:status:140" },
    ]]);
  });

  it("inserts Unfollow between Stop and Last when follow is active", () => {
    const kb = workingKeyboard(140, true);
    expect(kb.inline_keyboard[0]).toEqual([
      { text: "Stop", callback_data: "act:stop:140" },
      { text: "Unfollow", callback_data: "act:unfollow:140" },
      { text: "Last", callback_data: "act:last:140" },
      { text: "Status", callback_data: "act:status:140" },
    ]);
  });
});

describe("finalKeyboard", () => {
  it("returns Follow 5m / Follow 30m / Last / Status when no follow is active", () => {
    const kb = finalKeyboard(140, false);
    expect(kb.inline_keyboard[0]).toEqual([
      { text: "Follow 5m", callback_data: "act:follow:5:140" },
      { text: "Follow 30m", callback_data: "act:follow:30:140" },
      { text: "Last", callback_data: "act:last:140" },
      { text: "Status", callback_data: "act:status:140" },
    ]);
  });

  it("surfaces Unfollow instead of Follow 5m / 30m when a follow is active", () => {
    const kb = finalKeyboard(140, true);
    expect(kb.inline_keyboard[0]).toEqual([
      { text: "Unfollow", callback_data: "act:unfollow:140" },
      { text: "Last", callback_data: "act:last:140" },
      { text: "Status", callback_data: "act:status:140" },
    ]);
  });
});

describe("parseActionCallback", () => {
  it("parses a 3-part payload: command:threadId", () => {
    expect(parseActionCallback("act:stop:140")).toEqual({ command: "stop", args: "", threadId: 140 });
  });

  it("parses a 4-part payload: command:args:threadId", () => {
    expect(parseActionCallback("act:follow:30:140")).toEqual({ command: "follow", args: "30", threadId: 140 });
  });

  it("returns null on non-act payloads", () => {
    expect(parseActionCallback("bind:w1:p1:140")).toBeNull();
    expect(parseActionCallback("random")).toBeNull();
  });

  it("returns null on malformed payloads", () => {
    expect(parseActionCallback("act:")).toBeNull();
    expect(parseActionCallback("act:stop:")).toBeNull();
  });
});
