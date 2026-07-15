# Agent Support

All agents share the same turn lifecycle: submit once, poll `status()`, publish `Working` updates, then publish a final result. The only variable is the adapter used to read agent output.

| Agent | Adapter | Final-result signal | Notes |
|---|---|---|---|
| Codex | Structured session-log wrapper | JSONL `final_answer` correlated to the submitted prompt | Commentary is progress only, never final output. |
| Pi | Structured session-log wrapper | Assistant message in Herdr-provided JSONL path | Requires `agent_session.path`. |
| OMP | Structured session-log wrapper | Assistant message in Herdr-provided JSONL path | Uses Pi-compatible log parsing. |
| OpenCode | Screen-scrape wrapper | Stable changed screen, with Herdr `idle` as an extra signal when needed | Uses prompt anchor, snapshot delta, then safe idle fallback. |
| Other agents | Screen-scrape wrapper | Stable changed screen | Fallback; behavior depends on terminal UI. |

## Progress and completion

`progress_interval_ms` controls both wrapper polling and the required quiet period for screen scraping. The Coordinator emits a neutral `Working` heartbeat at that cadence; a wrapper may attach a new safe preview. The final message is only sent when the wrapper reports `final`.

Telegram messages are capped below 4,096 characters. Longer final responses are truncated with an indication.

## Contributing a wrapper

See [CONTRIBUTING.md](https://github.com/mvallebr/herdr-telegram-plugin/blob/main/CONTRIBUTING.md) for the wrapper contract, tests, and issue-reporting checklist.
