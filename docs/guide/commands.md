# Commands

## Pairing

### /pair

Authorize the bot to manage topics in the current chat. Only one chat can be paired at a time. Re-pairing in a different chat requires `/unpair` first.

```
/pair
→ ✅ Chat authorized. Reconciling tabs...
→ Auto-created: pi-optimize, t1-renamed, ...
```

### /unpair

De-authorize the bot and **delete all bot-created topics** from the chat.

```
/unpair
→ Unpaired. Deleted 7 topic(s). Send /pair to re-authorize.
```

:::warning Destructive
All topics created by the bot are deleted. Manual topics (created by users) are not affected.
:::

## Topic management

### /bind \<pane-label\>

Bind the current topic to a specific herdr pane. Useful when the automatic sync doesn't pick up a tab, or when you want to re-bind manually.

```
/bind pi-optimize
→ Thread bound to pi-optimize.
```

### /cleanup

Remove duplicate topics. Happens when the same pane somehow gets multiple forum threads.

```
/cleanup
→ Cleaned up: 2 duplicate(s) removed.
```

### /reconcile

Re-scan all herdr tabs and re-sync Telegram topics. Useful after adding or removing agent panes, or if topics get out of sync.

```
/reconcile
→ Reconciled: 8 panes mapped.
```

## Agent interaction

### /digest

Ask the agent in the current topic for a summary of what it's been working on.

```
/digest
→ Asking pi-optimize for a summary...
→ [agent's summary of recent work]
```

The prompt sent to the agent is:

```
Keep it under 4000 characters. Summarize what we've been working on:
original goal, progress, blockers, next steps.
```

### Plain text

Any non-command message in a bound topic is forwarded to the corresponding herdr agent pane. The agent receives it as keyboard input and its terminal output is sent back.

```
(you type)     "what's the status?"
(bot replies)  ⏳ Working (3s): [agent thinking...]
(bot replies)  ✅ (8s): Tests are all passing, just need to...
```
