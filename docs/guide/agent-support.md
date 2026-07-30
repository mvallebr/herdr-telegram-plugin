# Agent Support

All agents share the same turn pipeline: one `PaneAgent` per Herdr pane, one `AgentCommunicator`, and at most one active observe loop. The variable part is the output reader selected by the communicator.

| Agent | Output source | Notes |
|---|---|---|
| OpenCode | SQLite session database | Uses the OpenCode DB when Herdr reports the session id. |
| Codex | JSONL rollout/session log | Resolves rollout file from Herdr session information. |
| Pi / OMP | Herdr-provided JSONL session path | Cumulative assistant text from JSONL. |
| Other agents | Screen scraping fallback | Used only when no structured source is validated. |

## Progress and completion

`progress_interval_ms` controls the observe-loop polling cadence. New output is emitted as delta chunks. When there is no new output, the loop emits a Working heartbeat. The turn ends when its stop condition is satisfied.

The stop condition is:

```text
stop = deadline_reached AND (NOT wait_until_idle OR is_idle)
```

Telegram messages are chunked to stay below Telegram limits. Longer output is split into multiple messages.

## Contributing a reader

See [CONTRIBUTING.md](https://github.com/mvallebr/herdr-telegram-plugin/blob/main/CONTRIBUTING.md) for tests and issue-reporting checklist.
