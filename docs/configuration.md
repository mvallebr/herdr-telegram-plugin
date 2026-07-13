# Configuration

Full reference for `~/.config/herdr-telegram/config.toml`.

## All options

```toml
[telegram]
bot_token = "..."           # required — from @BotFather
# chat_id = 0               # optional override (auto-detected via /pair)
throttle_ms = 60000         # min ms between ⏳ Working progress updates
max_total_wait_s = 1800     # max seconds to wait for agent response (30 min)
max_progress_updates = 120  # how many Working updates before timeout (-1 = infinite)
```

## throttle_ms

Controls how often `⏳ Working` progress messages are sent while the agent is still producing output. Default: `60000` (1 minute).

Lower values give more frequent updates but can clutter the chat.

## max_total_wait_s

Hard timeout for the entire agent turn. If the agent doesn't respond within this time, the bot gives up.

## max_progress_updates

Number of `⏳ Working` progress messages before the bot gives up and sends a timeout message suggesting `/digest`.

| Value | Behavior |
|---|---|
| `60` | Up to ~1 hour (60 × 60s throttle) |
| `120` | Up to ~2 hours |
| `-1` | Never give up |

When the limit is reached, the bot sends:

```
⚠️ Agent didn't respond in time.

[last known output]

Try /digest for a summary.
```

## Environment variables

| Variable | Overrides |
|---|---|
| `HERDR_TG_BOT_TOKEN` | `bot_token` |
| `HERDR_TG_CHAT_ID` | `chat_id` |
