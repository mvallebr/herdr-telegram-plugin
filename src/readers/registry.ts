import type { AgentOutputReader, AgentReaderRequest } from "./types.js";
import { stripStatusBar } from "../output-format.js";
import {
  OpenCodeDbReader,
  defaultSqliteDriver,
  findCodexSessionPath,
  getAgentDataPath,
  validateOpenCodeDb,
} from "../agent-sessions.js";
import { CodexJsonlReader, PiJsonlReader, validatePathSession } from "./jsonl.js";

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
  if (req.session?.kind === "path" && (req.agentName === "pi" || req.agentName === "omp")) {
    const reason = validatePathSession(req.session.path);
    if (reason) {
      req.logger.warn("structured source unavailable; falling back to scrape", {
        paneId: req.paneId,
        agent: req.agentName,
        reason,
      });
    } else {
      return new PiJsonlReader(req.session.path, req.logger, req.paneId, req.agentName);
    }
  }

  if (req.session?.kind === "path" && req.agentName === "codex") {
    const reason = validatePathSession(req.session.path);
    if (!reason) {
      return new CodexJsonlReader(req.session.path, req.logger, req.paneId);
    }
    req.logger.warn("structured source unavailable; falling back to scrape", {
      paneId: req.paneId,
      agent: req.agentName,
      reason,
    });
  }

  if (req.session?.kind === "id" && req.agentName === "codex") {
    const path = findCodexSessionPath(req.session.id);
    if (!path) {
      req.logger.warn("structured source unavailable; falling back to scrape", {
        paneId: req.paneId,
        agent: req.agentName,
        reason: `codex session not on disk: ${req.session.id}`,
      });
    } else {
      return new CodexJsonlReader(path, req.logger, req.paneId);
    }
  }

  if (req.session?.kind === "id" && req.agentName === "opencode") {
    const dbPath = getAgentDataPath("opencode", "db", req.agentPaths);
    const driver = req.sqliteDriver ?? defaultSqliteDriver;
    const reason = validateOpenCodeDb(dbPath, req.session.id, driver);
    if (!reason) {
      return new OpenCodeDbReader(
        dbPath!,
        req.session.id,
        driver,
        req.logger,
        req.paneId,
        req.opencodeReadOptions,
      );
    }
    req.logger.warn("structured source unavailable; falling back to scrape", {
      paneId: req.paneId,
      agent: req.agentName,
      reason,
    });
  }

  return new ScrapeReader(req.paneId, req.readPane);
}
