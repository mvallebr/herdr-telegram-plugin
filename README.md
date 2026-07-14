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

The daemon connects to Telegram via grammy and to herdr via CLI (`spawnSync`). A watcher syncs herdr tabs to forum topics every 15s. Messages are forwarded to agent panes; responses are extracted via anchor-based content polling.

[→ Full documentation](https://mvallebr.github.io/herdr-telegram-plugin/)

## License

MIT
