# Universal Agent Output Readers — Design

**Date:** 2026-07-30
**Branch:** `feat/universal-agent-readers`
**Status:** Approved

## Problem

PR #11 introduced the cumulative output pipeline for OpenCode:

- `AgentCommunicator` selects a reader once at initialization.
- `observe-loop` receives source-agnostic snapshots.
- New content is derived against a rolling 10k-char tail.
- Unseen content is chunked into Telegram messages of at most 3,000 chars.
- Every chunk carries its own `⏳ Working (...)` marker.

However, the other agents are not fully aligned with that pipeline:

1. `pi` / `omp` readers still return only the last assistant response, not a cumulative snapshot.
2. `codex` readers still distinguish progress vs final response and return only selected messages.
3. `agy` has no dedicated structured reader; it only works if it happens to expose a compatible session path, otherwise it scrapes.
4. Reader-selection knowledge is embedded in `createAgentCommunicator()` and legacy `pickOutputStrategy()`, not in a dedicated reader factory/registry.
5. Legacy wrapper seams (`agent-wrapper.ts`, `agent-wrappers.ts`, `output-reader.ts`, `turn-coordinator.ts`, `telegram-reporter.ts`) remain in the repository although production flows no longer use them.

## Goal

Make every agent pass through the same cumulative pipeline:

```text
wait-loop / commands
        │
        ▼
createAgentCommunicator(agent, deps)
        │
        ▼
AgentOutputReaderFactory / registry
        │
        ▼
AgentCommunicator
        │
        ▼
observe-loop
        │
        ▼
Telegram
```

`AgentCommunicator` depends only on `AgentOutputReader`.
`observe-loop` remains agent-agnostic.
Reader implementations are internal details selected by the factory.

## Non-Goals

- Do not change Telegram chunk size defaults.
- Do not change the 10k sent-tail comparison algorithm.
- Do not change OpenCode SQLite schema support.
- Do not add new agent transport/control features.
- Do not change pairing/topic seeding behavior except where it already consumes `AgentCommunicator`.

## Contract

### `AgentOutputReader`

```ts
export interface AgentOutputReader {
  readonly kind: string;
  read(maxLines: number): string;
}
```

All readers must return a cumulative text snapshot.

Requirements:

- Return `""` when no output is available.
- Never throw from `read()`.
- Never call `readPane()` unless the reader is `ScrapeReader`.
- Never include user prompts by default.
- Structured readers must be cumulative across multiple assistant messages.
- `maxLines` is meaningful only for screen scraping.

### `AgentCommunicator`

```ts
export class AgentCommunicator {
  readonly readerKind: string;
  constructor(reader: AgentOutputReader, logger?: Logger);
  getAgentOutput(maxLines: number): string;
}
```

The communicator must not know:

- agent name;
- SQLite;
- JSONL;
- rollout file discovery;
- terminal scraping details.

It only calls `reader.read(maxLines)`.

### Reader Factory

A new factory/registry component chooses one reader per pane:

```ts
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

export function createAgentOutputReader(req: AgentReaderRequest): AgentOutputReader;
```

The factory is the only place that knows all reader implementations.

It must:

1. Choose a structured reader for known agents when validation succeeds.
2. Choose `ScrapeReader` when no structured source exists or validation fails.
3. Log a daemon warning when a known structured source fails validation.
4. Not log a warning when an agent simply has no known structured source.
5. Return a reader whose selection is permanent for the communicator lifetime.

## Reader Matrix

| Agent | Session ref | Structured reader | Validation | Cumulative source |
|---|---|---|---|---|
| `opencode` | id | `OpenCodeDbReader` | DB exists, tables exist, session exists | latest 50 assistant messages |
| `pi` | path | `PiJsonlReader` | file exists and is regular | assistant text messages from JSONL |
| `omp` | path | `PiJsonlReader` | file exists and is regular | assistant text messages from JSONL |
| `codex` | id or path | `CodexJsonlReader` | rollout file resolvable and readable | assistant commentary/final messages from rollout JSONL |
| `agy` | unknown | none known | N/A | `ScrapeReader` |
| unknown | any | none | N/A | `ScrapeReader` |

## Cumulative Behavior Per Reader

### Pi / OMP

Input JSONL records:

```json
{"type":"message","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
```

Reader output:

- Concatenate assistant `text` content chronologically.
- Skip user messages.
- Skip thinking blocks by default.
- Tolerate malformed lines.
- Return a stable cumulative snapshot for the whole session file.

### Codex

Input JSONL records:

```json
{"type":"response_item","timestamp":"...","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"..."}]}}
```

Reader output:

- Concatenate assistant message content chronologically.
- Include final-answer and non-final commentary as cumulative output.
- Skip user messages.
- Tolerate malformed lines.
- Resolve session id to rollout path once at validation.

### OpenCode

Unchanged from PR #11:

- Latest 50 assistant messages.
- Text parts by default.
- Optional `include_tools` and `include_thoughts`.
- Role in `message.data.role`.
- Parts in `part.data`.

### Scrape

Unchanged:

- Calls `readPane`.
- Applies terminal-status stripping at the scrape boundary.
- Only used when no valid structured reader is available.

## Legacy Removal

The following files are dead production code after PR #11 and should be removed:

- `src/agent-wrapper.ts`
- `src/agent-wrappers.ts`
- `src/output-reader.ts`
- `src/turn-coordinator.ts`
- `src/telegram-reporter.ts`

Their tests should be removed or migrated to the reader factory/readers:

- `tests/agent-wrappers.test.ts`
- `tests/output-reader.test.ts`
- `tests/turn-coordinator.test.ts`
- `tests/turn-dispatcher.test.ts` only if it becomes dead; otherwise keep.

## Error Handling

- Validation failure for a known structured source: warn once, return `ScrapeReader`.
- Runtime structured read failure: log, return `""`; never downgrade to scrape.
- Missing `readPane`: only relevant for `ScrapeReader`; structured readers must not depend on it.
- Unknown agent with no session: `ScrapeReader`, no warning.

## Testing Requirements

- Reader factory selects expected reader per agent/session combination.
- Pi cumulative reader returns multiple assistant messages chronologically.
- Codex cumulative reader returns multiple assistant messages chronologically.
- Readers exclude user prompts.
- Readers tolerate malformed JSONL.
- Runtime failures do not call `readPane`.
- `observe-loop` end-to-end with pi/codex readers emits only unseen cumulative chunks.
- No production file imports removed legacy wrapper seams.

## Approved Diagram

```text
                 Telegram message
                        │
                        ▼
              wait-loop / commands
                        │
                        ▼
        createAgentCommunicator(agent, deps)
                        │
                        ▼
        AgentOutputReaderFactory / registry
                        │
          knows all reader implementations
          validates structured source once
          chooses reader or ScrapeReader
                        │
                        ▼
               AgentCommunicator
                        │
       depends only on AgentOutputReader
       exposes getAgentOutput(maxLines)
                        │
                        ▼
                  observe-loop
                        │
        source-agnostic cumulative pipeline:
        - keep last 10k sent chars
        - derive unseen suffix
        - chunk unseen into <=3k Telegram chunks
        - each chunk ends with Working marker
        - emit final when stable/expired
                        │
                        ▼
                     Telegram


AgentOutputReader interface
        ▲
        │ implements
┌───────┴──────────────────────────────┐
│                                      │
OpenCodeDbReader        JsonlReader    ScrapeReader
- SQLite message/part   - pi JSONL     - herdr pane read
- cumulative snapshot   - codex JSONL  - terminal-only
                        - agy if possible
```
