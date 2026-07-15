import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgents, resetHerdrBinCache } from "../../src/herdr-client.js";

describe("Herdr CLI integration", () => {
  let dir: string;
  let originalBin: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "herdr-cli-integration-"));
    originalBin = process.env.HERDR_BIN_PATH;
    const bin = join(dir, "herdr");
    writeFileSync(bin, `#!/bin/sh
if [ "$1 $2" = "tab list" ]; then
  echo 'tab unavailable' >&2
  exit 7
fi
echo 'agent unavailable' >&2
exit 9
`);
    chmodSync(bin, 0o755);
    process.env.HERDR_BIN_PATH = bin;
    resetHerdrBinCache();
  });

  afterEach(() => {
    process.env.HERDR_BIN_PATH = originalBin;
    resetHerdrBinCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves the failing command and stderr after a recoverable tab-list failure", () => {
    expect(() => getAgents()).toThrow(/herdr agent list exited 9: agent unavailable/);
  });
});
