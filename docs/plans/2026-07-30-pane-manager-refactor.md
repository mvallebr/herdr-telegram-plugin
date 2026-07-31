# Phase 2 — PaneManager Implementation Plan

Date: 2026-07-30
Branch: `refactor/phase2-pane-manager`
Spec: `docs/specs/2026-07-30-pane-manager-refactor-design.md`

## Goal

Move pane lifecycle, reconcile, watcher, and state persistence into a `PaneManager`. The daemon reacts to hooks and owns Telegram only.

## Global Constraints

- Do not break existing Telegram semantics.
- Do not introduce new agent types.
- No Telegram access from `PaneManager`.
- `PaneAgent` semantics stay unchanged.

---

## Task 1: Scaffold PaneManager

Files:
- Create `src/pane-manager.ts`
- Test `tests/pane-manager.test.ts`

Description:
- Class accepts deps: `getAgents`, `loadState`, `saveState`, `agentFactory`, `hooks?`, `logger`.
- Constructor builds the `state` snapshot from `loadState`.
- `getPaneAgent(paneId)` lazily creates the `PaneAgent`.
- `state()` returns a read-only snapshot.
- `mappings()` returns the current `Map<number, ThreadMapping>`.

Tests:
- `getPaneAgent` returns the same instance for the same pane id.
- `state()` returns the values loaded from `loadState`.
- `mappings()` returns the existing state.mappings.

---

## Task 2: Reconcile inside PaneManager

Files:
- Modify `src/pane-manager.ts`
- Test `tests/pane-manager.test.ts`

Description:
- Move the body of `reconcile` from `src/mapping.ts` into `PaneManager.sync()`.
- The manager no longer touches Telegram; it just updates the in-memory state.
- Persist on each successful sync.
- `sync` returns a `SyncResult { added: string[], removed: string[], renamed: string[] }` for the daemon to act on.

Tests:
- `sync` adds new panes to state.
- `sync` removes missing panes from state.
- `sync` updates labels on rename.
- `sync` persists state via `saveState`.

---

## Task 3: Herdr polling integration

Files:
- Modify `src/pane-manager.ts`
- Test `tests/pane-manager.test.ts`

Description:
- `start()` calls `poll()` immediately and then on a configurable interval.
- `poll()` invokes `sync()` and emits the lifecycle hooks.
- `stop()` clears the interval.

Tests:
- `start` schedules repeated polls.
- `stop` clears the timer.
- Emits `onPaneAdded` when a new pane appears.
- Emits `onPaneRemoved` when a pane disappears.
- Emits `onPaneRenamed` when a label changes.

---

## Task 4: Health check

Files:
- Modify `src/pane-manager.ts`
- Test `tests/pane-manager.test.ts`

Description:
- The manager does not call Telegram; it exposes a `healthCheck({chatId, sendChatAction})` helper that the daemon calls.
- The helper returns a list of `recreated: { tabId, threadId }` entries.
- The daemon performs the actual `createForumTopic` and updates the manager state via `restoreTopic(tabId, threadId)`.

Tests:
- `healthCheck` returns the list of topics that failed.
- `restoreTopic` updates `known_tabs` and `thread_mappings`.

---

## Task 5: unpair

Files:
- Modify `src/pane-manager.ts`
- Test `tests/pane-manager.test.ts`

Description:
- `unpair({ deleteTopic })` walks the union of `known_topics` + `thread_mappings`, calls `deleteTopic` for each, and resets state.
- `markUnpaired()` resets state without Telegram calls.

Tests:
- `unpair` deletes every bot-owned topic.
- `markUnpaired` only resets state.

---

## Task 6: Wire daemon

Files:
- Modify `src/daemon.ts`
- Modify `src/commands.ts`
- Modify `src/index.ts`

Description:
- Daemon constructs `PaneManager` with the agent factory and hooks.
- Hooks call Telegram APIs to create/delete/rename topics.
- `getPaneAgent` helper replaces the inline `Map<paneId, PaneAgent>` in daemon.
- Deps `watcher.start/stop` removed; `paneManager.start/stop` replaces them.

Tests:
- Update `tests/e2e/*` to instantiate `PaneManager` directly.
- Ensure full `npm test` is green.

---

## Task 7: Remove obsolete modules

Files:
- Delete `src/watcher.ts`
- Delete `src/mapping.ts`
- Delete `tests/watcher.test.ts`
- Delete `tests/mapping.test.ts`

Description:
- Verify no remaining imports.
- Remove any tests that depend on the deleted modules.

Tests:
- `npm test` is green.

---

## Task 8: Verification

Commands:
- `npm test`
- `npm run typecheck`
- `npm run build`

Manual:
- Restart daemon.
- Send Telegram message.
- `/reconcile`, `/follow`, `/unfollow`, `/last`, `/stop`.
- Confirm only known pane threads exist.
