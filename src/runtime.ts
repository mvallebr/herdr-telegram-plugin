import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 5;

export function runtimeRequirementError(
  version = process.versions.node,
  sqliteAvailable = hasNodeSqlite(),
): string | null {
  const [major, minor] = version.split(".").map(Number);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR ||
      (major === MIN_NODE_MAJOR && (!Number.isFinite(minor) || minor < MIN_NODE_MINOR))) {
    return `Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 is required (running ${version})`;
  }
  if (!sqliteAvailable) {
    return "node:sqlite is required but unavailable in this Node.js runtime";
  }
  return null;
}

export function assertRuntimeRequirements(): void {
  const error = runtimeRequirementError();
  if (error) throw new Error(`Runtime requirements not met: ${error}`);
}

export function hasNodeSqlite(): boolean {
  try {
    return Boolean(require_("node:sqlite")?.DatabaseSync);
  } catch {
    return false;
  }
}
