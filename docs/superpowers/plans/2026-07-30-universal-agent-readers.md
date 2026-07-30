# Universal Agent Output Readers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every agent through the same `AgentCommunicator` + cumulative `observe-loop` pipeline by introducing an `AgentOutputReader` factory/registry and cumulative readers for pi/omp/codex.

**Architecture:** `AgentCommunicator` depends only on `AgentOutputReader`. A dedicated factory knows all reader implementations, validates the structured source once, and returns a permanent reader. Structured readers return cumulative snapshots; `ScrapeReader` remains the terminal fallback.

**Tech Stack:** TypeScript ESM, Node 22, Vitest, `node:sqlite` for OpenCode, JSONL files for pi/omp/codex.

## Global Constraints

- All production Telegram output flows must remain routed through `AgentCommunicator` and `observe-loop`.
- Reader selection happens once at communicator initialization.
- Structured readers must never call `readPane`.
- Runtime structured read failures return `""`, never downgrade to scrape.
- User prompts are excluded from cumulative snapshots by default.
- Telegram chunking rules remain owned by `observe-loop`: max 3,000 chars per chunk including the Working suffix.
- CI runs on Node 22.

---

### Task 1: Extract `AgentOutputReader` interface and registry skeleton

**Files:**
- Create: `src/readers/types.ts`
- Create: `src/readers/registry.ts`
- Test: `tests/readers/registry.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `AgentOutputReader`
  - `AgentReaderRequest`
  - `createAgentOutputReader(req: AgentReaderRequest): AgentOutputReader`

- [ ] **Step 1: Write the failing test**

Create `tests/readers/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createAgentOutputReader } from "../../src/readers/registry.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("createAgentOutputReader — unknown agent", () => {
  it("returns a scrape reader when no structured source is known", () => {
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "agy",
      session: undefined,
      readPane: () => "scraped",
      logger,
    });
    expect(reader.kind).toBe("scrape");
    expect(reader.read(100)).toBe("scraped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/readers/registry.test.ts`
Expected: FAIL because `src/readers/registry.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/readers/types.ts`:

```ts
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
```

Create `src/readers/registry.ts`:

```ts
import type { AgentOutputReader, AgentReaderRequest } from "./types.js";

class ScrapeReader implements AgentOutputReader {
  readonly kind = "scrape";
  constructor(
    private readonly paneId: string,
    private readonly readPane: (paneId: string, lines: number) => string,
  ) {}

  read(maxLines: number): string {
    try {
      return this.readPane(this.paneId, maxLines);
    } catch {
      return "";
    }
  }
}

export function createAgentOutputReader(req: AgentReaderRequest): AgentOutputReader {
  return new ScrapeReader(req.paneId, req.readPane);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/readers/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/readers/types.ts src/readers/registry.ts tests/readers/registry.test.ts
git commit -m "refactor: add AgentOutputReader registry skeleton"
```

---

### Task 2: Move `ScrapeReader` into registry and preserve status stripping

**Files:**
- Modify: `src/readers/registry.ts`
- Test: `tests/readers/registry.test.ts`

**Interfaces:**
- Consumes: `stripStatusBar` from `src/output-format.ts`
- Produces: scrape reader behavior used by fallback paths

- [ ] **Step 1: Write the failing test**

Append to `tests/readers/registry.test.ts`:

```ts
describe("ScrapeReader", () => {
  it("strips terminal status bars at the scrape boundary", () => {
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "agy",
      session: undefined,
      readPane: () => "real output\nModel: something",
      logger,
    });
    expect(reader.read(100)).toBe("real output");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/readers/registry.test.ts`
Expected: FAIL because `ScrapeReader` does not apply `stripStatusBar`.

- [ ] **Step 3: Write minimal implementation**

In `src/readers/registry.ts`, import and use `stripStatusBar`:

```ts
import { stripStatusBar } from "../output-format.js";
```

Update `ScrapeReader.read`:

```ts
read(maxLines: number): string {
  try {
    return stripStatusBar(this.readPane(this.paneId, maxLines));
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/readers/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/readers/registry.ts tests/readers/registry.test.ts
git commit -m "refactor: move scrape reader into registry"
```

---

### Task 3: Implement cumulative pi/omp JSONL reader

**Files:**
- Create: `src/readers/jsonl.ts`
- Modify: `src/readers/registry.ts`
- Test: `tests/readers/jsonl.test.ts`

**Interfaces:**
- Consumes: `AgentOutputReader`, `AgentReaderRequest`
- Produces: `PiJsonlReader` selected for `pi`/`omp` path sessions

- [ ] **Step 1: Write the failing test**

Create `tests/readers/jsonl.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentOutputReader } from "../../src/readers/registry.js";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeRequest(path: string, agent = "pi") {
  return {
    paneId: "w1:p1",
    agentName: agent,
    session: { kind: "path", path } as const,
    readPane: () => "SHOULD NOT BE CALLED",
    logger,
  };
}

describe("PiJsonlReader cumulative output", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-reader-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("concatenates assistant messages chronologically and excludes user prompts", () => {
    const path = join(dir, "session.jsonl");
    const events = [
      { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "user one" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "second" }] } },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n"), "utf8");

    const reader = createAgentOutputReader(makeRequest(path));
    const out = reader.read(100);
    expect(reader.kind).toBe("pi-jsonl");
    expect(out).toBe("first\n\nsecond");
    expect(out).not.toContain("user one");
  });

  it("tolerates malformed lines", () => {
    const path = join(dir, "session.jsonl");
    const content = [
      "{bad json",
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    ].join("\n");
    writeFileSync(path, content, "utf8");

    const reader = createAgentOutputReader(makeRequest(path));
    expect(reader.read(100)).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/readers/jsonl.test.ts`
Expected: FAIL because registry returns scrape for path sessions.

- [ ] **Step 3: Write minimal implementation**

Create `src/readers/jsonl.ts`:

```ts
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
```

Update `src/readers/registry.ts`:

```ts
import { PiJsonlReader, validatePathSession } from "./jsonl.js";
```

Replace `createAgentOutputReader`:

```ts
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

  return new ScrapeReader(req.paneId, req.readPane);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/readers/jsonl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/readers/jsonl.ts src/readers/registry.ts tests/readers/jsonl.test.ts
git commit -m "feat: cumulative pi/omp JSONL reader"
```

---

### Task 4: Implement cumulative Codex JSONL reader

**Files:**
- Modify: `src/readers/jsonl.ts`
- Modify: `src/readers/registry.ts`
- Test: `tests/readers/jsonl.test.ts`

**Interfaces:**
- Consumes: `findCodexSessionPath` from `src/agent-sessions.ts`
- Produces: `CodexJsonlReader` selected for `codex` id/path sessions

- [ ] **Step 1: Write the failing test**

Append to `tests/readers/jsonl.test.ts`:

```ts
describe("CodexJsonlReader cumulative output", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-reader-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("concatenates assistant rollout messages and excludes user prompts", () => {
    const path = join(dir, "rollout.jsonl");
    const events = [
      { type: "response_item", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "user prompt" }] } },
      { type: "response_item", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "progress note" }] } },
      { type: "response_item", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "final answer" }] } },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n"), "utf8");

    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "codex",
      session: { kind: "path", path } as const,
      readPane: () => "SHOULD NOT BE CALLED",
      logger,
    });

    const out = reader.read(100);
    expect(reader.kind).toBe("codex-jsonl");
    expect(out).toBe("progress note\n\nfinal answer");
    expect(out).not.toContain("user prompt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/readers/jsonl.test.ts`
Expected: FAIL because codex path sessions are not selected.

- [ ] **Step 3: Write minimal implementation**

Add to `src/readers/jsonl.ts`:

```ts
export function readCodexCumulativeSnapshot(path: string): string {
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
    if (ev?.type !== "response_item" || ev?.payload?.type !== "message") continue;
    if (ev.payload.role !== "assistant") continue;
    const text = extractTextFromContent(ev.payload.content);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

export class CodexJsonlReader implements AgentOutputReader {
  readonly kind = "codex-jsonl";
  constructor(
    private readonly path: string,
    private readonly logger: Logger,
    private readonly paneId: string,
  ) {}

  read(_maxLines: number): string {
    try {
      return readCodexCumulativeSnapshot(this.path);
    } catch (err) {
      this.logger.warn("codex jsonl read failed", {
        paneId: this.paneId,
        agent: "codex",
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }
}
```

Update `src/readers/registry.ts`:

```ts
import { findCodexSessionPath } from "../agent-sessions.js";
import { CodexJsonlReader, PiJsonlReader, validatePathSession } from "./jsonl.js";
```

Add codex path support to `createAgentOutputReader`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/readers/jsonl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/readers/jsonl.ts src/readers/registry.ts tests/readers/jsonl.test.ts
git commit -m "feat: cumulative codex JSONL reader"
```

---

### Task 5: Move OpenCode reader selection into registry

**Files:**
- Modify: `src/readers/registry.ts`
- Test: `tests/readers/registry.test.ts`

**Interfaces:**
- Consumes:
  - `validateOpenCodeDb`
  - `OpenCodeDbReader`
  - `getAgentDataPath`
  - `defaultSqliteDriver`
- Produces: OpenCode selection owned by registry

- [ ] **Step 1: Write the failing test**

Append to `tests/readers/registry.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("OpenCode reader selection", () => {
  it("returns scrape with warning when opencode db is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-registry-"));
    const dbPath = join(dir, "missing.db");
    const warns: unknown[] = [];
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "opencode",
      session: { kind: "id", id: "ses_x" },
      readPane: () => "scraped",
      agentPaths: { opencode: { db: dbPath } },
      logger: { ...logger, warn: (m: string, d?: unknown) => warns.push({ m, d }) },
    });
    expect(reader.kind).toBe("scrape");
    expect(warns.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns opencode-db reader when db validates", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-registry-valid-"));
    const dbPath = join(dir, "opencode.db");
    const sessionId = "ses_abc";
    for (const sql of [
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)",
      `INSERT INTO message (id, session_id, time_created, data) VALUES ('m1', '${sessionId}', 1, '{"role":"assistant"}')`,
      `INSERT INTO part (id, message_id, time_created, data) VALUES ('p1', 'm1', 1, '{"type":"text","text":"hello"}')`,
    ]) {
      const r = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    }

    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "opencode",
      session: { kind: "id", id: sessionId },
      readPane: () => "SHOULD NOT BE CALLED",
      agentPaths: { opencode: { db: dbPath } },
      logger,
    });
    expect(reader.kind).toBe("opencode-db");
    expect(reader.read(100)).toContain("hello");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/readers/registry.test.ts`
Expected: FAIL because registry does not select OpenCode.

- [ ] **Step 3: Write minimal implementation**

Export `OpenCodeDbReader` from `src/agent-sessions.ts` if not already exported:

```ts
export class OpenCodeDbReader implements AgentOutputReader { ... }
```

Update `src/readers/registry.ts`:

```ts
import {
  OpenCodeDbReader,
  defaultSqliteDriver,
  getAgentDataPath,
  validateOpenCodeDb,
} from "../agent-sessions.js";
```

Add before generic scrape return:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/readers/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/readers/registry.ts src/agent-sessions.ts tests/readers/registry.test.ts
git commit -m "refactor: select opencode reader from registry"
```

