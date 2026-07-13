# Installation

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [herdr](https://github.com/mvallebr/herdr) (the terminal agent runner)
- A Telegram bot token (see [Create a Telegram Bot](/getting-started/telegram-bot))

## Install from source

```bash
git clone https://github.com/mvallebr/herdr-telegram-plugin
cd herdr-telegram-plugin
npm install
npm run build
```

## Configure

Create `~/.config/herdr-telegram/config.toml`:

```toml
[telegram]
bot_token = "123456:ABC-DEF1234gh..."
```

::: tip Minimum config
Only `bot_token` is required. All other settings have sensible defaults.
:::

## Register with herdr

Add the plugin to herdr's config so the daemon is managed by herdr:

```toml
# In herdr's config
[[plugins]]
name = "telegram"
source = "github:mvallebr/herdr-telegram-plugin"
```

Or run standalone:

```bash
node dist/index.js --daemon
```

## Verify

```bash
node dist/index.js --status
# Daemon: running (PID 12345) | Paired: no
```

The daemon is running but not yet paired. Proceed to [First Run](/getting-started/first-run).
