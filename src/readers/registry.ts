import type { AgentOutputReader, AgentReaderRequest } from "./types.js";
import { stripStatusBar } from "../output-format.js";

class ScrapeReader implements AgentOutputReader {
  readonly kind = "scrape";
  constructor(
    private readonly paneId: string,
    private readonly readPane: (paneId: string, lines: number) => string,
  ) {}

  read(maxLines: number): string {
    try {
      return stripStatusBar(this.readPane(this.paneId, maxLines));
    } catch {
      return "";
    }
  }
}

export function createAgentOutputReader(req: AgentReaderRequest): AgentOutputReader {
  return new ScrapeReader(req.paneId, req.readPane);
}
