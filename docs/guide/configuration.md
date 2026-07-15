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

progress_interval_ms = 15000 # ask the agent wrapper for status every 15s
max_total_wait_s = 1800     # max seconds total for an agent turn (30 min)
max_progress_updates = 60   # maximum ⏳ Working updates (-1 = unlimited)
```

## Options in detail

### progress_interval_ms

Controls how often the shared turn coordinator asks the selected agent wrapper for its status. If it is still working, Telegram receives one neutral `⏳ Working` message. Default: `15000` (15 seconds).

This applies equally to Codex JSONL, Pi/OMP JSONL, and screen-scraped agents. Lower values give more frequent updates but can clutter the chat.

For the screen-scrape fallback (such as OpenCode), this same interval is also the required quiet time before output can be final. One configuration controls both polling and stability.

### max_total_wait_s

Hard timeout in seconds for the entire agent turn. If no wrapper returns a safe final response in time, the bot sends a timeout warning. It does not forward uncorrelated terminal content.

### max_progress_updates

Maximum number of neutral `⏳ Working` messages for a turn. Polling continues until `max_total_wait_s`; this setting only limits chat noise. Use `-1` for unlimited updates.

## Environment variables

| Variable | Overrides config.toml |
|---|---|
| `HERDR_TG_BOT_TOKEN` | `bot_token` |
| `HERDR_TG_CHAT_ID` | `chat_id` |
