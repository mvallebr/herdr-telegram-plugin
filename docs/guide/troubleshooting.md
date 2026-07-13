# Troubleshooting

## Bot not responding to messages

1. Check the daemon is running:
   ```bash
   node dist/index.js --status
   ```
   Should show: `Daemon: running (PID NNNNN) | Paired: yes`

2. If `Paired: no` — send `/pair` in the main forum chat.

3. If `not running` — restart:
   ```bash
   node dist/index.js --daemon
   ```

4. Check logs for errors:
   ```bash
   tail -f /tmp/daemon-*.log
   ```

5. The bot must be in a **forum** (supergroup with topics enabled), not a regular chat.

6. The bot must have **administrator** privileges with **Manage Topics** permission.

## "This thread is not bound" message

Send `/bind <pane-label>` inside the topic. If the label doesn't match, run `/reconcile` or check which panes are available with `herdr agent list`.

## Agent stuck / "Working" messages keep coming

If you see many `⏳ Working` messages without a response:

1. **The model may be rate-limited.** Check the herdr tab directly — is the agent still processing, or stuck?

2. **The status bar filter prevents infinite loops.** Pi's cost/token display refreshes are filtered out and won't reset the stability timer.

3. **max_progress_updates** provides a safety net. After the configured limit, the bot gives up and suggests `/digest`.

4. **Press `ESC`** in the herdr tab to cancel the stuck agent.

## Two daemon instances conflict

If you see `409: Conflict` in the logs:

```bash
pkill -f "node.*dist/index.js"
node dist/index.js --daemon
```

## Topics not syncing

The watcher polls every 15 seconds. New tabs appear within one poll cycle.

1. Run `/reconcile` in the forum
2. Check the daemon log for `watcher: tab sync` messages
3. Make sure your herdr agent tabs are actually running (`herdr agent list`)

## Config changes not taking effect

The daemon loads config at startup. After editing `config.toml`:

```bash
kill $(cat ~/.local/state/herdr-telegram/daemon.pid)
setsid nohup node dist/index.js --daemon > /tmp/daemon-$(date +%s).log 2>&1 < /dev/null &
```
