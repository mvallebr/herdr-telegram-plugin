import { existsSync, readFileSync, statSync } from "node:fs";
import type { AgentOutputReader } from "./types.js";
import type { Logger } from "../logger.js";

function extractTextFromContent(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      if ((c?.type === "text" || c?.type === "output_text" || c?.type === "input_text") && typeof c.text === "string") {
        return c.text;
      }
      return "";
    })
    .filter((s: string) => s.length > 0)
    .join("\n\n");
}

export function readPiCumulativeSnapshot(path: string): string {
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8");
  const chunks: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type !== "message") continue;
    const msg = ev.message;
    if (!msg || msg.role !== "assistant") continue;
    const text = extractTextFromContent(msg.content);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

export class PiJsonlReader implements AgentOutputReader {
  readonly kind = "pi-jsonl";
  constructor(
    private readonly path: string,
    private readonly logger: Logger,
    private readonly paneId: string,
    private readonly agentName: string,
  ) {}

  read(_maxLines: number): string {
    try {
      return readPiCumulativeSnapshot(this.path);
    } catch (err) {
      this.logger.warn("pi jsonl read failed", {
        paneId: this.paneId,
        agent: this.agentName,
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }
}

export function validatePathSession(path: string): string | null {
  if (!existsSync(path)) return `session path does not exist: ${path}`;
  try {
    const st = statSync(path);
    if (!st.isFile()) return `session path is not a regular file: ${path}`;
  } catch (err) {
    return `cannot stat session path: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}
