# Commands

All commands work in any topic or in the main forum chat.

## /pair

Authorize the bot in the current chat. Only one chat can be paired at a time.

```
/pair
→ ✅ Chat authorized. Reconciling tabs...
```

## /unpair

De-authorize and delete all bot-created topics from the chat.

```
/unpair
→ Unpaired. Deleted X topic(s). Send /pair to re-authorize.
```

## /digest

Ask the agent in the current topic for a summary of recent work.

```
/digest
→ Asking t1-renamed for a summary...
→ [agent's summary]
```

## /bind \<label\>

Bind the current topic to a specific herdr agent pane by label.

```
/bind pi-optimize
→ Thread bound to pi-optimize.
```

## /cleanup

Remove duplicate topics (when the same pane has multiple forum threads).

```
/cleanup
→ Cleaned up: 2 duplicate(s) removed.
```

## /reconcile

Re-scan all herdr tabs and re-sync Telegram topics. Useful after adding or removing agent panes.

```
/reconcile
→ Reconciled: 7 panes mapped.
```

## Plain text messages

Any non-command message in a bound topic is forwarded to the corresponding herdr agent pane. The agent's response is sent back to the same topic.
