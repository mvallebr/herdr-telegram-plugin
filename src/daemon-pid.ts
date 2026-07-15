import { existsSync, readFileSync, unlinkSync } from "node:fs";

/** Remove a PID file only when it still belongs to this process. */
export function removePidFileIfOwned(pidFile: string, pid: number): void {
  try {
    if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() === String(pid)) {
      unlinkSync(pidFile);
    }
  } catch {
    // Process shutdown must not fail because cleanup raced with a replacement.
  }
}
