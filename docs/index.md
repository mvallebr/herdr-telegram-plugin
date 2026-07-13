---
layout: home

hero:
  name: "herdr-telegram-plugin"
  text: "Remote control herdr agents from Telegram"
  tagline: "Each agent tab gets its own forum topic. Send a message, get the response back — no LLM in the path."
  image:
    src: /logo.svg
    alt: herdr-telegram-plugin
  actions:
    - theme: brand
      text: Start Tutorial →
      link: /tutorial/
    - theme: alt
      text: View on GitHub
      link: https://github.com/mvallebr/herdr-telegram-plugin

features:
  - icon: 🧵
    title: One topic per agent
    details: The watcher syncs herdr tabs to Telegram forum topics automatically. New agent? New topic appears in seconds.
  - icon: ⚡
    title: Content-based polling
    details: Wait loop detects when the agent finishes responding using stability detection — no fragile status checks. Status bar refreshes are filtered out.
  - icon: 🎯
    title: Anchor-based extraction
    details: Response is extracted by anchoring on the user's input line. Survives pane scrolling, separator bars, and context-mode banners.
  - icon: 🛡️
    title: Safe by default
    details: /pair requires explicit authorization. Progress updates are throttled and capped. Stuck models don't loop forever.
---

## Make it yours

```toml
# ~/.config/herdr-telegram/config.toml
[telegram]
bot_token = "..."           # from @BotFather
throttle_ms = 60000         # min between ⏳ Working updates
max_progress_updates = 120  # updates before timeout (-1 = never)
```

| What | How |
|---|---|
| Ask an agent a question | Just type in its topic |
| Get a work summary | `/digest` |
| Add a new agent tab in herdr | Topic appears automatically (15s) |
| Rename a tab | Topic name updates |
| Close a tab | Topic is deleted |
| Bind a topic manually | `/bind <label>` |

Ready? → [Start the tutorial](/tutorial/)