---

### Task 6: Make `createAgentCommunicator` delegate to registry

**Files:**
- Modify: `src/agent-sessions.ts`
- Test: `tests/output-strategy.test.ts`

**Interfaces:**
- Consumes: `createAgentOutputReader`
- Produces: unchanged external `createAgentCommunicator` behavior

- [ ] **Step 1: Write the failing test**

Append to `tests/output-strategy.test.ts`:

```ts
import { createAgentOutputReader } from "../src/readers/registry.js";

describe("createAgentCommunicator delegates to registry", () => {
  it("uses registry-selected reader kind", () => {
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "agy",
        agent_session: undefined,
      }),
      readPane: () => "scrape-output",
    });
    expect(comm.readerKind).toBe("scrape");
    expect(comm.getAgentOutput(10)).toContain("scrape-output");
  });
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `npm test -- tests/output-strategy.test.ts`
Expected: PASS or FAIL depending on current scrape behavior; if PASS, still proceed to replace implementation and keep tests green.

- [ ] **Step 3: Replace factory internals**

In `src/agent-sessions.ts`, replace the body of `createAgentCommunicator` after `safeGetAgentInfo` with:

```ts
import { createAgentOutputReader } from "./readers/registry.js";

export function createAgentCommunicator(depsIn: AgentCommunicatorDeps): AgentCommunicator {
  const deps: AgentCommunicatorDeps = { ...depsIn };
  const log: Logger = deps.logger ?? fallbackLog;
  const info = safeGetAgentInfo(deps);
  const reader = createAgentOutputReader({
    paneId: deps.paneId,
    agentName: info?.agent ?? "?",
    session: info?.agent_session,
    readPane: deps.readPane,
    agentPaths: deps.agentPaths,
    opencodeReadOptions: deps.opencodeReadOptions,
    sqliteDriver: deps.sqliteDriver,
    logger: log,
  });
  return new AgentCommunicator(reader, log);
}
```

Remove the old inline selection branches from `createAgentCommunicator`.

- [ ] **Step 4: Run all output strategy tests**

Run: `npm test -- tests/output-strategy.test.ts tests/agent-sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-sessions.ts tests/output-strategy.test.ts
git commit -m "refactor: AgentCommunicator uses reader registry"
```

---

### Task 7: Remove legacy wrapper/output seams

**Files:**
- Delete: `src/agent-wrapper.ts`
- Delete: `src/agent-wrappers.ts`
- Delete: `src/output-reader.ts`
- Delete: `src/turn-coordinator.ts`
- Delete: `src/telegram-reporter.ts`
- Delete: `tests/agent-wrappers.test.ts`
- Delete: `tests/output-reader.test.ts`
- Delete: `tests/turn-coordinator.test.ts`
- Delete: `tests/telegram-reporter.test.ts`

**Interfaces:**
- Consumes: none
- Produces: repository without dead legacy seams

- [ ] **Step 1: Verify no active production import remains**

Run:

```bash
rg "from \"./(agent-wrapper|agent-wrappers|output-reader|turn-coordinator|telegram-reporter)" src
```

Expected: only matches inside the files being deleted, or no matches outside those files.

- [ ] **Step 2: Delete dead modules and their tests**

```bash
git rm src/agent-wrapper.ts src/agent-wrappers.ts src/output-reader.ts src/turn-coordinator.ts src/telegram-reporter.ts
git rm tests/agent-wrappers.test.ts tests/output-reader.test.ts tests/turn-coordinator.test.ts tests/telegram-reporter.test.ts
```

- [ ] **Step 3: Remove dead helper exports no longer used**

If `pickOutputStrategy`, `readAgentSessionProgress`, `readCodexSessionProgress`, or `readAgentSessionResponse` become unused outside tests, remove them and update tests. Keep `readPiSessionResponse`/`readCodexSessionResponse` only if still used by compatibility tests; otherwise remove.

Run:

```bash
npm run typecheck
```

Expected: no unresolved imports.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: remove legacy wrapper seams"
```

