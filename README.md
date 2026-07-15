# herdr-telegram-plugin

> 📖 Full documentation: https://mvallebr.github.io/herdr-telegram-plugin/

Control your [herdr](https://herdr.dev) agents from Telegram via forum topics — **zero LLM in the path**.

Each herdr agent pane maps 1:1 to a Telegram forum topic. Messages in a topic are forwarded to the pane as keyboard input. Agent output is sent back to Telegram.

## Quick install

### Option A: install from GitHub via the herdr CLI (recommended)

```bash
herdr plugin install mvallebr/herdr-telegram-plugin --yes
```

This drops the plugin into `~/.config/herdr/plugins/github/herdr-telegram-plugin-*` and resolves all dependencies.

### Option B: from a git checkout (for development)

```bash
git clone https://github.com/mvallebr/herdr-telegram-plugin
cd herdr-telegram-plugin
npm install && npm run build
```

Then point herdr at it: `herdr plugin link .`

### Configure

```bash
mkdir -p ~/.config/herdr-telegram
echo '[telegram]' > ~/.config/herdr-telegram/config.toml
echo 'bot_token = "YOUR_BOT_TOKEN"' >> ~/.config/herdr-telegram/config.toml
echo 'progress_interval_ms = 15000' >> ~/.config/herdr-telegram/config.toml
```

### Start the daemon

From the herdr-managed install (`~/.config/herdr/plugins/github/herdr-telegram-plugin-*`):

```bash
cd ~/.config/herdr/plugins/github/herdr-telegram-plugin-*
node dist/index.js --daemon
```

Or, equivalently, the daemon auto-launches when needed by Telegram activity
(grammy long-polling only happens while the daemon runs, so a one-shot
`node dist/index.js --daemon &` per session is the simplest pattern).

Then open Telegram, find your bot's private chat, and send `/pair`.

The daemon keeps a single long-poll connection. Temporary Telegram failures,
including a `409 Conflict` after a supervised restart, are retried with
backoff; invalid bot credentials fail fast. Use `node dist/index.js --status`
to inspect the process and polling state.

### Operational smoke check

Run this only on a machine with Herdr and a real bot configuration:

```bash
npm run smoke
```

It validates `herdr agent list` and the bot credentials without consuming
updates or sending messages. Then start the daemon and verify one manual
topic → pane → reply round trip in Telegram.

## Commands

| Command | What it does |
|---|---|
| Plain text in any topic | Sends text to that topic's agent pane |
| `/digest` | Ask the agent for a summary of current work |
| `/pair` | Authorize the bot in the current chat |
| `/unpair` | De-authorize and delete all topics |
| `/bind <label>` | Bind the current topic to a herdr pane |
| `/cleanup` | Remove duplicate topics |
| `/reconcile` | Re-sync herdr tabs with Telegram topics |

## How it works

The daemon connects to Telegram via grammy and to herdr via CLI (`spawnSync`). A watcher syncs herdr tabs to forum topics every 15s. A shared turn coordinator sends the prompt once, polls an agent wrapper at the configured interval, and publishes neutral progress until a safe final result arrives. Codex/Pi/OMP use session logs; other agents use anchor-based screen scraping.

## Agent support

| Agent | Output adapter |
|---|---|
| Codex | Correlated JSONL `final_answer` |
| Pi / OMP | Herdr-provided JSONL session path |
| OpenCode and other agents | Screen scraping with prompt anchor, snapshot delta, and stable-screen fallback |

See the [full support matrix](docs/guide/agent-support.md). To contribute a wrapper or report a bug, read [CONTRIBUTING.md](CONTRIBUTING.md).

[→ Full documentation](https://mvallebr.github.io/herdr-telegram-plugin/)

## License

MIT
