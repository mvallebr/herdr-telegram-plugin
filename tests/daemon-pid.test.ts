import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removePidFileIfOwned } from "../src/daemon-pid.js";

describe("removePidFileIfOwned", () => {
  it("does not delete a replacement daemon's PID file", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-pid-"));
    const file = join(dir, "daemon.pid");
    try {
      writeFileSync(file, "222");
      removePidFileIfOwned(file, 111);
      expect(readFileSync(file, "utf8")).toBe("222");
      removePidFileIfOwned(file, 222);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