---

### Task 8: Add cumulative end-to-end observe-loop coverage for pi/codex

**Files:**
- Create: `tests/readers/observe-cumulative-agents.test.ts`

**Interfaces:**
- Consumes:
  - `createAgentCommunicator`
  - `runObserveLoop`
  - `PiJsonlReader` / `CodexJsonlReader` through temp JSONL files
- Produces: regression proof that non-OpenCode agents stream cumulative chunks

- [ ] **Step 1: Write the failing test**

Create `tests/readers/observe-cumulative-agents.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runObserveLoop } from "../../src/observe-loop.js";
import { createAgentCommunicator } from "../../src/agent-sessions.js";
import type { TelegramClient } from "../../src/telegram-client.js";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function drive(opts: any, sent: string[]) {
  const pending: Array<() => void> = [];
  opts.deps.sleep = () => new Promise<void>((resolve) => pending.push(resolve));
  const loop = runObserveLoop(opts);
  for (let i = 0; i < 20; i++) {
    while (pending.length === 0) await Promise.resolve();
    const next = pending.shift();
    if (!next) break;
    opts.deps.now = () => opts.deps.now() + 100;
    next();
    if (sent.some((s) => s.startsWith("[final]"))) break;
  }
  await loop;
}

describe("observe-loop with pi cumulative reader", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "observe-pi-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("streams only new assistant text as chunks", async () => {
    const path = join(dir, "session.jsonl");
    writeFileSync(path, JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "first" }] },
    }) + "\n", "utf8");

    const communicator = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({ agent: "pi", agent_session: { kind: "path", path } }),
      readPane: () => { throw new Error("readPane must not be used"); },
      logger,
    });

    const sent: string[] = [];
    const clock = fakeClock();
    await drive({
      paneId: "w1:p1",
      threadId: 1,
      cfg: { progressIntervalMs: 1, stabilityWindowMs: 30 },
      tg: {} as TelegramClient,
      chatId: 1,
      stopCondition: { kind: "idle", stabilityMs: 30 },
      output: {
        workingTick: () => "TICK",
        paneDelta: (d: string) => d,
        finalMessage: (t: string) => `[final] ${t}`,
      },
      communicator,
      deps: {
        sendMessage: async (_c: number, _t: number, text: string) => { sent.push(text); return 1; },
        now: clock.now,
      },
    }, sent);

    appendFileSync(path, JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
    }) + "\n", "utf8");

    expect(sent.some((m) => m.includes("second"))).toBe(true);
    expect(sent.filter((m) => m.includes("first")).length).toBeLessThanOrEqual(1);
  });
});
```

