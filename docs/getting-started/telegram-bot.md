# Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the token BotFather gives you.
4. Paste it into `config.toml`:

```toml
[telegram]
bot_token = "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
```

5. Set the bot to **inline mode disabled** and **allow groups** (recommended for forum use).
6. Create a **forum** (supergroup with topics enabled) and add your bot as an admin.

::: warning
The bot must be added to a **forum** (supergroup with topics enabled), not a regular chat.
:::
