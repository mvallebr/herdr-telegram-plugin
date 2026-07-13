import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPaired, updatePairing } from "../src/pairing.js";
import { saveState, loadState } from "../src/state.js";
import type { DaemonState } from "../src/types.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

describe("isPaired", () => {
  it("returns false when authorized_chat_id is null", () => {
    expect(isPaired({ authorized_chat_id: null, paired_at: null, thread_mappings: {} })).toBe(false);
  });

  it("returns true when authorized_chat_id is set", () => {
    expect(isPaired({ authorized_chat_id: -100, paired_at: "x", thread_mappings: {} })).toBe(true);
  });
});

describe("updatePairing", () => {
  const tmpDir = path.join(os.tmpdir(), "pairing-test-" + Date.now());

  beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("saves authorized_chat_id to state", () => {
    const before = loadState(tmpDir);
    expect(before.authorized_chat_id).toBeNull();

    updatePairing(tmpDir, -100);
    const after = loadState(tmpDir);
    expect(after.authorized_chat_id).toBe(-100);
    expect(after.paired_at).toBeTruthy();
  });
});
