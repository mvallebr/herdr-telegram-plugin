# Phase 2 — PaneManager Refactor Design

Date: 2026-07-30
Branch: `refactor/phase2-pane-manager`
Status: Approved

## Goal

Consolidate pane lifecycle, herdr polling, reconcile, and `state.json` persistence into a `PaneManager`. The daemon stops owning these concerns and reacts to hooks emitted by the manager.

## Approved Model

```text
daemon
  │
  ├── PaneManager
  │     - polls herdr
  │     - detects add / remove / rename
  │     - runs reconcile
  │     - owns state.json
  │     - creates PaneAgent per pane at startup
  │     - emits hooks (onPaneAdded/Removed/Renamed)
  │     - does NOT talk to Telegram
  │
  └── Telegram
```

## Responsibilities

### PaneManager

- Poll herdr at a configurable interval.
- Detect pane add, remove, rename.
- Detect Telegram topic health using `sendChatAction`.
- Persist state to `state.json` exclusively.
- Create one `PaneAgent` per pane at startup.
- Emit lifecycle hooks:
  - `onPaneAdded(paneId)`
  - `onPaneRemoved(paneId)`
  - `onPaneRenamed(paneId, oldLabel, newLabel)`
- Expose:
  - `getPaneAgent(paneId): PaneAgent | undefined`
  - `sync(reason: "startup" | "manual" | "periodic"): Promise<void>`
  - `getMappings(): Map<number, ThreadMapping>`
  - `state()` accessor for read-only inspection
  - `unpair(): Promise<void>`
  - `markUnpaired(): void` (state reset without Telegram calls)

### daemon

- Owns Telegram only.
- Constructor calls `PaneManager.start()` at startup.
- Reacts to hooks to create / delete / rename Telegram topics.
- Forwards user intents to `PaneManager.getPaneAgent(paneId)`.
- Sends `OutputEvent`s from `PaneAgent` to Telegram.

### PaneAgent

Unchanged from Phase 1.

## Lifecycle Hooks

```ts
interface PaneManagerHooks {
  onPaneAdded?: (paneId: string) => void;
  onPaneRemoved?: (paneId: string) => void;
  onPaneRenamed?: (paneId: string, oldLabel: string, newLabel: string) => void;
}
```

The daemon passes these hooks in via the manager constructor.

## Reconciliação

`PaneManager.sync()` runs the existing reconcile logic (from `mapping.ts`) but the result is owned by the manager. The manager updates `state.json` and reacts to add/remove/rename results internally.

## `/unpair` Semantics

`PaneManager.unpair()`:

1. Asks `TelegramCommunicator` (provided via deps) to delete every bot-owned topic.
2. Resets persisted state.
3. Stops the watcher.
4. Emits a single `unpaired` event the daemon can react to.

The daemon must register the unpair call with the manager instead of duplicating the logic.

## Persistence

`PaneManager` reads `state.json` on startup and writes it on every relevant change. The daemon no longer calls `saveState` directly.

## Non-Goals

- No new agents.
- No new cursor/communicator APIs.
- No changes to `PaneAgent` semantics.
- No Telegram retry improvements (Phase 3).
- No `PaneAgent` per-tab optimization (we keep one per pane).

## File Plan

| Change | File |
|---|---|
| New | `src/pane-manager.ts` |
| New | `tests/pane-manager.test.ts` |
| Modified | `src/daemon.ts` |
| Modified | `src/commands.ts` (use paneManager where reasonable) |
| Modified | `tests/e2e/*` (replace watcher with pane-manager mocks) |
| Removed | `src/watcher.ts` |
| Removed | `src/mapping.ts` (logic moves to PaneManager) |
| Removed | `tests/watcher.test.ts` |
| Removed | `tests/mapping.test.ts` |
