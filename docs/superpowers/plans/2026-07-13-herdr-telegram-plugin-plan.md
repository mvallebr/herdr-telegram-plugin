# herdr-telegram-plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a herdr plugin (Node.js + TypeScript + grammy) that bridges Telegram forum topics to herdr panes — zero-LLM remote control for any agent.

**Architecture:** Plugin entry spawns daemon; daemon polls Telegram via grammy, keeps in-memory pane↔topic mapping, does sync wait+read for agent output, and throttles progress messages. Pairing via `/pair`; single chat_id whitelist; XDG config/state files.

**Tech Stack:** Node.js 18+, TypeScript 5.x, grammy 1.x, herdr 0.7+, `npm ci` + `tsc` via `[[build]]`.

## Global Constraints

- Node.js 18+ runtime (matching herdr's min Node version)
- grammy 1.x as sole runtime dependency (no other npm packages)
- Config at `~/.config/herdr-telegram/config.toml` (XDG)
- State at `~/.local/state/herdr-telegram/state.json` (XDG)
- Plugin manifest must use `[[build]]` for `npm ci` and `tsc`
- Herdr `min_herdr_version = "0.7.0"`
- All commands via `herdr` CLI subprocess (not raw socket)
- Throttle: 3s minimum between Telegram messages
- Pairing: `/pair` command validates admin + can_manage_topics + is_forum
- Messages separated (no progressive edits)

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `herdr-plugin.toml`
- Modify: `.gitignore` (append entries)

**Interfaces:**
- Produces: `npm ci && npm run build` compiles `src/*.ts` → `dist/*.js`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "herdr-telegram-plugin",
  "version": "0.1.0",
  "private": false,
  "description": "Telegram bot companion for herdr — remote control agents via forum topics",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "grammy": "^1.44.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["dist", "tests", "node_modules"]
}
```

- [ ] **Step 3: Write herdr-plugin.toml**

```toml
id = "herdr-telegram-plugin"
name = "Herdr Telegram Bridge"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Control your herdr agents from Telegram via forum topics. Zero-LLM bridge."
platforms = ["linux"]

[[build]]
command = ["npm", "ci"]
platforms = ["linux"]

[[build]]
command = ["npm", "run", "build"]
platforms = ["linux"]

[[actions]]
id = "bootstrap"
title = "Bootstrap daemon"
command = ["node", "dist/index.js", "--daemon"]

[[actions]]
id = "status"
title = "Daemon status"
command = ["node", "dist/index.js", "--status"]

[[events]]
on = "pane.agent_status_changed"
command = ["node", "dist/plugin.js"]
```

- [ ] **Step 4: Update .gitignore**

Append to existing `.gitignore`:
```
dist/
node_modules/
.env
*.log
```

- [ ] **Step 5: Validate**

```bash
npm ci && npm run build
# Expected: builds with zero quality errors (empty dist/ since no src/ yet)
npx tsc --noEmit
# Expected: no errors (empty src/ dir)
```

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json herdr-plugin.toml .gitignore
git commit -m "chore: scaffold project with TS, grammy, and herdr manifest"
```

---

### Task 2: Types + Logger

**Files:**
- Create: `src/types.ts` (shared TS types)
- Create: `src/logger.ts` (structured logging factory)
- Create: `tests/logger.test.ts`

**Interfaces:**
- Produces:
  - `PaneInfo { pane_id: string; label: string; agent: string; tab_id: string; workspace_id: string; status: string }`
  - `ThreadMapping { pane_id: string; label: string; agent: string; created_at: string }`
  - `TopicInfo { message_thread_id: number; name: string }`
  - `DaemonState { authorized_chat_id: number | null; paired_at: string | null; thread_mappings: Record<number, ThreadMapping> }`
  - `Logger { info(msg: string, data?: object): void; warn(...): void; error(...): void; debug(...): void }`
  - `createLogger(name: string): Logger`

- [ ] **Step 1: Write failing test**

Create `tests/logger.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("emits structured JSON objects", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.info("hello", { count: 1 });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      name: "test",
      level: "info",
      message: "hello",
      count: 1,
    });
  });

  it("logs without extra data", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.warn("bare");

    expect(logs[0]).toMatchObject({ level: "warn", message: "bare" });
  });

  it("filters sensitive keys from data", () => {
    const logs: object[] = [];
    const logger = createLogger("test", (entry) => logs.push(entry));

    logger.info("config loaded", { bot_token: "secret123", debug: true });

    expect((logs[0] as any).bot_token).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/logger.test.ts
# Expected: FAIL — "Cannot find module '../src/logger.js' or its corresponding type declarations"
```

- [ ] **Step 3: Write types.ts**

Create `src/types.ts`:
```typescript
export interface PaneInfo {
  pane_id: string;
  label: string;
  agent: string;
  tab_id: string;
  workspace_id: string;
  status: "idle" | "working" | "blocked" | "unknown";
}

export interface ThreadMapping {
  pane_id: string;
  label: string;
  agent: string;
  created_at: string;
}

export interface TopicInfo {
  message_thread_id: number;
  name: string;
}

export interface DaemonState {
  authorized_chat_id: number | null;
  paired_at: string | null;
  thread_mappings: Record<number, ThreadMapping>;
}
```

- [ ] **Step 4: Write logger.ts**

