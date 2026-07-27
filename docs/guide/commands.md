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

Messages sent while the previous turn is still in progress are **queued** (per pane). The bridge reacts with 👀 so you can see your message landed. `/stop` aborts the in-progress turn and releases the queue immediately so your queued message is processed right away.

### /last

Read-only snapshot of the current pane output. **Does not submit a turn** — useful when you want to peek at what the agent is doing without disturbing it.

```
/last
→ [2026-07-25T13:00:05.624Z] agy
→
→ (... 14007 chars omitted)
→ ...recent output...
```

The snapshot is truncated to the last 3000 chars (with a `(... N chars omitted)` notice when applicable). If a turn is currently in progress, a `(painel imprimindo — pode estar parcial)` hint is appended.

### /stop

Send ESC to the agent in the current topic — the same effect as pressing ESC inside the agent's terminal UI. Use it to soft-cancel an in-flight operation (tool call, generation) without killing the agent process. Does **not** interrupt a `/follow` subscription on the same thread.

If the pane already has a turn in progress (the bridge is still waiting for the previous response to stabilise), `/stop` also **aborts the in-flight turn and releases the queue**, so the next message you send gets processed immediately instead of being held behind the stuck turn. The reply will say so explicitly:

```
/stop
→ Stopped Echo and released the in-progress turn. The queue will now process your pending messages.
```

For a harder interrupt (SIGINT-style) that kills the current operation, use `/interrupt` instead.

## Subscriptions

### /follow [minutes]

Subscribe to pane updates without sending a prompt. Useful when you want to keep listening to agent activity after your last message — for example, watching a long-running tool call finish, or being notified when the agent emits a `final` or `blocked` response while you're away.

The subscription:

- **Lasts `minutes` after your last message** (default from `follow_timeout_minutes` in config, usually 30).
- **Resets the timer on each message you send** to the same topic.
- **Emits "Subscription expired"** when the timer runs out.
- **Can be disabled** by passing `0` — you must `/unfollow` to stop.

```
/follow
→ Following Echo. expires in 30 min from your last message.

/follow 60
→ Following Echo. expires in 60 min from your last message.

/follow 0
→ Following Echo. no timeout — /unfollow to stop.
```

The bot reacts with 👀 on the `/follow` message as visual confirmation. Re-running `/follow` on the same thread replaces the active subscription with the new timeout.

In follow mode, the bridge publishes only `final` and `blocked` events from the agent — no `Working` heartbeats, no preview spam. On expiration, you'll receive `⏱️ Subscription expired — /follow to listen again.`

### /unfollow

Stop the active subscription on the current thread.

```
/unfollow
→ Unfollowed.
```

Subscriptions are **in-memory**: they do not survive a daemon restart. After a restart you'll need to re-run `/follow` to resume monitoring.

The bot clears the 👀 reaction when you `/unfollow` an active subscription.
