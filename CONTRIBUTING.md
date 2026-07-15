# Contributing

Thanks for improving the bridge.

## Local development

```bash
npm install
npm test
npm run docs:build
```

The plugin can be linked to a local Herdr installation with `herdr plugin link .`.
Do not commit bot tokens, chat IDs, session logs, or `~/.config/herdr-telegram` state.

## Adding an agent wrapper

Keep agent-specific behavior behind the `AgentWrapper` seam:

1. Implement `submit(prompt)` and `status()` in `src/agent-wrappers.ts` or a dedicated adapter.
2. Return facts only: `working` with an optional safe preview, `final`, or `failed`.
3. Keep polling cadence and Telegram formatting in `TurnCoordinator` and `TelegramTurnReporter`.
4. Add unit tests with mocked Herdr/Telegram dependencies.
5. Update the support matrix in the documentation.

## Reporting an issue

Open a [GitHub issue](https://github.com/mvallebr/herdr-telegram-plugin/issues/new) with:

- Herdr version and agent type;
- whether the agent uses a session log or screen scraping;
- sanitized daemon status and relevant log lines;
- expected and actual Telegram messages;
- steps to reproduce.

Never include bot tokens, private chat IDs, or unredacted session logs.