Add missing import at top:

```ts
import { appendFileSync } from "node:fs";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/readers/observe-cumulative-agents.test.ts`
Expected: FAIL initially due to timing/test scaffolding; adjust the drive loop until it fails for the intended reason (missing cumulative streaming) or passes if previous tasks already satisfy it.

- [ ] **Step 3: Fix any production gap revealed**

If the test reveals duplicate replay or missing unseen content, adjust the reader snapshot or observe-loop seeding minimally.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/readers/observe-cumulative-agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/readers/observe-cumulative-agents.test.ts
git commit -m "test: cumulative observe-loop coverage for pi/codex"
```

---

### Task 9: Full verification and PR preparation

**Files:**
- Modify: PR body only

**Interfaces:**
- Consumes: all previous tasks
- Produces: verified branch and PR description

- [ ] **Step 1: Run full verification**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 2: Inspect diff**

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
```

Expected: only intended files changed.

- [ ] **Step 3: Push branch**

```bash
git push -u origin feat/universal-agent-readers
```

- [ ] **Step 4: Create PR**

Create PR with English title/body:

```bash
gh pr create --title "feat: universal cumulative agent output readers" --body "..."
```

Body must include:
- problem;
- architecture diagram;
- reader matrix;
- legacy removal;
- testing summary.

- [ ] **Step 5: Watch CI**

```bash
gh pr checks --watch
```

Expected: CI passes.
