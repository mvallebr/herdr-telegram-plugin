# herdr-telegram-plugin

![herdr-telegram-plugin logo](/logo.svg)

**Remote control herdr agents from Telegram.** Each agent tab gets its own forum topic. Send a message, get the response back — no LLM in the path.

[Get Started →](/tutorial/) &nbsp; [View on GitHub →](https://github.com/mvallebr/herdr-telegram-plugin)

---

## Features

**🧵 One topic per agent** — the watcher syncs herdr tabs to Telegram forum topics automatically. New agent? New topic appears in seconds.

**⚡ Unified agent polling** — one coordinator polls a wrapper for each agent. Codex/Pi/OMP use their structured session logs; other agents use stable, anchor-based screen scraping.

**🎯 Anchor-based extraction** — response is extracted by anchoring on the user's input line. Survives pane scrolling, separator bars, and context-mode banners.

**🛡️ Safe by default** — `/pair` requires explicit authorization. Progress updates are throttled and capped. Stuck models don't loop forever.

---

## Make it yours

```toml
# ~/.config/herdr-telegram/config.toml
[telegram]
bot_token = "..."           # from @BotFather
progress_interval_ms = 15000 # status poll / ⏳ Working cadence
max_progress_updates = 60    # cap Telegram progress noise (-1 = unlimited)
```

## Quick reference

| What | How |
|---|---|
| Ask an agent a question | Just type in its topic |
| Get a work summary | `/digest` |
| Add a new agent tab in herdr | Topic appears automatically (15s) |
| Rename a tab | Topic name updates |
| Close a tab | Topic is deleted |
| Bind a topic manually | `/bind <label>` |
