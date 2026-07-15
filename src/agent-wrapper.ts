/**
 * Agent-facing seam.  Every transport has the same lifecycle: submit once,
 * then report either working, final, or failed when polled.
 */
import type { OutputSource } from "./output-reader.js";

export type AgentStatus =
  | { state: "working"; preview?: string }
  | { state: "blocked"; question?: string }
  | { state: "final"; text: string; source: OutputSource }
  | { state: "failed"; reason: string };

export interface AgentWrapper {
  submit(prompt: string): Promise<void>;
  status(): Promise<AgentStatus>;
}
