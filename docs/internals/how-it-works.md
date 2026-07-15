# How it Works

## Architecture

```
┌──────────┐   message:text    ┌─────────────────┐   sendText/readPane   ┌───────┐
│ Telegram │ ─────────────────→│ herdr-telegram   │ ────────────────────→│ herdr │
│  Forum   │ ←─────────────────│    plugin        │ ←────────────────────│ pane  │
└──────────┘   sendMessage     └─────────────────┘   (spawnSync CLI)     └───────┘
                                    │
                                    │ poll every 15s
                                    ▼
                              ┌──────────┐
                              │ Watcher  │ syncs herdr tabs ↔ Telegram topics
                              └──────────┘
```

## Components

### Daemon (`daemon.ts`)

Long-running Node.js process. Starts a [grammy](https://grammy.dev) bot that listens for Telegram updates and registers command/text handlers. On startup, pairs the bot with an authorized chat and starts the watcher.

### Watcher (`watcher.ts`)

Polls herdr's agent list every 15 seconds. Detects new, renamed, closed, and recreated panes. Syncs detected changes to Telegram by creating/renaming/deleting forum topics. Also runs periodic health checks to detect topics that were deleted manually.

### Turn Coordinator and wrappers

`TurnCoordinator` owns polling cadence, heartbeats, progress limits, and final delivery. Each `AgentWrapper` owns only agent transport and reports `working`, `final`, or `failed`.

For screen-scraped agents, the wrapper submits the prompt, captures a snapshot, and extracts output using the prompt anchor or a changed snapshot. Structured agents (Codex, Pi, OMP) use session logs instead.

```
submit(prompt)
status() → working | final | failed
Coordinator polls every progress_interval_ms
  → ⏳ Working heartbeat or safe preview
  → ✅ only after final
```

:::info Status bar filtering
The pi agent refreshes its status bar (cost, token usage) every ~2 seconds. `stripStatusBar()` removes these trailing lines before comparing content, so status bar refreshes don't reset the stability timer.
:::

### Screen-scrape extraction

The first choice is the user's prompt as an anchor in the current screen. If a UI removes that prompt, the wrapper compares the post-submit snapshot with the changed screen. When Herdr also confirms `idle`, it can use the cleaned changed screen as a final fallback.

This is robust against:
- **Pane scrolling** — lines shift at the top, but the user's input anchor stays
- **Status bar refreshes** — trailing noise is trimmed after extraction
- **Context-mode banners** — cleaned before extraction
- **Separator bars** — filtered out in trailing trim

## Data flow for a message

```
1. User types "what's the status?" in Telegram topic t1-renamed
2. Grammy receives the update → message:text handler fires
3. Handler enqueues the turn for its pane; other panes continue independently
4. Wrapper submits the prompt through herdr CLI
5. Coordinator polls `status()` at `progress_interval_ms`
6. Telegram receives a `⏳ Working` heartbeat or a new safe preview
7. Wrapper reports `final` from a session log or stable screen output
8. Telegram receives `✅` with the final response
```

## State

Daemon state is persisted to `~/.local/state/herdr-telegram/state.json`:

```json
{
  "authorized_chat_id": 8911510807,
  "thread_mappings": {
    "482": { "pane_id": "w1:p1M", "label": "t1-renamed", "agent": "pi" },
    "520": { "pane_id": "w1:p1K", "label": "pi-optimize", "agent": "opencode" }
  },
  "known_tabs": {
    "w1:t1M": { "label": "t1-renamed", "thread_id": 482 }
  }
}
```

On startup, state is loaded from disk. The watcher keeps it in sync with herdr's actual pane state.
