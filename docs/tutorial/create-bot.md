# Step 1: Create a Telegram Bot

## Open @BotFather

1. In Telegram, search for [@BotFather](https://t.me/BotFather)
2. Send the command `/newbot`
3. Follow the prompts — give your bot a **name** and a **username** (must end in `bot`)
4. BotFather will reply with a **token**. Copy it — you'll need it in Step 3.

```
Done! Congratulations on your new bot. You will find it at t.me/your_bot.

Use this token to access the HTTP API:
1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
```

:::tip Keep your token secret
Anyone with the token can control your bot. Never commit it to git.
:::

## Create a Forum

The bot needs a **forum** (supergroup with topics enabled) to work:

1. In Telegram, tap the menu → **New Group**
2. Add at least one other person (you can remove them later)
3. Name the group, then go to **Group Settings → Topics → ON**
4. Add your bot as a **member** and promote it to **administrator**
5. Give the bot these admin permissions: **Manage Topics**

Your forum now has topics enabled and the bot is ready to create and manage them.

## Next

→ [Step 2: Install the Plugin](/tutorial/install)
