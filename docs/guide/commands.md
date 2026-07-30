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

Any non-command message in a bound topic is forwarded to the corresponding herdr agent pane. The agent receives it as keyboard input and its output is sent back.

```text
(you type)     "what's the status?"
(bot replies)  ⏳ Working (3s).
(bot replies)  [new output chunks]
(bot replies)  ✅ [recent output]
```

There is one active turn per pane. Messages sent while a turn is already active are forwarded to the agent and the existing turn continues. The bridge reacts with 👀 so you can see your message landed. `/stop` aborts the active turn.

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

Send ESC to the agent in the current topic — the same effect as pressing ESC inside the agent's terminal UI. It also aborts the active turn for that pane, if one exists.

```text
/stop
→ Stopped Echo.
```

For a harder interrupt (SIGINT-style) that kills the current operation, use `/interrupt` instead.

## Subscriptions

### /follow [minutes]

Follow pane output for a period of time. Follow is not a separate background loop; it updates the stop condition of the single active turn for the pane.

The stop condition is:

```text
stop = deadline_reached AND (NOT wait_until_idle OR is_idle)
```

In practical terms:

- `/follow N` without a user message keeps listening until the deadline.
- If you send a message during the turn, the turn also requires the agent to become idle.
- `/follow 0` sets the deadline to now; without a pending message it ends immediately.

```text
/follow
→ Following Echo.

/follow 60
→ Following Echo.

/follow 0
→ Following Echo.
```

Re-running `/follow` replaces the current deadline.

### /unfollow

Remove the follow deadline from the active turn.

```text
/unfollow
→ Unfollowed.
```

If a user message arrived during the turn, the turn continues until the agent becomes idle. If no message arrived, the turn can end immediately because the deadline condition is no longer pending.

Follow state is in-memory and does not survive a daemon restart.
