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

### Wait Loop (`wait-loop.ts`)

Handles a single message turn. When you send a text message to a topic:

#### Phase 1: Detect change

```
sendText(paneId, userText)          # type the message into the pane
read first snapshot                  # capture post-send state
poll until pane content changes       # agent picks up the input
```

#### Phase 2: Stability detection

```
poll every 1 second
  strip status bar lines             # pi cost/token display ignores
  if real content changed:
    reset stability timer
    send ⏳ Working (Xs): [progress]  # throttled (configurable)
    track progress count             # capped by max_progress_updates
  if no real changes for 3s:
    → break (agent done typing)
```

:::info Status bar filtering
The pi agent refreshes its status bar (cost, token usage) every ~2 seconds. `stripStatusBar()` removes these trailing lines before comparing content, so status bar refreshes don't reset the stability timer.
:::

#### Phase 3: Extract response

```
read final pane content
extractResponseSince(content, userText)
  │  find last line containing userInput
  │  return everything after it
  │  trim trailing noise (separators, status bars, prompts)
send ✅ (Xs): [response]
```

### Anchor-based extraction (`extractResponseSince`)

Instead of computing a line-level diff between before/after snapshots of the pane (which breaks when the pane scrolls or separators are cleaned), the response is extracted by anchoring on the **user's input line** in the current content.

This is robust against:
- **Pane scrolling** — lines shift at the top, but the user's input anchor stays
- **Status bar refreshes** — trailing noise is trimmed after extraction
- **Context-mode banners** — cleaned before extraction
- **Separator bars** — filtered out in trailing trim

## Data flow for a message

```
1. User types "what's the status?" in Telegram topic t1-renamed
2. Grammy receives the update → message:text handler fires
3. Handler calls runAgentTurn(paneId="w1:p1M", ..., text="what's the status?")
4. sendText → herdr CLI types the message into pane w1:p1M
5. Phase 1: polls pane until content changes (agent starts working)
6. Phase 2: polls every 1s, strips status bars, sends ⏳ Working every 60s
7. Phase 3: reads final content, anchors on "what's the status?", extracts response
8. sendMessage → "✅ (8s): Tests are all passing..."
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