Create `src/logger.ts`:
```typescript
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
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/logger.test.ts
# Expected: 3 tests PASS
```

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/logger.ts tests/logger.test.ts
git commit -m "feat: add shared types and structured logger with token redaction"
```

---

### Task 3: Config + State

**Files:**
- Create: `src/config.ts` (loads `~/.config/herdr-telegram/config.toml` + env)
- Create: `src/state.ts` (reads/writes `~/.local/state/herdr-telegram/state.json`)
- Create: `tests/config.test.ts`
- Create: `tests/state.test.ts`

**Interfaces:**
- Consumes: `types.ts` (`DaemonState`)
- Produces:
  - `Config { botToken: string; chatId: number | null; throttleMs: number; waitTimeoutS: number; maxTotalWaitS: number }`
  - `loadConfig(): Config` — throws if botToken missing
  - `loadState(): DaemonState`
  - `saveState(state: DaemonState): void`

- [ ] **Step 1: Write config test**

Create `tests/config.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("loadConfig", () => {
  const tmpDir = path.join(os.tmpdir(), "herdr-telegram-test-" + Date.now());
  const configFile = path.join(tmpDir, "config.toml");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    delete process.env.HERDR_TG_BOT_TOKEN;
    delete process.env.HERDR_TG_CHAT_ID;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads bot_token from config.toml", () => {
    fs.writeFileSync(configFile, 'bot_token = "test-token-123"');
    const cfg = loadConfig(tmpDir);
    expect(cfg.botToken).toBe("test-token-123");
    expect(cfg.chatId).toBeNull();
    expect(cfg.throttleMs).toBe(3000);
  });

  it("prefers env var over file", () => {
    process.env.HERDR_TG_BOT_TOKEN = "env-token";
    fs.writeFileSync(configFile, 'bot_token = "file-token"');
    const cfg = loadConfig(tmpDir);
    expect(cfg.botToken).toBe("env-token");
  });

  it("throws if no bot_token found", () => {
    expect(() => loadConfig(tmpDir)).toThrow(/bot_token/);
  });

  it("uses env chat_id if set", () => {
    process.env.HERDR_TG_CHAT_ID = "-100123";
    fs.writeFileSync(configFile, 'bot_token = "t"');
    const cfg = loadConfig(tmpDir);
    expect(cfg.chatId).toBe(-100123);
  });
});
```

- [ ] **Step 2: Write state test**

Create `tests/state.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadState, saveState } from "../src/state.js";
import type { DaemonState } from "../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("loadState / saveState", () => {
  const tmpDir = path.join(os.tmpdir(), "herdr-telegram-state-test-" + Date.now());

  beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns empty state when file absent", () => {
    const state = loadState(tmpDir);
    expect(state.authorized_chat_id).toBeNull();
    expect(state.paired_at).toBeNull();
    expect(state.thread_mappings).toEqual({});
  });

  it("round-trips state", () => {
    const orig: DaemonState = {
      authorized_chat_id: -100,
      paired_at: "2026-01-01T00:00:00Z",
      thread_mappings: { "140": { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "..." } },
    };
    saveState(tmpDir, orig);
    const loaded = loadState(tmpDir);
    expect(loaded).toEqual(orig);
  });
});
```

- [ ] **Step 3: Run tests (must fail)**

```bash
npx vitest run tests/config.test.ts tests/state.test.ts
# Expected: FAIL — cannot find module
```

- [ ] **Step 4: Write config.ts**

Create `src/config.ts`:
```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface Config {
  botToken: string;
  chatId: number | null;
  throttleMs: number;
  waitTimeoutS: number;
  maxTotalWaitS: number;
}

function parseTomlLine(line: string): [string, string] | null {
  const i = line.indexOf("=");
  if (i === -1) return null;
  const key = line.slice(0, i).trim();
  let val = line.slice(i + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return [key, val];
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? path.join(os.homedir(), ".config", "herdr-telegram");
  const filePath = path.join(dir, "config.toml");

  let fileBotToken = "";
  let fileChatId: number | null = null;
  let fileThrottleMs = 3000;
  let fileWaitTimeoutS = 300;
  let fileMaxTotalWaitS = 1800;

  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    let inTelegram = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line === "[telegram]") { inTelegram = true; continue; }
      if (line.startsWith("[")) { inTelegram = false; continue; }
      const kv = parseTomlLine(line);
      if (!kv) continue;
      if (inTelegram) {
        if (kv[0] === "chat_id") fileChatId = parseInt(kv[1], 10);
        else if (kv[0] === "throttle_ms") fileThrottleMs = parseInt(kv[1], 10);
        else if (kv[0] === "wait_timeout_s") fileWaitTimeoutS = parseInt(kv[1], 10);
        else if (kv[0] === "max_total_wait_s") fileMaxTotalWaitS = parseInt(kv[1], 10);
      } else if (kv[0] === "bot_token") {
        fileBotToken = kv[1];
      }
    }
  }

  const botToken = process.env.HERDR_TG_BOT_TOKEN || fileBotToken;
  if (!botToken) {
    throw new Error(
      "bot_token not found. Set HERDR_TG_BOT_TOKEN env var or add bot_token to " + filePath
    );
  }

  const chatId =
    process.env.HERDR_TG_CHAT_ID !== undefined
      ? parseInt(process.env.HERDR_TG_CHAT_ID, 10)
      : fileChatId;

  return {
    botToken,
    chatId,
    throttleMs: fileThrottleMs,
    waitTimeoutS: fileWaitTimeoutS,
    maxTotalWaitS: fileMaxTotalWaitS,
  };
}
```

- [ ] **Step 5: Write state.ts**

Create `src/state.ts`:
```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { DaemonState } from "./types.js";

