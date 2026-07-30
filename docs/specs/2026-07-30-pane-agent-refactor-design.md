# PaneAgent Refactor — Phase 1 Design

Date: 2026-07-30
Branch: `refactor/pane-agent`
Status: Approved

## Goal

Replace the current split turn/follow execution model with one active turn per Herdr pane, modeled as a `PaneAgent` that owns one `AgentCommunicator` and at most one `ObserveLoopController`.

Telegram communication remains owned by the daemon. Pane lifecycle and mapping state are owned by a `PaneManager`.

## Approved Model

```text
Telegram
  ▲
  │ daemon only
  ▼
daemon
  │
  ├── Telegram communication
  │
  └── PaneManager
        │
        ▼
     PaneAgent (one per Herdr pane)
        │
        ├── AgentCommunicator
        │
        └── ObserveLoopController (at most one active)
```

## Responsibilities

### daemon

- Owns all Telegram communication.
- Maps Telegram events to pane ids via PaneManager.
- Forwards user intents to PaneAgent:
  - message
  - follow
  - unfollow
  - stop
  - last
- Receives OutputEvents from PaneAgent/ObserveLoopController and sends them to Telegram.
- Reacts to PaneManager lifecycle hooks to create/remove Telegram topics.

### PaneManager

- Owns Herdr pane truth.
- Creates PaneAgent instances at startup for known panes.
- Detects pane add/remove/rename via existing watcher/reconcile logic.
- Persists thread/pane mapping/state.
- Emits lifecycle hooks to daemon.
- Does not communicate with Telegram.

### PaneAgent

- One per Herdr pane.
- Owns one AgentCommunicator.
- Owns at most one ObserveLoopController.
- Translates user intents into loop lifecycle and stop-condition updates.
- Does not communicate with Telegram.

### AgentCommunicator

- Interacts with the agent via Herdr and structured/scrape readers.
- Owns output diff state (`sentTail`).
- Methods:
  - `sendInput(text: string): void`
  - `getNewOutput(): string`
  - `getLatestOutput(): string`
- `getNewOutput()` consumes unseen output and updates diff state.
- `getLatestOutput()` returns a readback snapshot and does not consume diff state.

### ObserveLoopController

- Polls `AgentCommunicator.getNewOutput()`.
- Owns the turn stop condition.
- Emits OutputEvents:
  - working
  - delta
  - final
- Does not communicate with Telegram.
- Does not know follow semantics beyond stop-condition parameters.

## Stop Condition

```text
stop = deadline_reached AND (NOT wait_until_idle OR is_idle)
```

Definitions:

```text
deadline_reached = now >= deadline
wait_until_idle = a user message arrived during the active turn
is_idle = no new agent output for stabilityMs
```

Cases:

| scenario | deadline | wait_until_idle | stop condition |
|---|---|---|---|
| message only | always reached | true | idle |
| follow only | now + N | false | deadline |
| follow + message | now + N | true | deadline AND idle |
| unfollow after message | always reached | true | idle |
| `/follow 0` | now | unchanged | immediate if no message; otherwise wait idle |

### Event Semantics

```text
message, no active loop:
  send input
  start loop
  wait_until_idle = true
  deadline = always reached
  stop = idle

message, active loop:
  send input
  wait_until_idle = true
  loop continues

/follow N, no active loop:
  start loop
  deadline = now + N
  wait_until_idle = false
  stop = deadline

/follow N, active loop:
  deadline = now + N
  loop continues

/follow 0:
  deadline = now

/unfollow:
  deadline = always reached
  wait_until_idle unchanged

/stop:
  abort loop

/last:
  return communicator.getLatestOutput()
```

## Output Events

```ts
type OutputEvent =
  | { type: "working"; text: string }
  | { type: "delta"; text: string }
  | { type: "final"; text: string; reason: "idle" | "deadline" | "aborted" | "pane-removed" };
```

Final payload:

- Use the most recent emitted delta if present.
- Otherwise use the latest snapshot, truncated safely.

## Phase 1 Scope

Included:

- `PaneAgent`.
- `AgentCommunicator.getNewOutput/getLatestOutput`.
- `ObserveLoopController` extracted from current observe-loop.
- daemon using PaneAgent for turn/follow/stop/last.
- remove `runAgentTurn`, `runAgentFollowLoop`, `TurnDispatcher`, and `FollowCoordinator` if present.
- keep existing watcher/reconcile behavior working.

Not included:

- full migration of watcher/reconcile internals into PaneManager.
- improved Telegram sync retry.
- new persistence semantics.

## Non-Goals

- No Telegram access from PaneAgent/AgentCommunicator/ObserveLoopController.
- No parallel loops per pane.
- No follow-specific background loop separate from turn loop.
- No infinite follow; `/follow 0` ends immediately.
