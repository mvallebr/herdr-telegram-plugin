# Task for reviewer

Review Task 1 (project scaffolding) of herdr-telegram-plugin.

READ THESE FILES:
1. Brief: /home/mvallebr/git/human_infra/.superpowers/sdd/task-1-brief.md
2. Report: /home/mvallebr/git/human_infra/.superpowers/sdd/task-1-report.md
3. Diff: /home/mvallebr/git/herdr-telegram-plugin/.superpowers/sdd/review-d9f50a7..8f0fbea.diff

GLOBAL CONSTRAINTS:
- Node.js 18+ runtime
- herdr 0.7+
- Plugin manifest must use [[build]] for npm ci and tsc
- herdr min_herdr_version = "0.7.0"
- Project is ES module ("type": "module" in package.json)

DELIVER:
- Spec compliance verdict (✅/❌): each requirement in brief met?
- Code quality verdict (Approved/Issues): issues found?
- Issues list with severity (Critical/Important/Minor)

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