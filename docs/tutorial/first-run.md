# Step 4: Pair & First Message

## Authorize the bot

1. Open your Telegram forum (the one from Step 1)
2. Send `/pair` in the main chat (not inside a topic)

![Pair command](images/7_pair.png)

The bot replies:

```
✅ Chat authorized. Reconciling tabs...
Auto-created: good-morning-chat, pi-optimize, vox2d, ...
```

Your herdr agent tabs now appear as forum topics:

![Herdr tabs open](images/8_pair_herdr_tabs_open.png)

:::tip Topic sync
The watcher polls every 15 seconds. New agent tabs may take a few seconds to appear.
:::

## Send your first message

1. Open a topic that matches one of your herdr agent tabs
2. Type any message — e.g. "what are you working on?"

![Test message](images/9_test_message.png)

You'll see:

```
⏳ Working (2s):

[agent thinking...]

✅ (5s):

Here's what I'm working on...
```

That's it! Your agent heard you and responded.

## What's happening under the hood

1. Your message → forwarded to the herdr pane as keyboard input
2. Plugin polls the pane until the agent finishes typing
3. Response extracted and sent back to Telegram
4. **Zero LLM cost in the plugin** — it just reads/writes terminal buffers

## Next

→ [Step 5: Daily Usage](/tutorial/daily-usage)
