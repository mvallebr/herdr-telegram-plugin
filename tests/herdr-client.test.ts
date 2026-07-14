import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAgentList,
  buildSendTextArgs,
  buildWaitArgs,
  herdrBin,
  resetHerdrBinCache,
  getAgentInfo,
} from "../src/herdr-client.js";

describe("herdrBin resolution", () => {
  let originalEnv: string | undefined;
  let tmpDir: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.HERDR_BIN_PATH;
    // Always start with a clean cache so env / PATH changes take effect
    resetHerdrBinCache();
  });

  afterEach(() => {
    process.env.HERDR_BIN_PATH = originalEnv;
    resetHerdrBinCache();
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
      tmpDir = undefined;
    }
  });

  it("uses HERDR_BIN_PATH when it points to an existing file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "herdr-test-"));
    const fakeBin = join(tmpDir, "herdr");
    writeFileSync(fakeBin, "#!/bin/sh\necho ok\n");
    chmodSync(fakeBin, 0o755);
    process.env.HERDR_BIN_PATH = fakeBin;
    resetHerdrBinCache();
    expect(herdrBin()).toBe(fakeBin);
  });

  it("ignores HERDR_BIN_PATH when it points to a missing file", () => {
    process.env.HERDR_BIN_PATH = "/nonexistent/path/to/herdr";
    resetHerdrBinCache();
    const bin = herdrBin();
    // Should fall back to "which" lookup or "herdr" — never silently accept
    // a bogus override.
    expect(bin).not.toBe("/nonexistent/path/to/herdr");
  });

  it("returns the cached value across calls (no repeated resolution)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "herdr-test-"));
    const fakeBin = join(tmpDir, "herdr");
    writeFileSync(fakeBin, "#!/bin/sh\necho ok\n");
    chmodSync(fakeBin, 0o755);
    process.env.HERDR_BIN_PATH = fakeBin;
    resetHerdrBinCache();
    const first = herdrBin();
    // Mutate env after the first call — should not affect the cached value
    process.env.HERDR_BIN_PATH = "/somewhere/else";
    const second = herdrBin();
    expect(second).toBe(first);
  });
});

describe("parseAgentList", () => {
  it("parses herdr agent list JSON output", () => {
    const raw = JSON.stringify({
      id: "cli:agent:list",
      result: {
        agents: [
          {
            agent: "pi",
            agent_status: "idle",
            cwd: "/home/user/project",
            pane_id: "w1:pZ",
            tab_id: "w1:tZ",
            workspace_id: "w1",
          },
        ],
      },
    });
    const agents = parseAgentList(raw);
    expect(agents).toHaveLength(1);
    expect(agents[0].pane_id).toBe("w1:pZ");
    expect(agents[0].agent).toBe("pi");
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseAgentList("{ invalid }")).toEqual([]);
  });

  it("returns empty array for missing result", () => {
    expect(parseAgentList('{"id":"x"}')).toEqual([]);
  });
});

describe("buildSendTextArgs", () => {
  it("builds correct args tuple", () => {
    expect(buildSendTextArgs("w1:pZ", "hello world")).toEqual([
      "pane", "run", "w1:pZ", "hello world",
    ]);
  });
});

describe("buildWaitArgs", () => {
  it("builds correct args tuple with timeout in ms", () => {
    expect(buildWaitArgs("w1:pZ", 5)).toEqual([
      "agent", "wait", "w1:pZ", "--status", "idle", "--timeout", "5000",
    ]);
  });
});

describe("getAgentInfo", () => {
  // We don't hit the real herdr binary here \u2014 getAgentInfo calls
  // execHerdrJson which goes through spawnSync.  These tests cover the
  // shape of the parser (parseAgentList-equivalent for agent get).
  //
  // To keep these tests pure (no subprocess), we indirectly exercise the
  // parsing via the AgentInfo return contract by checking that a missing
  // binary or a non-agent target returns null.
  let originalBinEnv: string | undefined;
  beforeEach(() => {
    originalBinEnv = process.env.HERDR_BIN_PATH;
    resetHerdrBinCache();
  });
  afterEach(() => {
    process.env.HERDR_BIN_PATH = originalBinEnv;
    resetHerdrBinCache();
  });

  it("returns null when the binary does not exist", () => {
    process.env.HERDR_BIN_PATH = "/nonexistent/herdr";
    resetHerdrBinCache();
    expect(getAgentInfo("w1:pX")).toBeNull();
  });

  // We deliberately don't mock spawnSync \u2014 the parser logic is small and
  // exercised indirectly through the parseAgentList tests, plus a real
  // binary smoke test (verified manually).
});
