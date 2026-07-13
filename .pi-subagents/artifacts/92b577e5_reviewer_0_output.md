Now I have all the evidence needed for the review. Here are the complete findings:

---

## Review: Task 3 (Config + State)

### Spec Compliance

| Requirement | Status | Evidence |
|---|---|---|
| `Config` interface with `botToken`, `chatId`, `throttleMs`, `waitTimeoutS`, `maxTotalWaitS` | ✅ | `src/config.ts:5-12` — all fields present with correct types |
| `loadConfig(configDir?)` returns `Config`, throws if botToken missing | ✅ | `src/config.ts:23` — throws with descriptive error at line 60-62 |
| `Config` file at `~/.config/herdr-telegram/config.toml` | ✅ | `src/config.ts:24` — `path.join(os.homedir(), ".config", "herdr-telegram")` |
| `State` file at `~/.local/state/herdr-telegram/state.json` | ✅ | `src/state.ts:8` — correct path |
| `loadState(stateDir?)` returns `DaemonState` | ✅ | `src/state.ts:6` — signature matches |
| `saveState(stateDir?, state)` void | ✅ | `src/state.ts:19` — signature `(stateDir: string \| undefined, state: DaemonState): void` (functionally equivalent) |
| Empty defaults when state file absent | ✅ | `src/state.ts:11` — returns `{ authorized_chat_id: null, paired_at: null, thread_mappings: {} }` |
| Env var `HERDR_TG_BOT_TOKEN` overrides file | ✅ | `src/config.ts:56` — `process.env.HERDR_TG_BOT_TOKEN \|\| fileBotToken` |
| Env var `HERDR_TG_CHAT_ID` overrides file | ✅ | `src/config.ts:65-67` — `process.env.HERDR_TG_CHAT_ID` checked before `fileChatId` |
| Default values: throttleMs=3000, waitTimeoutS=300, maxTotalWaitS=1800 | ✅ | `src/config.ts:29-31` — exact values |
| Tests pass | ✅ | All 6 tests pass (config: 4, state: 2), 278ms |

### Test Results

```
✓ tests/state.test.ts (2 tests) 3ms
✓ tests/config.test.ts (4 tests) 4ms
Test Files  2 passed (2)
Tests       6 passed (6)
```

### Code Quality: Approved

The implementation is clean, minimal, and follows the brief exactly. The TOML parser is a lightweight inline approach sufficient for the defined config structure. No unnecessary dependencies. TypeScript types are correct and exported.

### Issues Found

**Note (low):** `src/state.ts:18` — `loadState` casts parsed JSON directly to `DaemonState` without validation. If the state file is corrupted or contains unexpected keys, downstream code could encounter runtime errors. Consider adding a runtime schema check or at minimum documenting the trust boundary.

**Note (low):** `src/state.ts:21` — `saveState` uses non-atomic `fs.writeFileSync`. A crash during write could leave a truncated or empty `state.json`. For a daemon state file, risk is low but worth noting.

**Note (low):** `src/config.ts:13-21` — `parseTomlLine` only handles simple `key = "value"` lines. It correctly strips quotes and handles `#` comments. It treats `bot_token` at the top level and `chat_id/throttle_ms/wait_timeout_s/max_total_wait_s` under `[telegram]`. This matches the test expectations but the exact TOML structure (which keys belong in which section) is implicit. Worth documenting the expected config format in a README or doc comment.

**Note (low):** `tests/config.test.ts:16-17` — `beforeEach` mutates `process.env` directly without saving/restoring original values. If Vitest runs files in parallel or a CI environment has these env vars set, test isolation could degrade. Recommended: save original values and restore in `afterEach`.

**Observation:** `DaemonState.thread_mappings` is typed as `Record<number, ThreadMapping>` but JSON round-trips keys as strings. At runtime, JavaScript object keys are always strings, so this is benign — but if future code iterates keys expecting `number`, it may need `Number(key)`. This is a pre-existing type definition issue, not introduced by Task 3.

---