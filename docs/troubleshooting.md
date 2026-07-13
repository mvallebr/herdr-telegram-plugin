# Troubleshooting

## Bot not responding to messages

1. Check the daemon is running:
   ```bash
   node dist/index.js --status
   ```
2. Check logs for errors:
   ```bash
   tail -f /tmp/daemon-v*.log
   ```
3. Make sure the bot is in a **forum** (not a regular chat).
4. Try `/reconcile` to re-sync topics.

## "This thread is not bound" message

Send `/bind <pane-label>` inside the topic. The watcher should have auto-bound it — if not, the label might not match.

## Agent stuck / "Working" loop never ends

The agent's model may be rate-limited or stuck. The wait loop has two safety nets:

1. **Status bar filtering** — pi cost/token refreshes won't reset the stability timer
2. **max_progress_updates** — after the configured limit, a timeout message is sent suggesting `/digest`

If the model is genuinely stuck, press `ESC` in the herdr tab to cancel it.

## Two daemon instances conflict

If you see `409: Conflict: terminated by other getUpdates request` in the logs, another daemon instance is still running:

```bash
pkill -f "node.*dist/index.js"
node dist/index.js --daemon
```

## Topics not syncing

The watcher polls every 15 seconds. New tabs appear within one poll cycle. If topics still don't appear:

1. Run `/reconcile` in the forum chat
2. Check the daemon log for `watcher: re-bound` messages
3. Make sure your herdr agent tabs are actually running

## Config not taking effect

The daemon loads config at startup. Restart it after editing `config.toml`:

```bash
kill $(cat ~/.local/state/herdr-telegram/daemon.pid)
node dist/index.js --daemon
```
