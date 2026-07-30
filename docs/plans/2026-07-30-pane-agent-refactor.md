# PaneAgent Refactor Implementation Plan

Date: 2026-07-30
Branch: `refactor/pane-agent`
Spec: `docs/specs/2026-07-30-pane-agent-refactor-design.md`

## Goal

Implement Phase 1: one PaneAgent per Herdr pane, owning one AgentCommunicator and at most one ObserveLoopController. Telegram stays in daemon.

## Global Constraints

- Do not break existing pane discovery/reconcile/topic behavior.
- No Telegram dependency in PaneAgent, AgentCommunicator, or ObserveLoopController.
- At most one observe loop per pane.
- Follow and message are one turn with different stop conditions.
- `/last` must not consume diff state.
- Node 22, TypeScript ESM, Vitest.

---

## Task 1: Add stop-condition model

Files:
- Create `src/turn/stop-condition.ts`
- Test `tests/turn/stop-condition.test.ts`

Implement:

```ts
export interface StopState {
  now: number;
  lastChangeAt: number;
  stabilityMs: number;
  deadline: number | null; // null means always reached
  waitUntilIdle: boolean;
}

export function isDeadlineReached(state: StopState): boolean {
  return state.deadline === null || state.now >= state.deadline;
}

export function isIdle(state: StopState): boolean {
  return state.now - state.lastChangeAt >= state.stabilityMs;
}

export function shouldStop(state: StopState): boolean {
  return isDeadlineReached(state) && (!state.waitUntilIdle || isIdle(state));
}
```

Tests:
- message only stops when idle.
- follow only stops at deadline even if idle earlier.
- follow + message stops only after deadline AND idle.
- `/follow 0` deadline now stops immediately if no waitUntilIdle.
- unfollow after message keeps waitUntilIdle and stops when idle.

---

## Task 2: Move diff state into AgentCommunicator

Files:
- Modify `src/agent-sessions.ts`
- Test `tests/agent-sessions.test.ts` or new `tests/communicator-diff.test.ts`

Add to `AgentCommunicator`:

```ts
private sentTail = "";
private initialized = false;

getNewOutput(): string {
  const snapshot = this.getAgentOutput(4000);
  if (!this.initialized) {
    this.sentTail = tailOf(snapshot, SENT_TAIL_MAX);
    this.initialized = true;
    return "";
  }
  const unseen = deriveUnseen(snapshot, this.sentTail);
  if (unseen.length > 0) {
    this.sentTail = tailOf(snapshot, SENT_TAIL_MAX);
  }
  return unseen;
}

getLatestOutput(): string {
  return this.getAgentOutput(4000);
}
```

Move/export `deriveUnseen`, `tailOf`, `SENT_TAIL_MAX` from observe-loop into a shared module (e.g. `src/output-diff.ts`) so communicator and loop can share without circular deps.

Tests:
- first call returns empty baseline.
- later call returns only unseen.
- getLatestOutput does not change subsequent getNewOutput.

---

## Task 3: Create ObserveLoopController

Files:
- Create `src/turn/observe-loop-controller.ts`
- Modify/remove old `src/observe-loop.ts` internals as needed
- Test `tests/turn/observe-loop-controller.test.ts`

Controller shape:

```ts
export type OutputEvent =
  | { type: "working"; text: string }
  | { type: "delta"; text: string }
  | { type: "final"; text: string; reason: "idle" | "deadline" | "aborted" };

export interface ObserveLoopControllerDeps {
  communicator: AgentCommunicator;
  emit: (event: OutputEvent) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  progressIntervalMs: number;
  stabilityMs: number;
}

export class ObserveLoopController {
  constructor(deps: ObserveLoopControllerDeps)
  start(): Promise<void>
  updateDeadline(deadline: number | null): void
  markUserInput(): void
  abort(reason?: "aborted"): void
  get done(): Promise<void>
}
```

Behavior:
- poll communicator.getNewOutput()
- if unseen: chunk into delta events
- if no unseen: emit working tick according to cadence
- evaluate shouldStop()
- on stop emit final with last delta or latest snapshot

Tests:
- emits delta chunks and no duplicate baseline.
- emits working ticks when no new output.
- stops by idle.
- stops by deadline when no waitUntilIdle.
- stops by deadline AND idle when waitUntilIdle.
- abort emits final aborted.

---

## Task 4: Create PaneAgent

Files:
- Create `src/pane-agent.ts`
- Test `tests/pane-agent.test.ts`

Shape:

```ts
export class PaneAgent {
  constructor(opts: {
    paneId: string;
    communicator: AgentCommunicator;
    emit: (event: OutputEvent) => void;
    config: Config;
    deps?: { sleep; now };
  })

  handleMessage(text: string): void
  enableFollow(deadline: number): void
  disableFollow(): void
  stop(): void
  getLastOutput(): string
  dispose(): void
}
```

Behavior:
- no active loop: handleMessage starts loop with waitUntilIdle=true, deadline=null (always reached)
- active loop: handleMessage sends input and markUserInput()
- enableFollow: start loop if absent or updateDeadline
- disableFollow: updateDeadline(null)
- stop: abort loop
- getLastOutput: communicator.getLatestOutput()
- dispose: abort loop

Tests:
- one loop only after message + follow.
- follow after message updates deadline, not new loop.
- message during follow marks waitUntilIdle.
- unfollow keeps loop if waitUntilIdle, stop condition becomes idle.
- dispose aborts loop.

---

## Task 5: Wire daemon to PaneAgent

Files:
- Modify `src/daemon.ts`
- Modify or remove `src/wait-loop.ts` if only used for old turn/follow runners
- Modify `src/commands.ts` for /last and follow commands as needed
- Adjust e2e tests

Behavior:
- daemon keeps map paneId -> PaneAgent (or PaneManager in later phase; Phase 1 can store Map directly if PaneManager not introduced).
- message handler:
  - resolve paneId
  - paneAgent.handleMessage(text)
- /follow:
  - paneAgent.enableFollow(now + minutes)
- /unfollow:
  - paneAgent.disableFollow()
- /stop:
  - paneAgent.stop()
- /last:
  - paneAgent.getLastOutput()
- output events:
  - daemon formats and sends via Telegram client.

Tests:
- update e2e turn-flow tests to use PaneAgent events.
- ensure duplicate follow loop test now passes by single-loop invariant.

---

## Task 6: Remove obsolete execution seams

Files:
- Remove `runAgentTurn` / `runAgentFollowLoop` if unused.
- Remove `TurnDispatcher` if unused.
- Remove `FollowCoordinator` if present/unused.
- Remove old observe-loop function if replaced by controller.

Tests:
- delete or migrate obsolete tests.
- full suite green.

---

## Task 7: Verification

Commands:

```bash
npm test
npm run typecheck
npm run build
```

Manual local verification:
- restart daemon.
- send Telegram message: one turn, chunks, final.
- /follow during turn: no duplicate Working ticks.
- /last: no diff consumption.
- /unfollow: no unexpected loop promotion.
