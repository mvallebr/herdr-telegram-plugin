import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MIN_NODE_MAJOR, MIN_NODE_MINOR } from "./runtime.js";

type Probe = (binary: string) => boolean;

function defaultProbe(binary: string): boolean {
  const result = spawnSync(binary, ["-e", "require('node:sqlite')"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return result.status === 0;
}

/** Return the first executable that has the runtime features the bridge needs. */
export function resolveCompatibleNode(
  candidates: string[],
  probe: Probe = defaultProbe,
): string | null {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (probe(candidate)) return candidate;
  }
  return null;
}

function nvmNodeCandidates(): string[] {
  const root = join(process.env.NVM_DIR ?? join(homedir(), ".nvm"), "versions", "node");
  try {
    return readdirSync(root)
      .sort()
      .reverse()
      .map((version) => join(root, version, "bin", "node"));
  } catch {
    return [];
  }
}

/** Resolve a Node binary independently of the PATH inherited by Herdr. */
export function resolveBridgeNode(): string | null {
  const candidates = [
    process.env.HERDR_NODE_BIN ?? "",
    process.env.NVM_BIN ? join(process.env.NVM_BIN, "node") : "",
    process.execPath,
    ...nvmNodeCandidates(),
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/bin/node",
  ];
  return resolveCompatibleNode(candidates);
}

export const runtimeRequirement = `Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 with node:sqlite`;
