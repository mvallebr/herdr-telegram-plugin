# Step 3: Configure & Run

## Create config.toml

```bash
mkdir -p ~/.config/herdr-telegram
```

Paste the bot token from Step 1:

```toml
# ~/.config/herdr-telegram/config.toml
[telegram]
bot_token = "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
```

:::tip That's the minimum
Only `bot_token` is required. See [Configuration](/guide/configuration) for all options.
:::

## Start the daemon

```bash
node dist/index.js --daemon
```

You'll see:

```
Daemon started (PID 12345)
```

## Verify it's running

```bash
node dist/index.js --status
# Daemon: running (PID 12345) | Paired: no
```

The daemon is running but not yet authorized. Let's fix that.

## Next

→ [Step 4: Pair & First Message](/tutorial/first-run)
