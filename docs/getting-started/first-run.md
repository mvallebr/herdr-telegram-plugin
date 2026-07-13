# First Run

## Start the daemon

```bash
node dist/index.js --daemon
```

## Pair the bot

1. Open Telegram and find your bot.
2. Send `/pair` in the forum chat.
3. The bot replies: `✅ Chat authorized. Reconciling tabs...`
4. Topics appear — one for each herdr agent tab.

::: tip
The watcher polls every 15 seconds. New tabs may take up to 15 seconds to appear as topics.
:::

## Test it

Type a message in any topic. The agent in the corresponding herdr tab receives it and responds. You'll see:

```
⏳ Working (Xs):

[agent is thinking...]

✅ (Ys):

[agent's response]
```

## Commands

| Command | What it does |
|---|---|
| `/digest` | Ask the agent for a summary of current work |
| `/pair` | Authorize the bot in a chat |
| `/unpair` | De-authorize and delete all topics |
| `/bind <label>` | Manually bind a topic to a specific herdr pane |
| `/cleanup` | Remove duplicate topics |
| `/reconcile` | Re-scan herdr tabs and sync topics |