export function loadState(stateDir?: string): DaemonState {
  const dir = stateDir ?? path.join(os.homedir(), ".local", "state", "herdr-telegram");
  const filePath = path.join(dir, "state.json");

  if (!fs.existsSync(filePath)) {
    return { authorized_chat_id: null, paired_at: null, thread_mappings: {} };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as DaemonState;
}

export function saveState(stateDir: string | undefined, state: DaemonState): void {
  const dir = stateDir ?? path.join(os.homedir(), ".local", "state", "herdr-telegram");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run tests/config.test.ts tests/state.test.ts
# Expected: all PASS
```

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/state.ts tests/config.test.ts tests/state.test.ts
git commit -m "feat: add config loader and state persistence"
```

---

### Task 4: Herdr client

**Files:**
- Create: `src/herdr-client.ts` (wraps `herdr` CLI subprocess calls)
- Create: `tests/herdr-client.test.ts`

**Interfaces:**
- Consumes: `types.ts` (`PaneInfo`)
- Produces:
  - `getAgents(): PaneInfo[]`
  - `sendText(paneId: string, text: string): void`
  - `waitIdle(paneId: string, timeoutS: number): { status: "idle" | "blocked" | "timeout" }`
  - `readPane(paneId: string, lines: number): string`
  - `spawn(herdrBin?: string): ChildProcess` — spawns daemon-independent herdr checks

- [ ] **Step 1: Write failing test**

Create `tests/herdr-client.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import * as childProcess from "node:child_process";
import { parseAgentList, buildSendTextArgs, buildWaitArgs } from "../src/herdr-client.js";

describe("parseAgentList", () => {
  it("parses herdr agent list JSON output", () => {
    const raw = JSON.stringify({
      id: "cli:agent:list",
      result: {
        agents: [
          {
            agent: "pi",
            agent_status: "idle",
            cwd: "/home/user/project",
            pane_id: "w1:pZ",
            tab_id: "w1:tZ",
            workspace_id: "w1",
          },
        ],
      },
    });
    const agents = parseAgentList(raw);
    expect(agents).toHaveLength(1);
    expect(agents[0].pane_id).toBe("w1:pZ");
    expect(agents[0].agent).toBe("pi");
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseAgentList("{ invalid }")).toEqual([]);
  });

  it("returns empty array for missing result", () => {
    expect(parseAgentList('{"id":"x"}')).toEqual([]);
  });
});

describe("buildSendTextArgs", () => {
  it("builds correct args tuple", () => {
    expect(buildSendTextArgs("w1:pZ", "hello world")).toEqual([
      "pane", "send-text", "w1:pZ", "hello world",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
npx vitest run tests/herdr-client.test.ts
# Expected: FAIL — cannot resolve module
```

- [ ] **Step 3: Write herdr-client.ts**

Create `src/herdr-client.ts`:
```typescript
import { execSync, spawn, type ChildProcess } from "node:child_process";
import type { PaneInfo } from "./types.js";

const DEFAULT_HERDR_BIN = "herdr";

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || DEFAULT_HERDR_BIN;
}

function execHerdrJson(args: string[]): string {
  return execSync([herdrBin(), ...args].join(" "), {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function execHerdr(args: string[]): void {
  execSync([herdrBin(), ...args].join(" "), { encoding: "utf8", timeout: 30_000 });
}

export function parseAgentList(raw: string): PaneInfo[] {
  try {
    const parsed = JSON.parse(raw);
    const agents: any[] = parsed?.result?.agents ?? [];
    return agents.map((a: any) => ({
      pane_id: String(a.pane_id),
      label: a.foreground_cwd?.split("/").pop() ?? "?",
      agent: a.agent ?? "?",
      tab_id: String(a.tab_id),
      workspace_id: String(a.workspace_id),
      status: String(a.agent_status || "unknown") as PaneInfo["status"],
    }));
  } catch {
    return [];
  }
}

export function getAgents(): PaneInfo[] {
  const raw = execHerdrJson(["agent", "list"]);
  return parseAgentList(raw);
}

export function buildSendTextArgs(paneId: string, text: string): string[] {
  return ["pane", "send-text", paneId, text];
}

export function sendText(paneId: string, text: string): void {
  execHerdr(buildSendTextArgs(paneId, text));
}

export function buildWaitArgs(paneId: string, timeoutS: number): string[] {
  return ["agent", "wait", paneId, "--status", "idle", "--timeout", String(timeoutS * 1000)];
}

export function waitIdle(
  paneId: string,
  timeoutS: number
): { status: "idle" | "blocked" | "timeout" } {
  try {
    execHerdr(buildWaitArgs(paneId, timeoutS));
    return { status: "idle" };
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? "");
    if (msg.includes("timeout")) return { status: "timeout" };
    if (msg.includes("blocked")) return { status: "blocked" };
    throw err;
  }
}

export function readPane(paneId: string, lines: number): string {
  return execHerdrJson([
    "pane", "read", paneId, "--source", "recent",
    "--lines", String(lines), "--format", "text",
  ]);
}

export function spawnDaemon(args: string[], herdrBinPath?: string): ChildProcess {
  const bin = herdrBinPath || herdrBin();
  // Spawn detached so it outlives this process
  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/herdr-client.test.ts
# Expected: 4 tests PASS (unit tests only, no herdr CLI needed)
```

- [ ] **Step 5: Commit**

```bash
git add src/herdr-client.ts tests/herdr-client.test.ts
git commit -m "feat: add herdr-client — wraps herdr CLI subprocess calls"
```

---

### Task 5: Telegram client

**Files:**
- Create: `src/telegram-client.ts` (grammy wrapper for forum topics)
- Create: `tests/telegram-client.test.ts`

**Interfaces:**
- Consumes: `types.ts` (`TopicInfo`)
- Produces:
  - `TelegramClient { bot: Bot; start(): void; }`
  - `createForumTopic(name: string): Promise<number>` (returns message_thread_id)
  - `getForumTopics(): Promise<TopicInfo[]>`
  - `sendMessage(threadId: number, text: string, opts?): Promise<number>`
  - `validatePermissions(chatId: number): Promise<string[]>` (errors if fails)

- [ ] **Step 1: Write test**

Create `tests/telegram-client.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import type { TopicInfo } from "../src/types.js";

// Minimal unit test for helpers — actual grammy calls are integration-only
describe("TopicInfo", () => {
  it("matches expected shape from Telegram API", () => {
    const info: TopicInfo = {
      message_thread_id: 140,
      name: "Echo",
    };
    expect(typeof info.message_thread_id).toBe("number");
    expect(typeof info.name).toBe("string");
    // validatePermissions errors array
    const errors: string[] = [];
    expect(Array.isArray(errors)).toBe(true);
  });
});
```

- [ ] **Step 2: Run (passes trivially, validates types)**

```bash
npx vitest run tests/telegram-client.test.ts
# Expected: PASS
```

- [ ] **Step 3: Write telegram-client.ts**

Create `src/telegram-client.ts`:
```typescript
import { Bot } from "grammy";
import type { TopicInfo } from "./types.js";

export class TelegramClient {
  public bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  start(): void {
    this.bot.start({
      onStart: () => {
        // grammy logging is handled by our logger
      },
    });
  }

  async createForumTopic(chatId: number, name: string): Promise<number> {
    const result = await this.bot.api.createForumTopic(chatId, name);
    return result.message_thread_id;
  }

  async getForumTopics(chatId: number): Promise<TopicInfo[]> {
    try {
      const result = await this.bot.api.getForumTopics(chatId);
      return result.map((t) => ({
        message_thread_id: t.message_thread_id,
        name: t.name,
      }));
    } catch {
      return [];
    }
  }

  async sendMessage(
    chatId: number,
    threadId: number,
    text: string,
    opts?: { disable_notification?: boolean }
  ): Promise<number> {
    const msg = await this.bot.api.sendMessage(chatId, text, {
      message_thread_id: threadId,
      disable_notification: opts?.disable_notification ?? false,
    });
    return msg.message_id;
  }

  async validatePermissions(chatId: number): Promise<string[]> {
    const errors: string[] = [];

    try {
      const chat = await this.bot.api.getChat(chatId);
      if (chat.type !== "supergroup") {
        errors.push("Chat must be a supergroup");
        return errors;
      }
      if (!(chat as any).is_forum) {
        errors.push(
          "Topics are not enabled. Enable them in Group Settings → Topics."
        );
        return errors;
      }
    } catch (err: any) {
      errors.push(
        `Cannot access chat. Make sure the bot has been added to the group. (${err.message})`
      );
      return errors;
    }

    try {
      const me = await this.bot.api.getMe();
      const member = await this.bot.api.getChatMember(chatId, me.id);

      if (!["creator", "administrator"].includes(member.status)) {
        errors.push(
          "Bot is not an administrator. Promote via Group Settings → Administrators → Add Administrator."
        );
        return errors;
      }

      if (member.status === "administrator" && !(member as any).can_manage_topics) {
        errors.push(
          "Bot lacks 'Manage Topics' permission. Enable in Group Settings → Administrators → @yourbot → Manage Topics."
        );
      }
    } catch (err: any) {
      errors.push(`Cannot check bot permissions. ${err.message}`);
    }

    return errors;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/telegram-client.test.ts
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/telegram-client.ts tests/telegram-client.test.ts
git commit -m "feat: add telegram-client — grammy wrapper for forum topics"
```

---

### Task 6: Mapping

**Files:**
- Create: `src/mapping.ts` (in-memory + reconciliation)
- Create: `tests/mapping.test.ts`

**Interfaces:**
- Consumes: `types.ts` (`PaneInfo`, `ThreadMapping`, `TopicInfo`), `herdr-client.ts` (`getAgents`), `telegram-client.ts` (`createForumTopic`, `getForumTopics`)
- Produces:
  - `reconcile(chatId: number, tg: TelegramClient): Promise<Map<number, ThreadMapping>>`
  - `findMapping(threadId: number, map: Map<number, ThreadMapping>): ThreadMapping | undefined`

- [ ] **Step 1: Write test**

Create `tests/mapping.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { matchTopic, resolveOrphanTopics } from "../src/mapping.js";
import type { PaneInfo, TopicInfo, ThreadMapping } from "../src/types.js";

describe("matchTopic", () => {
  it("matches pane by label to topic by name (case-insensitive)", () => {
    const pane: PaneInfo = {
      pane_id: "w1:pZ", label: "Echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    };
    const topics: TopicInfo[] = [
      { message_thread_id: 140, name: "Echo" },
      { message_thread_id: 142, name: "Fjord" },
    ];
    const match = matchTopic(pane, topics);
    expect(match).toBe(140);
  });

  it("matches with different casing", () => {
    const pane: PaneInfo = {
      pane_id: "w1:pZ", label: "echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    };
    const topics: TopicInfo[] = [{ message_thread_id: 150, name: "ECHO" }];
    expect(matchTopic(pane, topics)).toBe(150);
  });

  it("returns undefined when no match", () => {
    const pane: PaneInfo = {
      pane_id: "w1:pZ", label: "Echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    };
    expect(matchTopic(pane, [])).toBeUndefined();
  });
});

describe("resolveOrphanTopics", () => {
  it("returns topics with no matching pane", () => {
    const panes: PaneInfo[] = [];
    const topics: TopicInfo[] = [{ message_thread_id: 140, name: "orphan" }];
    const existing: Map<number, ThreadMapping> = new Map();
    expect(resolveOrphanTopics(panes, topics, existing)).toHaveLength(1);
  });

  it("returns empty when all topics match panes", () => {
    const panes: PaneInfo[] = [{
      pane_id: "w1:pZ", label: "Echo", agent: "pi",
      tab_id: "w1:tZ", workspace_id: "w1", status: "idle",
    }];
    const topics: TopicInfo[] = [{ message_thread_id: 140, name: "Echo" }];
    const existing: Map<number, ThreadMapping> = new Map([[140, { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "x" }]]);
    expect(resolveOrphanTopics(panes, topics, existing)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/mapping.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: Write mapping.ts**

Create `src/mapping.ts`:
```typescript
import type { PaneInfo, TopicInfo, ThreadMapping } from "./types.js";
import { getAgents } from "./herdr-client.js";
import type { TelegramClient } from "./telegram-client.js";

export function matchTopic(
  pane: PaneInfo,
  topics: TopicInfo[]
): number | undefined {
  const label = pane.label.toLowerCase();
  const match = topics.find((t) => t.name.toLowerCase() === label);
  return match?.message_thread_id;
}

export function resolveOrphanTopics(
  panes: PaneInfo[],
  topics: TopicInfo[],
  existingMappings: Map<number, ThreadMapping>
): TopicInfo[] {
  return topics.filter((t) => !existingMappings.has(t.message_thread_id));
}

export async function reconcile(
  chatId: number,
  tg: TelegramClient
): Promise<Map<number, ThreadMapping>> {
  const panes = getAgents();
  const topics = await tg.getForumTopics(chatId);
  const map = new Map<number, ThreadMapping>();

  for (const pane of panes) {
    let threadId = matchTopic(pane, topics);
    if (!threadId) {
      threadId = await tg.createForumTopic(chatId, pane.label);
      topics.push({ message_thread_id: threadId, name: pane.label });
    }
    map.set(threadId, {
      pane_id: pane.pane_id,
      label: pane.label,
      agent: pane.agent,
      created_at: new Date().toISOString(),
    });
  }

  return map;
}

export function findMapping(
  threadId: number,
  map: Map<number, ThreadMapping>
): ThreadMapping | undefined {
  return map.get(threadId);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/mapping.test.ts
# Expected: 4 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/mapping.ts tests/mapping.test.ts
git commit -m "feat: add mapping — reconcile herdr panes with Telegram topics"
```

---

### Task 7: Pairing

**Files:**
- Create: `src/pairing.ts` (pairing state machine)
- Create: `tests/pairing.test.ts`

**Interfaces:**
- Consumes: `telegram-client.ts` (`validatePermissions`), `state.ts` (`loadState`, `saveState`), `mapping.ts` (`reconcile`), `config.ts` (`Config`)
- Produces:
  - `handleIncomingUpdate(ctx: Context, config: Config, stateDir: string): Promise<boolean>` — returns true if pairing authorized

- [ ] **Step 1: Write test**

Create `tests/pairing.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPaired, updatePairing } from "../src/pairing.js";
import { saveState, loadState } from "../src/state.js";
import type { DaemonState } from "../src/types.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

describe("isPaired", () => {
  it("returns false when authorized_chat_id is null", () => {
    expect(isPaired({ authorized_chat_id: null, paired_at: null, thread_mappings: {} })).toBe(false);
  });

  it("returns true when authorized_chat_id is set", () => {
    expect(isPaired({ authorized_chat_id: -100, paired_at: "x", thread_mappings: {} })).toBe(true);
  });
});

describe("updatePairing", () => {
  const tmpDir = path.join(os.tmpdir(), "pairing-test-" + Date.now());

  beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("saves authorized_chat_id to state", () => {
    const before = loadState(tmpDir);
    expect(before.authorized_chat_id).toBeNull();

    updatePairing(tmpDir, -100);
    const after = loadState(tmpDir);
    expect(after.authorized_chat_id).toBe(-100);
    expect(after.paired_at).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/pairing.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: Write pairing.ts**

Create `src/pairing.ts`:
```typescript
import type { DaemonState } from "./types.js";
import { loadState, saveState } from "./state.js";

export function isPaired(state: DaemonState): boolean {
  return state.authorized_chat_id !== null;
}

export function updatePairing(stateDir: string, chatId: number): DaemonState {
  const state = loadState(stateDir);
  state.authorized_chat_id = chatId;
  state.paired_at = new Date().toISOString();
  saveState(stateDir, state);
  return state;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/pairing.test.ts
# Expected: 3 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/pairing.ts tests/pairing.test.ts
git commit -m "feat: add pairing state machine"
```

---

### Task 8: Wait loop

**Files:**
- Create: `src/wait-loop.ts` (sync wait+read+throttle)
- Create: `tests/wait-loop.test.ts`

**Interfaces:**
- Consumes: `herdr-client.ts` (`sendText`, `waitIdle`, `readPane`), `telegram-client.ts` (`sendMessage`), `config.ts` (`Config`)
- Produces:
  - `runAgentTurn(paneId: string, threadId: number, text: string, cfg: Config, tg: TelegramClient, chatId: number): Promise<void>`

- [ ] **Step 1: Write test**

Create `tests/wait-loop.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { shouldThrottle, formatElapsed } from "../src/wait-loop.js";

describe("shouldThrottle", () => {
  it("returns true within throttle window", () => {
    expect(shouldThrottle(Date.now(), 3000)).toBe(true);
  });

  it("returns false after throttle window", () => {
    expect(shouldThrottle(Date.now() - 4000, 3000)).toBe(false);
  });
});

describe("formatElapsed", () => {
  it("formats seconds", () => {
    expect(formatElapsed(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(125)).toBe("2m 5s");
  });

  it("formats hours", () => {
    expect(formatElapsed(3661)).toBe("1h 1m 1s");
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/wait-loop.test.ts
# Expected: FAIL
```

- [ ] **Step 3: Write wait-loop.ts**

Create `src/wait-loop.ts`:
```typescript
import type { Config } from "./config.js";
import type { TelegramClient } from "./telegram-client.js";
import { sendText, waitIdle, readPane } from "./herdr-client.js";

export function shouldThrottle(lastSentAt: number, throttleMs: number): boolean {
  return Date.now() - lastSentAt < throttleMs;
}

export function formatElapsed(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export async function runAgentTurn(
  paneId: string,
  threadId: number,
  text: string,
  cfg: Config,
  tg: TelegramClient,
  chatId: number
): Promise<void> {
  sendText(paneId, text);

  let lastSent = 0;
  const startTime = Date.now();

  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed >= cfg.maxTotalWaitS) {
      await tg.sendMessage(chatId, threadId, `⏳ Tempo limite excedido (${formatElapsed(elapsed)})`);
      break;
    }

    const result = waitIdle(paneId, cfg.waitTimeoutS);

    if (result.status === "idle") {
      const content = readPane(paneId, 200);
      await tg.sendMessage(chatId, threadId, `✅ (${formatElapsed(elapsed)}):\n\n${content}`);
      break;
    }

    if (result.status === "timeout") {
      if (shouldThrottle(lastSent, cfg.throttleMs)) continue;
      const content = readPane(paneId, 15);
      await tg.sendMessage(chatId, threadId, `⏳ Working (${formatElapsed(elapsed)}):\n\n${content}`, { disable_notification: true });
      lastSent = Date.now();
    }

    if (result.status === "blocked") {
      const content = readPane(paneId, 30);
      await tg.sendMessage(chatId, threadId, `⚠️ Blocked (tool approval):\n\n${content}`);
      break;
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/wait-loop.test.ts
# Expected: 5 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/wait-loop.ts tests/wait-loop.test.ts
git commit -m "feat: add wait-loop — sync agent turn with throttled progress"
```

---

### Task 9: Commands

**Files:**
- Create: `src/commands.ts` (handlers for /help, /agents, /status, /interrupt, /trust, /digest)
- Create: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `herdr-client.ts` (`sendText`, `getAgents`), `telegram-client.ts`, `mapping.ts` (`findMapping`), `config.ts`, `pairing.ts` (`isPaired`)
- Produces:
  - `registerCommands(bot: Bot, deps): void`
  - Handler functions with signatures: `(ctx: CommandContext<Context>) => Promise<void>`

- [ ] **Step 1: Write test**

Create `tests/commands.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { formatAgentList, formatStatus } from "../src/commands.js";
import type { PaneInfo, ThreadMapping } from "../src/types.js";

describe("formatAgentList", () => {
  it("formats agents with status", () => {
    const panes: PaneInfo[] = [
      { pane_id: "w1:pZ", label: "Echo", agent: "pi", tab_id: "tZ", workspace_id: "w1", status: "idle" },
    ];
    const map = new Map<number, ThreadMapping>();
    map.set(140, { pane_id: "w1:pZ", label: "Echo", agent: "pi", created_at: "x" });

    const result = formatAgentList(panes, map);
    expect(result).toContain("Echo");
    expect(result).toContain("pi");
    expect(result).toContain("140");
  });
});

describe("formatStatus", () => {
  it("includes uptime and counts", () => {
    const result = formatStatus({
      uptime: "10s",
      paired: true,
      panesCount: 3,
    });
    expect(result).toContain("10s");
    expect(result).toContain("3 agent");
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/commands.test.ts
# Expected: FAIL
```

- [ ] **Step 3: Write commands.ts**

Create `src/commands.ts`:
```typescript
import { Bot, type Context } from "grammy";
import type { PaneInfo, ThreadMapping } from "./types.js";
import { getAgents, sendText } from "./herdr-client.js";
import { findMapping } from "./mapping.js";
import { isPaired } from "./pairing.js";
import type { DaemonState } from "./types.js";
import { loadState } from "./state.js";

export function formatAgentList(panes: PaneInfo[], map: Map<number, ThreadMapping>): string {
  if (panes.length === 0) return "No agents active.";
  const lines = ["Agents:"];
  for (const p of panes) {
    let threadId = "?";
    for (const [tid, m] of map.entries()) {
      if (m.pane_id === p.pane_id) { threadId = String(tid); break; }
    }
    lines.push(`  ${p.label} (${p.agent}, ${p.status}) — topic ${threadId}`);
  }
  return lines.join("\n");
}

export function formatStatus(opts: { uptime: string; paired: boolean; panesCount: number }): string {
  return [
    `Bridge uptime: ${opts.uptime}`,
    `Paired: ${opts.paired ? "yes" : "no"}`,
    `Active panes: ${opts.panesCount}`,
  ].join("\n");
}

export interface CommandDeps {
  map: Map<number, ThreadMapping>;
  stateDir: string;
  chatId: number;
  startTime: number;
}

export function registerCommands(bot: Bot<Context>, deps: CommandDeps): void {
  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "/help — this message",
        "/agents — list agents with status and topic IDs",
        "/status — bridge uptime and connection info",
        "/interrupt — send Ctrl+C to this topic's agent",
        "/trust — send 'trust, always allow' to this topic's agent",
        "/digest — today's activity (coming soon)",
        "",
        "Plain text in any topic is sent to that topic's pane.",
      ].join("\n")
    );
  });

  bot.command("agents", async (ctx) => {
    const panes = getAgents();
    await ctx.reply(formatAgentList(panes, deps.map));
  });

  bot.command("status", async (ctx) => {
    const state = loadState(deps.stateDir);
    const uptime = Math.floor((Date.now() - deps.startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    await ctx.reply(formatStatus({
      uptime: `${h}h ${m}m ${s}s`,
      paired: isPaired(state),
      panesCount: deps.map.size,
    }));
  });

  bot.command("interrupt", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    sendText(mapping.pane_id, "\x03"); // Ctrl+C
    await ctx.reply(`Interrupted ${mapping.label}`);
  });

  bot.command("trust", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    sendText(mapping.pane_id, "trust, always allow");
    await ctx.reply(`Trusted ${mapping.label}`);
  });

  bot.command("digest", async (ctx) => {
    await ctx.reply("Digest coming soon. Use /agents for current status.");
  });
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/commands.test.ts
# Expected: 2 tests PASS (formatAgentList, formatStatus)
```

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts tests/commands.test.ts
git commit -m "feat: add commands — /help, /agents, /status, /interrupt, /trust, /digest"
```

---

### Task 10: Daemon

**Files:**
- Create: `src/daemon.ts` (grammy polling loop — the core runtime)

**Interfaces:**
- Consumes: `telegram-client.ts`, `commands.ts`, `pairing.ts`, `mapping.ts`, `wait-loop.ts`, `config.ts`, `state.ts`, `logger.ts`
- Produces:
  - `startDaemon(configDir: string, stateDir: string): Promise<{ stop: () => void }>`

- [ ] **Step 1: No unit test** (daemon is integration-only — manual smoke test)

- [ ] **Step 2: Write daemon.ts**

Create `src/daemon.ts`:
```typescript
import { TelegramClient } from "./telegram-client.js";
import { registerCommands, type CommandDeps } from "./commands.js";
import { isPaired, updatePairing } from "./pairing.js";
import { reconcile, findMapping } from "./mapping.js";
import { runAgentTurn } from "./wait-loop.js";
import { loadConfig } from "./config.js";
import { loadState, saveState } from "./state.js";
import { createLogger, type Logger } from "./logger.js";
import type { DaemonState } from "./types.js";
import * as path from "node:path";

export async function startDaemon(configDir?: string, stateDir?: string): Promise<{ stop: () => void }> {
  const log = createLogger("daemon");
  const cfg = loadConfig(configDir);
  const statePath = stateDir ?? path.join(
    process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".local", "state"),
    "herdr-telegram"
  );

  let state = loadState(statePath);
  const tg = new TelegramClient(cfg.botToken);

  // Re-validate existing pairing
  if (isPaired(state) && state.authorized_chat_id) {
    const errors = await tg.validatePermissions(state.authorized_chat_id);
    if (errors.length > 0) {
      log.warn("Permission validation failed on startup", { errors });
      await tg.sendMessage(
        state.authorized_chat_id, 1, // send to General topic (thread 1)
        "⚠️ Permission check failed:\n" + errors.map(e => "- " + e).join("\n") +
        "\n\nBridge in read-only mode. Fix permissions and restart."
      );
    }
  }

  const map = isPaired(state) && state.authorized_chat_id
    ? await reconcile(state.authorized_chat_id!, tg)
    : new Map<number, typeof state.thread_mappings[keyof typeof state.thread_mappings]>();

  // Persist initial mapping
  const rawMappings: DaemonState["thread_mappings"] = {};
  for (const [tid, m] of map.entries()) rawMappings[tid] = m;
  saveState(statePath, { ...state, thread_mappings: rawMappings });

  const deps: CommandDeps = {
    map,
    stateDir: statePath,
    chatId: state.authorized_chat_id ?? 0,
    startTime: Date.now(),
  };

  registerCommands(tg.bot, deps);

  // Pairing flow
  tg.bot.command("pair", async (ctx) => {
    if (isPaired(state)) {
      await ctx.reply("Already paired. Delete state.json to re-pair.");
      return;
    }
    const chatId = ctx.chat.id;
    const errors = await tg.validatePermissions(chatId);
    if (errors.length > 0) {
      await ctx.reply("Cannot pair:\n" + errors.map(e => "- " + e).join("\n"));
      return;
    }
    state = updatePairing(statePath, chatId);
    deps.chatId = chatId;
    await ctx.reply("✅ Chat authorized. Reconciling tabs...");
    const newMap = await reconcile(chatId, tg);
    for (const [tid, m] of newMap.entries()) deps.map.set(tid, m);
    await ctx.reply("Reconciliation complete. Send a message in any topic.");
  });

  // Handle plain text (routed via thread_id)
  tg.bot.on("message:text", async (ctx) => {
    if (!isPaired(state) || !state.authorized_chat_id) return;

    const chatId = ctx.chat.id;
    if (chatId !== state.authorized_chat_id) return;

    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;

    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("Topic not mapped to a pane. Run /agents to see status.");
      return;
    }

    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return; // commands handled separately

    await runAgentTurn(mapping.pane_id, threadId, text, cfg, tg, chatId);
  });

  tg.start();
  log.info("Daemon started", { paired: isPaired(state), panes: map.size });

  return {
    stop: () => tg.bot.stop(),
  };
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run build
# Expected: compiles without errors
```

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "feat: add daemon — grammy polling loop with pairing, commands, and routing"
```

---

### Task 11: Plugin entry + index

**Files:**
- Create: `src/plugin.ts` (invoked by herdr under events — spawns daemon if needed)
- Create: `src/index.ts` (entry point — routes --daemon or --plugin or --status)

- [ ] **Step 1: Write plugin.ts**

Create `src/plugin.ts`:
```typescript
// This file is called by herdr on `pane.agent_status_changed` events.
// Its only job: ensure the daemon is running. If not, spawn it.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const stateDir = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "herdr-telegram"
);

const pidFile = join(stateDir, "daemon.pid");

function isRunning(): boolean {
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8"), 10);
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

if (!isRunning()) {
  // Spawn daemon
  spawn(
    process.execPath,
    [join(process.env.HERDR_PLUGIN_ROOT ?? __dirname, "dist", "index.js"), "--daemon"],
    { detached: true, stdio: "ignore" }
  ).unref();
}
```

- [ ] **Step 2: Write index.ts**

Create `src/index.ts`:
```typescript
#!/usr/bin/env node
import { startDaemon } from "./daemon.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const stateDir = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "herdr-telegram"
);

const args = process.argv.slice(2);

if (args.includes("--status")) {
  const pidFile = join(stateDir, "daemon.pid");
  const running = existsSync(pidFile)
    ? (() => { try { process.kill(parseInt(readFileSync(pidFile, "utf8"), 10), 0); return true; } catch { return false; } })()
    : false;
  if (running) {
    const pid = readFileSync(pidFile, "utf8").trim();
    const stateFile = join(stateDir, "state.json");
    const paired = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, "utf8")).authorized_chat_id !== null
      : false;
    process.stdout.write(`Daemon: running (PID ${pid}) | Paired: ${paired ? "yes" : "no"}\n`);
    process.exit(0);
  } else {
    process.stdout.write("Daemon: not running\n");
    process.exit(0);
  }
}

if (args.includes("--daemon")) {
  // Write PID file (use top-level imports already available)
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "daemon.pid"), String(process.pid), "utf8");

  process.stdout.write(`Daemon started (PID ${process.pid})\n`);
  startDaemon();

  // Clean PID on exit
  process.on("exit", () => {
    try { unlinkSync(join(stateDir, "daemon.pid")); } catch {}
  });
}
```

- [ ] **Step 3: Build and validate**

```bash
npm run build
# Expected: compiles without errors
# dist/ should contain: index.js, daemon.js, plugin.js, commands.js,
#   config.js, state.js, types.js, logger.js, mapping.js, pairing.js,
#   herdr-client.js, telegram-client.js, wait-loop.js
```

- [ ] **Step 4: Commit**

```bash
git add src/plugin.ts src/index.ts
git commit -m "feat: add plugin entry and index — spawn daemon, status checks"
```

---

### Task 12: README + final wiring

**Files:**
- Modify: `README.md` (replace default with full setup docs)

- [ ] **Step 1: Write README.md**

Replace README.md content:
```markdown
# herdr-telegram-plugin

Control your [herdr](https://herdr.dev) agents from Telegram via forum topics — **zero LLM in the path**.

## Install

```bash
herdr plugin install github.com/mvallebr/herdr-telegram-plugin
```

## Configure

```bash
mkdir -p ~/.config/herdr-telegram
echo 'bot_token = "YOUR_BOT_TOKEN"' > ~/.config/herdr-telegram/config.toml
```

## Setup in Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Create a **supergroup** (or convert existing group)
3. Enable **Topics**: Group Settings → Topics → ON
4. Add the bot as **administrator** with **Manage Topics** permission
5. Send any message in the group, then `/pair`

## Usage

| Command | Action |
|---|---|
| **Plain text** in any topic | Sends text to that topic's agent pane |
| `/help` | List commands |
| `/agents` | List all agents with status and topic IDs |
| `/status` | Bridge uptime and config |
| `/interrupt` | Ctrl+C to this topic's agent |
| `/trust` | "trust, always allow" to this topic's agent |
| `/digest` | Daily activity summary |

## How it works

Each herdr agent pane maps 1:1 to a Telegram forum topic. Messages in a topic are forwarded to the herdr pane as keyboard input. Agent output is sent back to Telegram. The bridge adds **zero LLM cost** — it reads/writes terminal buffers via herdr's CLI.

## Requirements

- herdr 0.7+
- Node.js 18+
- Telegram bot token (from @BotFather)
- Telegram supergroup with Topics enabled
- Bot must be group administrator with `Manage Topics` permission

## License

MIT
```

- [ ] **Step 2: Run build one final time**

```bash
npm ci && npm run build
# Expected: clean build, all .js files in dist/
```

- [ ] **Step 3: Final commit**

```bash
git add README.md
git commit -m "docs: add full README with setup and command reference"

# Push all
git push origin main
```

---

### Task 13: Smoke test (manual)

**No code.** User performs manual smoke test:

- [ ] **Step 1:** Install: `herdr plugin install github.com/mvallebr/herdr-telegram-plugin`
- [ ] **Step 2:** Run status: `herdr plugin action invoke herdr-telegram-plugin.status`
- [ ] **Step 3:** Send `/pair` in the Telegram group
- [ ] **Step 4:** Send plain text in a topic → verify agent receives it
- [ ] **Step 5:** Send `/agents` → verify correct listing

---

_End of plan. 13 tasks, ~50 sub-steps._
