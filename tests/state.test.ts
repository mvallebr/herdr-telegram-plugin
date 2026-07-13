import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadState, saveState } from "../src/state.js";
import type { DaemonState } from "../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("loadState / saveState", () => {
  const tmpDir = path.join(os.tmpdir(), "herdr-telegram-state-test-" + Date.now());

  beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns empty state when file absent", () => {
    const state = loadState(tmpDir);
    expect(state.authorized_chat_id).toBeNull();
    expect(state.paired_at).toBeNull();
    expect(state.thread_mappings).toEqual({});
  });

  it("round-trips state", () => {
    const orig: DaemonState = {
      authorized_chat_id: -100,
      paired_at: "2026-01-01T00:00:00Z",
      thread_mappings: { "140": { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "..." } },
    };
    saveState(tmpDir, orig);
    const loaded = loadState(tmpDir);
    expect(loaded).toEqual(orig);
  });
});
