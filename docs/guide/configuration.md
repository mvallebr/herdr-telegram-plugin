# Configuration

`~/.config/herdr-telegram/config.toml`

## Minimal config

```toml
[telegram]
bot_token = "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
```

## Full reference

```toml
[telegram]
bot_token = "..."           # required — from @BotFather
# chat_id = 0               # optional override (auto-detected via /pair)

# --- Waiting & timeouts ---

throttle_ms = 60000         # min ms between ⏳ Working progress updates
max_total_wait_s = 1800     # max seconds total for an agent turn (30 min)
max_progress_updates = 120  # Working updates before giving up (-1 = never)
```

## Options in detail

### throttle_ms

Controls how often `⏳ Working` progress messages are sent while the agent is still producing output. Default: `60000` (1 minute).

Lower values give more frequent updates but can clutter the chat. Higher values reduce noise at the cost of less visibility into what the agent is doing.

### max_total_wait_s

Hard timeout in seconds for the entire agent turn. If the agent doesn't respond within this time, the wait loop exits and sends whatever it has.

### max_progress_updates

Number of `⏳ Working` progress messages before the bot gives up.

| Value | Effective max wait (with default throttle) |
|---|---|
| `10`  | ~10 minutes |
| `60`  | ~1 hour |
| `120` | ~2 hours |
| `-1`  | Never give up |

When the limit is reached, the bot sends:

```
⚠️ Agent didn't respond in time.

[last known output]

Try /digest for a summary.
```

## Environment variables

| Variable | Overrides config.toml |
|---|---|
| `HERDR_TG_BOT_TOKEN` | `bot_token` |
| `HERDR_TG_CHAT_ID` | `chat_id` |
