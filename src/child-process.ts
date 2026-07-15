/**
 * Internal seam around Node's process APIs. Keeping this import in one place
 * lets tests replace process execution without coupling to Node internals.
 */
export { spawnSync, spawn } from "node:child_process";
export type { ChildProcess } from "node:child_process";
