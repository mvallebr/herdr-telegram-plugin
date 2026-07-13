# herdr-telegram-plugin

Control your [herdr](https://herdr.dev) agents from Telegram via forum topics — **zero LLM in the path**.

## Install

```bash
herdr plugin install github.com/mvallebr/herdr-telegram-plugin
```

## Configure

```bash
mkdir -p ~/.config/herdr-telegram
echo 'bot_token = "YOUR_BOT_TOKEN"' > ~/.config/herdr-telegram/config.toml
```

## Setup in Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Create a **supergroup** (or convert existing group)
3. Enable **Topics**: Group Settings → Topics → ON
4. Add the bot as **administrator** with **Manage Topics** permission
5. Send any message in the group, then `/pair`

## Usage

| Command | Action |
|---|---|
| **Plain text** in any topic | Sends text to that topic's agent pane |
| `/help` | List commands |
| `/agents` | List all agents with status and topic IDs |
| `/status` | Bridge uptime and config |
| `/interrupt` | Ctrl+C to this topic's agent |
| `/trust` | "trust, always allow" to this topic's agent |
| `/digest` | Daily activity summary |

## How it works

Each herdr agent pane maps 1:1 to a Telegram forum topic. Messages in a topic are forwarded to the herdr pane as keyboard input. Agent output is sent back to Telegram. The bridge adds **zero LLM cost** — it reads/writes terminal buffers via herdr's CLI.

## Requirements

- herdr 0.7+
- Node.js 18+
- Telegram bot token (from @BotFather)
- Telegram supergroup with Topics enabled
- Bot must be group administrator with `Manage Topics` permission

## License

MIT
