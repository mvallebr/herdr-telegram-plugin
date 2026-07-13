# Task for reviewer

Review Task 3 (config + state).

READ:
1. Brief: /home/mvallebr/git/herdr-telegram-plugin/.superpowers/sdd/task-3-brief.md
2. Diff: /home/mvallebr/git/herdr-telegram-plugin/.superpowers/sdd/review-4d63e9b..19f60a9.diff

GLOBAL CONSTRAINTS:
- config.ts: loadConfig(configDir?) returns Config { botToken, chatId, throttleMs, waitTimeoutS, maxTotalWaitS }
- state.ts: loadState(stateDir?) returns DaemonState, saveState(stateDir?, state) void
- Config file: ~/.config/herdr-telegram/config.toml
- State file: ~/.local/state/herdr-telegram/state.json

DELIVER: spec compliance (✅/❌), code quality (Approved/Issues), issues with severity.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```