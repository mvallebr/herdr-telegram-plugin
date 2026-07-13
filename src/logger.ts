export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

type LogLevel = "info" | "warn" | "error" | "debug";

const SENSITIVE_KEYS = ["bot_token", "token", "chat_id", "password", "secret"];

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEYS.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export function createLogger(
  name: string,
  writeFn: (entry: Record<string, unknown>) => void = (e) => {
    process.stderr.write(JSON.stringify(e) + "\n");
  }
): Logger {
  function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    const entry: Record<string, unknown> = { name, level, message, timestamp: new Date().toISOString() };
    if (data) Object.assign(entry, redact(data));
    writeFn(entry);
  }
  return {
    info: (m, d) => log("info", m, d),
    warn: (m, d) => log("warn", m, d),
    error: (m, d) => log("error", m, d),
    debug: (m, d) => log("debug", m, d),
  };
}
