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

# --- Screen-scrape stability ---

stability_window_ms = 30000  # min ms the pane must stay unchanged before
                              # a screen-scrape turn is declared final.
                              # Larger values tolerate herdr's idle-flicker
                              # during long tool calls.

# --- Subscriptions (/follow) ---

follow_timeout_minutes = 30  # default timeout for /follow subscriptions.
                              # Timer resets on each user message. 0 = no
                              # timeout, manual /unfollow required.
```

## Options in detail

### progress_interval_ms

Controls how often the shared turn coordinator asks the selected agent wrapper for its status. If it is still working, Telegram receives one neutral `⏳ Working` message. Default: `15000` (15 seconds).

This applies equally to Codex JSONL, Pi/OMP JSONL, and screen-scraped agents. Lower values give more frequent updates but can clutter the chat.

### stability_window_ms

For the screen-scrape fallback (such as OpenCode), this is the minimum time in milliseconds the pane must remain unchanged before the turn coordinator considers the response final. Default: `30000` (30 seconds).

Independent from `progress_interval_ms` so you can tune polling cadence and stability window separately. Increase if herdr reports `idle` while the agent is still streaming a long tool's output and you see truncated responses; decrease for snappier handoffs when your agent is well-behaved. Has no effect on Codex/Pi/OMP (those use session logs).

### max_total_wait_s

Hard timeout in seconds for the entire agent turn. If no wrapper returns a safe final response in time, the bot sends a timeout warning. It does not forward uncorrelated terminal content.

### max_progress_updates

Maximum number of neutral `⏳ Working` messages for a turn. Polling continues until `max_total_wait_s`; this setting only limits chat noise. Use `-1` for unlimited updates.

### follow_timeout_minutes

Default minutes a `/follow` subscription stays alive after your last message before expiring. Default: `30`. Set to `0` to disable the timeout entirely — you then must `/unfollow` manually to stop the subscription.

Each message you send while subscribed resets the timer to this value. Per-thread `timeout_minutes` can also be set inline: `/follow 60` overrides the default for that thread only.

## Environment variables

| Variable | Overrides config.toml |
|---|---|
| `HERDR_TG_BOT_TOKEN` | `bot_token` |
| `HERDR_TG_CHAT_ID` | `chat_id` |
