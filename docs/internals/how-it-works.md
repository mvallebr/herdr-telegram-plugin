# How it Works

## Architecture

```text
Telegram
  ▲
  │ daemon only
  ▼
daemon
  │
  ├── Watcher
  │     - syncs herdr tabs ↔ Telegram topics
  │
  └── paneAgents: Map<paneId, PaneAgent>
          │
          ├── AgentCommunicator
          │     - sendInput()
          │     - getNewOutput()
          │     - getLatestOutput()
          │
          └── ObserveLoopController
                - polls communicator
                - owns stop condition
                - emits OutputEvents
```

The daemon is the only component that talks to Telegram. Each Herdr pane with an agent is represented by one `PaneAgent`. A `PaneAgent` owns one `AgentCommunicator` and at most one active `ObserveLoopController`.

## Components

### Daemon (`daemon.ts`)

Long-running Node.js process. Starts a [grammy](https://grammy.dev) bot that listens for Telegram updates and registers command/text handlers. On startup, pairs the bot with an authorized chat and starts the watcher.

The daemon maps Telegram events to pane ids, forwards intents to the corresponding `PaneAgent`, and sends `OutputEvent`s back to Telegram.

### Watcher (`watcher.ts`)

Polls herdr's agent list every 15 seconds. Detects new, renamed, closed, and recreated panes. Syncs detected changes to Telegram by creating/renaming/deleting forum topics. Also runs periodic health checks to detect topics that were deleted manually.

### PaneAgent (`pane-agent.ts`)

One per Herdr pane. Owns the active turn for that pane.

Responsibilities:

- own one `AgentCommunicator`;
- own at most one `ObserveLoopController`;
- start/update/stop the observe loop;
- translate Telegram intents into turn operations.

`PaneAgent` does not communicate with Telegram directly. It emits `OutputEvent`s to the daemon.

### AgentCommunicator (`agent-sessions.ts`)

Interacts with the agent through Herdr and the selected output reader.

Responsibilities:

- resolve the agent session reported by Herdr;
- choose a structured reader or screen scrape once at initialization;
- send input to the agent pane;
- read output snapshots;
- own cumulative diff state.

Key methods:

```ts
sendInput(text: string): void
getNewOutput(): string
getLatestOutput(): string
```

`getNewOutput()` consumes only unseen output and updates the internal diff state. `getLatestOutput()` is a read-only snapshot used by `/last`; it does not consume diff state.

### ObserveLoopController (`turn/observe-loop-controller.ts`)

Runs the active turn.

Responsibilities:

- poll `AgentCommunicator.getNewOutput()`;
- emit Working ticks when there is no new output;
- emit delta chunks when there is new output;
- evaluate the stop condition;
- emit a final event when the turn ends.

It does not know Telegram, `/follow`, or `/last` semantics beyond the stop-condition inputs.

## Turn model

A message and a follow are the same kind of thing: one active turn per pane. What changes is the stop condition.

```text
stop = deadline_reached AND (NOT wait_until_idle OR is_idle)
```

Where:

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
| `/follow 0` | now | unchanged | immediate if no message; otherwise wait idle |
| `/unfollow` after message | always reached | true | idle |

## Data flow for a message

```text
1. User types "what's the status?" in a Telegram topic.
2. Daemon receives the update.
3. Daemon resolves the topic's pane id.
4. Daemon calls paneAgent.handleMessage(text).
5. PaneAgent sends the input via AgentCommunicator.
6. PaneAgent starts an ObserveLoopController if no loop is active.
7. ObserveLoopController polls communicator.getNewOutput().
8. New output is emitted as delta events.
9. Daemon sends those events to Telegram.
10. When the stop condition is satisfied, the controller emits a final event.
```

## Data flow for `/last`

```text
1. User sends /last.
2. Daemon resolves the pane id.
3. Daemon calls paneAgent.getLastOutput().
4. PaneAgent calls communicator.getLatestOutput().
5. Daemon sends the snapshot to Telegram.
6. Diff state is not consumed.
```

## State

Daemon state is persisted to `~/.local/state/herdr-telegram/state.json`:

```json
{
  "authorized_chat_id": 8911510807,
  "thread_mappings": {
    "482": { "pane_id": "w1:p1M", "label": "t1-renamed", "agent": "pi" },
    "520": { "pane_id": "w1:p1K", "label": "pi-optimize", "agent": "opencode" }
  },
  "known_tabs": {
    "w1:t1M": { "label": "t1-renamed", "thread_id": 482 }
  }
}
```

On startup, state is loaded from disk. The watcher keeps it in sync with herdr's actual pane state.
