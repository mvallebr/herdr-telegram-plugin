import type { AgentSessionRef, SqliteDriver, OpenCodeReadOptions } from "../agent-sessions.js";
import type { Logger } from "../logger.js";

export interface AgentOutputReader {
  readonly kind: string;
  read(maxLines: number): string;
}

export interface AgentReaderRequest {
  paneId: string;
  agentName: string;
  session: AgentSessionRef;
  readPane: (paneId: string, lines: number) => string;
  agentPaths?: Record<string, Record<string, string>>;
  opencodeReadOptions?: OpenCodeReadOptions;
  sqliteDriver?: SqliteDriver;
  logger: Logger;
}
