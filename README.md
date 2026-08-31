# herdr-telegram-plugin

> 📖 Full documentation: https://mvallebr.github.io/herdr-telegram-plugin/

Control your [herdr](https://herdr.dev) agents from Telegram via forum topics — **zero LLM in the path**.

Each herdr agent pane maps 1:1 to a Telegram forum topic. Messages in a topic are forwarded to the pane as keyboard input. Agent output is sent back to Telegram.

## Prerequisites

- Herdr `>= 0.7.0`;
- Node.js `>= 22.5.0` and npm from the same Node installation;
- A Telegram bot token and a Telegram chat where the bot can operate.

Node 22.5.0 or newer is required because the OpenCode structured-output reader
uses the built-in `node:sqlite` module. Without it, the bridge falls back to
screen scraping instead of reading OpenCode's session database.

Verify the runtime before installing or starting the bridge:

```bash
node --version
node -e "require('node:sqlite'); console.log('node:sqlite: ok')"
```

Both commands must use Node 22.5.0 or newer. The second command must print
`node:sqlite: ok`.

### Important: Herdr's Node runtime

The plugin actions in `herdr-plugin.toml` invoke `node` by name. Herdr runs as
a long-lived process and resolves that command using its own `PATH`; it does
not necessarily inherit the Node selected by an interactive shell or `nvm`.
If Herdr was started without your NVM environment, it may find an older
`/usr/bin/node` even when `node --version` in your terminal reports Node 22.

Make Node 22.5.0+ available in the environment that starts Herdr, or start the
daemon manually with the verified binary:

```bash
NODE_BIN="$(command -v node)"
"$NODE_BIN" --version
"$NODE_BIN" -e "require('node:sqlite'); console.log('node:sqlite: ok')"
"$NODE_BIN" dist/index.js --daemon
```

To verify an already-running daemon, inspect the executable used by its PID:

```bash
PID="$(tr -d '[:space:]' < ~/.local/state/herdr-telegram/daemon.pid)"
readlink "/proc/$PID/exe"
"$(readlink "/proc/$PID/exe")" --version
```

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
NODE_BIN="$(command -v node)"
"$NODE_BIN" dist/index.js --daemon
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
| `/last` | Read-only snapshot of the current pane output (no turn submitted) |
| `/follow [minutes]` | Subscribe to pane updates for N minutes (default 30, 0 = manual); resets on each message |
| `/unfollow` | Stop the active subscription on this thread |
| `/stop` | Send ESC to the agent (soft-cancels the current operation; for hard interrupt use `/interrupt`) |

## How it works

The daemon connects to Telegram via grammy and to herdr via CLI (`spawnSync`). A watcher syncs herdr tabs to forum topics every 15s.

Each Herdr pane is represented by one `PaneAgent`. A `PaneAgent` owns one `AgentCommunicator` and at most one active observe loop. Messages and `/follow` are handled as one turn per pane with different stop conditions:

```text
stop = deadline_reached AND (NOT wait_until_idle OR is_idle)
```

The daemon is the only component that talks to Telegram. `PaneAgent`, `AgentCommunicator`, and the observe loop emit output events back to the daemon, which formats and sends them.

## Agent support

| Agent | Output source |
|---|---|
| OpenCode | SQLite session database |
| Codex | JSONL rollout/session log |
| Pi / OMP | Herdr-provided JSONL session path |
| Other agents | Screen scraping fallback |

See the [full support matrix](docs/guide/agent-support.md). To contribute a wrapper or report a bug, read [CONTRIBUTING.md](CONTRIBUTING.md).

[→ Full documentation](https://mvallebr.github.io/herdr-telegram-plugin/)

## License

MIT
