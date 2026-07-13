# How it Works

## Architecture

```
┌──────────┐    message:text    ┌─────────────┐    sendText/readPane    ┌───────┐
│ Telegram │ ──────────────────→│ herdr-plugin │ ──────────────────────→│ herdr │
│  Forum   │ ←──────────────────│   daemon     │ ←──────────────────────│ pane  │
└──────────┘    sendMessage     └─────────────┘    (spawnSync)          └───────┘
```

Three components:

1. **Daemon** — long-running Node.js process that connects to Telegram via grammy and to herdr via CLI
2. **Watcher** — polls every 15s to detect new/closed/renamed herdr tabs and syncs Telegram topics
3. **Wait Loop** — handles each message turn: send text → poll pane → detect stability → extract response

## Message flow

When you type a message in a Telegram topic:

### Phase 1: Detect change

```
sendText("paneId", userText)          # type the user's message into the pane
readPane(paneId, 200)                 # capture post-send snapshot
poll until pane content changes       # agent is picking up the input
```

### Phase 2: Stability detection

```
poll every 1s
  strip status bar lines              # ignore pi cost/token display refreshes
  if real content changed:
    reset stability timer
    send ⏳ Working (Xs): [progress]   # throttled (default 60s)
  if no changes for 3s:
    → break (agent finished)
```

:::tip Status bar filtering
Pi refresh displays cost and token usage every ~2s. These refreshes are filtered out
so they don't reset the stability timer — otherwise a stuck model would loop forever.
:::

### Phase 3: Extract response

```
readPane(paneId, 200)
extractResponseSince(content, userText)  # anchor on user's input line
│  find last line containing userText
│  return everything after it
│  trim trailing noise (separators, status bars)
send ✅ (Ys): [response]
```

## Anchor-based extraction

Instead of diffing pane content before and after the agent responds (which breaks
when the pane scrolls or separators are cleaned), the response is extracted by
anchoring on the **user's input line** in the current pane content.

This is robust against:
- Pane scrolling (lines shift at top)
- Status bar refreshes (trailing noise is trimmed)
- Context-mode banners (cleaned before extraction)

## Progress throttling

`max_progress_updates` limits how many `⏳ Working` messages are sent before the
bot gives up. When the model is stuck or rate-limited, this prevents infinite progress updates.

On timeout, the bot sends a message suggesting `/digest` for a summary.
