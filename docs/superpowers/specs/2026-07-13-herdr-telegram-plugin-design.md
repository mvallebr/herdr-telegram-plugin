# herdr-telegram-plugin — Design

**Date:** 2026-07-13
**Status:** Approved (pending spec review)
**Author:** Marcelo Valle (via brainstorming with AI assistant)
**Repository:** https://github.com/mvallebr/herdr-telegram-plugin
**License:** MIT

---

## 1. Context & Motivation

Marcelo uses [herdr](https://herdr.dev) as his agent multiplexer — a tmux-style terminal workspace where Pi, Claude Code, Codex, and other agents run in persistent PTY panes on a server. He wants to control those agents from his phone via Telegram, but the existing solution (`@llblab/pi-telegram`) had architectural problems that consumed his Claude Max plan's 5-hour usage window in a single session (see [llblab/pi-telegram#127](https://github.com/llblab/pi-telegram/issues/127)).

This plugin is a from-scratch replacement that treats Telegram as a **remote control** over herdr, not as a parallel agent instance. Every Telegram turn maps 1:1 to a herdr pane; the Telegram bridge adds zero LLM cost — it is pure PTY I/O via herdr's existing CLI/socket API.

## 2. Goals & Non-Goals

### Goals

- **Single-user**: One Telegram chat authorizes one bot. No multi-user complexity.
- **Zero LLM cost**: The bridge reads/writes PTY buffers. It never invokes a model.
- **Agent-agnostic**: Works with any agent herdr supports (Pi, Claude Code, Codex, OpenCode, etc). Not coupled to Pi.
- **Forum-topic routing**: Each pane with an agent = one Telegram topic. Message in topic goes to pane. Output from pane goes to topic.
- **Minimal setup**: Install plugin, drop token in config file, pair via `/pair`, done.
- **Marketplace-ready**: Discoverable via herdr's automatic marketplace index (`herdr-plugin` GitHub topic).

### Non-Goals

- Multi-user / multi-chat authorization (single-user only).
- Webhook mode (Telegram pushes via HTTP). Long-polling only.
- Markdown / voice / button interactions in Telegram (text + inline buttons for blocked-approval only).
- Streaming of partial output (we send periodic snapshots, not character-level streaming).
- Cross-platform packaging (Linux-only; macOS/Windows handled later if needed).
- Replacing the herdr-remote relay ecosystem (we coexist; herdr-remote solves different problems — multi-client dashboard).

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│           herdr-telegram-plugin (Node + TS)             │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Plugin entry  (invoked by herdr under events)     │ │
│  │  - herdr-plugin.toml:                              │ │
│  │    [[events]] on = "pane.agent_status_changed"     │ │
│  │    command = ["node", "dist/plugin.js"]            │ │
│  │  - Checks PID file; spawns daemon if not running   │ │
│  │  - Exits immediately                               │ │
│  └────────────────┬───────────────────────────────────┘ │
│                   │ spawn (nohup, detached)             │
│                   ▼                                     │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Daemon  (long-running, polls Telegram)           │ │
│  │  - grammy long-polling getUpdates (~30s timeout)  │ │
│  │  - In-memory: { thread_id → pane metadata }       │ │
│  │  - Loop: msg → thread_id → pane → send-text →     │ │
│  │    agent wait idle → pane read → Telegram msg      │ │
│  │  - Throttle: 3s min between updates                │ │
│  │  - PID file at $HERDR_PLUGIN_STATE_DIR/daemon.pid │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
└─────────────────────────────────────────────────────────┘
         │                                       │
         ▼                                       ▼
   api.telegram.org                     herdr CLI / socket
   (Bot API)                            (herdr agent list, pane send-text,
                                         pane read, agent wait, etc)
```

**Two processes, one package**:
- **Plugin entry** is invoked by herdr on `pane.agent_status_changed` events. Its only job is to ensure the daemon is running (spawn if not).
- **Daemon** does all the actual work: long-polls Telegram, talks to herdr via `herdr` CLI subprocess.

This separation is necessary because herdr plugins are event-driven (invoked under demand), but Telegram bridge needs continuous polling.

## 4. Decisions (with rationale)

| Decision | Rationale |
|---|---|
| **Node.js + TypeScript** | Robust, type safety, grammy is TS-native |
| **Model B for deps** (npm via `[[build]]`) | User preference for "robust"; 50MB `node_modules` is negligible vs ecosystem benefit |
| **Plugin herdr formal** | Marketplace-ready, integrates with herdr lifecycle, no separate daemon-installer friction |
| **Plugin spawns daemon** (vs. daemon-only or two-process orchestration) | Single package, single source of truth, daemon lifecycle tied to plugin |
| **Agent-only mapping** (no topic for shell/vim panes) | User's actual workflow has agents in all real tabs; bash-only tabs are exceptions |
| **Topic → pane 1:1 routing** | Zero ambiguity; matches Telegram's mental model for forum groups |
| **Sync wait+read** for output | Simpler than async polling diff; user accepted that long waits become streaming updates |
| **Messages separated** (vs. progressive edits) | Simpler conceptually; user prefers over edited-message approach |
| **In-memory mapping** (no persist file for mapping) | Reconcile from herdr+Telegram on startup; no drift risk |
| **Pairing via `/pair`** (vs. hardcoded chat_id) | User remembered pi-telegram didn't need it; auto-discover is simpler |
| **Single config path** `~/.config/herdr-telegram/config.toml` | XDG Base Directory standard, matches herdr's own layout |

## 5. Setup

### 5.1 User steps (minimal)

```bash
# 1. Create bot via @BotFather (one-time, in Telegram app)
#    - /newbot, pick name + username, copy bot_token

# 2. Install plugin
herdr plugin install github.com/mvallebr/herdr-telegram-plugin

# 3. Add bot to your forum group, enable Topics in group settings

# 4. Create config file (one line)
mkdir -p ~/.config/herdr-telegram
echo 'bot_token = "YOUR_BOT_TOKEN"' > ~/.config/herdr-telegram/config.toml

# 5. Trigger daemon spawn (or wait for any herdr event)
herdr plugin action invoke herdr-telegram-plugin.bootstrap

# 6. In Telegram: send any message in the group
#    Bot responds: "🔒 Mande /pair pra autorizar"
#    Send /pair
#    Bot responds: "✅ Chat autorizado. Mapeando tabs..."

# Done. Plugin is paired and running.
```

### 5.2 Config file format

**Required** (`~/.config/herdr-telegram/config.toml`):
```toml
bot_token = "8676204842:AAEd5D1JOp99QvQGZleLZ43j4YFwGq3QNLI"
```

**Optional** (`[telegram]` section, with defaults):
```toml
bot_token = "..."
[telegram]
chat_id = -1001234567890       # Pre-authorize without /pair (skips pairing)
throttle_ms = 3000              # Min ms between progress messages (default 3000)
wait_timeout_s = 300            # Max wait per agent turn (default 300 = 5 min)
max_total_wait_s = 1800         # Max cumulative wait (default 1800 = 30 min)
```

Env-var override: `HERDR_TG_BOT_TOKEN` (and `HERDR_TG_CHAT_ID`) take precedence over file.

### 5.3 State file (runtime, auto-managed)

**Path**: `$XDG_STATE_HOME/herdr-telegram/state.json` (default: `~/.local/state/herdr-telegram/state.json`)

```json
{
  "authorized_chat_id": -1001234567890,
  "paired_at": "2026-07-13T12:00:00Z",
  "thread_mappings": {
    "140": { "pane_id": "w1:pZ", "label": "Echo", "agent": "pi", "created_at": "..." },
    "142": { "pane_id": "w1:p1F", "label": "Fjord", "agent": "codex", "created_at": "..." }
  }
}
```

User may delete this file to force re-pairing.

## 6. Pairing Protocol

**States**:
- `unpaired`: No `authorized_chat_id` in state file. Bot responds to `/pair` from any chat.
- `paired`: `authorized_chat_id` present. Bot only responds to that chat.

**Transitions**:

1. Daemon starts. Reads `state.json`. If absent or `authorized_chat_id` missing → `unpaired` mode.
2. `unpaired` mode: any incoming update → bot replies once "🔒 Mande /pair pra autorizar este chat". Subsequent updates from same chat are ignored until `/pair` arrives.
3. `/pair` command received:
   - Validate: bot is admin in chat; `chat.is_forum === true` (Topics enabled).
   - Persist `chat.id` → `state.json`.
   - Send "✅ Chat autorizado. Mapeando tabs...".
   - Trigger reconciliation: enumerate herdr panes with agents, create Telegram topics for those without one.
   - Switch to `paired` mode.

**Re-pairing** (user wants different group):
- Delete `state.json`, restart daemon, repeat pairing flow.
- OR send `/pair` in the new group; daemon prompts for confirmation in old group first (anti-hijack).

## 7. Mapping Reconciliation

On daemon startup and after pairing:

```
1. herdr agent list --json
   → [ { pane_id, label, agent, status, ... }, ... ]

2. Telegram getForumTopics (in authorized chat)
   → [ { message_thread_id, name, ... }, ... ]

3. Match by label (case-insensitive, normalized):
   for pane in herdr:
     topic = find_topic_by_name(pane.label, telegram_topics)
     if topic: record mapping pane → topic
     else: create topic with name = pane.label → record mapping

4. Orphan topics (no matching pane): ignored (logged). User can delete manually.

5. Orphan panes (no topic): create topic + map.
```

**Result**: in-memory `Map<thread_id, {pane_id, label, agent}>`. Persisted in `state.json` for inspection, but rebuilt on each startup from authoritative sources.

## 8. Behavior

### 8.1 Input (Telegram → pane)

Plain text in any topic:
1. Receive update. Validate `chat.id == authorized_chat_id`. If not → ignore (paired mode) or reply with pairing prompt (unpaired mode).
2. Resolve `message_thread_id → pane_id` from in-memory mapping.
3. If no mapping: reply "Topic sem pane correspondente. Rode `/agents` pra ver o estado."
4. `herdr pane send-text <pane_id> <text>` (injects as if typed at terminal).

Command (starts with `/`): dispatched to command handler (see §9).

### 8.2 Output (pane → Telegram)

After send-text:

```
loop:
  result = herdr agent wait <pane_id> --status idle --timeout 300s
  
  if result.status == "idle":
    content = herdr pane read <pane_id> --source recent --lines 200 --format text
    send_telegram_message("✅ <label> (<elapsed>):\n\n<content>")
    break
  
  if result.status == "blocked":
    content = herdr pane read <pane_id> --source recent --lines 30 --format text
    send_telegram_message("⚠️ <label> blocked (tool approval):\n\n<content>", {
      reply_markup: { inline_keyboard: [[
        { text: "Trust (always)", callback_data: "trust" },
        { text: "Deny", callback_data: "deny" }
      ]]}
    })
    wait for callback → on Trust: send-text "trust, always allow", continue loop
                       → on Deny: send-text "no (tab to edit)", break
  
  if timeout (still working):
    if elapsed > max_total_wait_s: break with error message
    content = herdr pane read <pane_id> --source recent --lines 15 --format text
    send_telegram_message("⏳ <label> working (<elapsed>):\n\n<content>")
    sleep throttle_ms; continue loop
```

**Throttling**: 3s minimum between messages. Prevents Telegram rate limits (30 msg/s globally, 1 msg/s per chat).

### 8.3 Error handling

| Condition | Behavior |
|---|---|
| Token invalid / 401 from Telegram | Log fatal, exit 1. User must fix token and restart. |
| herdr not running | Retry subprocess with backoff (1s, 2s, 4s, max 30s). Log. Continue. |
| Pane disappeared during wait | Send "⚠️ Pane <label> sumiu durante execução", end wait loop. |
| Telegram 429 (rate limit) | Honor `retry_after` from response. Log. |
| Bot demoted from admin | Log error. Continue (bot can still read messages but can't create topics). |
| Mapping conflict (same label, two panes) | Create both topics with suffix `-2` for the second. Log. |

## 9. Commands

All commands work in any topic. The topic provides context (which pane is targeted for some commands).

| Command | Behavior |
|---|---|
| `/help` | List available commands with brief descriptions. |
| `/agents` | List panes with agents: `Echo (pi, idle) → topic 140`, etc. Inline buttons: [Open]. |
| `/status` | Bridge uptime, authorized chat_id (last 4 digits), panes count, last update timestamp. |
| `/interrupt` | Send Ctrl+C to the pane of the current topic. |
| `/trust` | Send "trust, always allow" to the pane of the current topic. Useful when blocked notifications have no buttons or user is in different chat. |
| `/digest` | Today's activity summary: time working per pane + blocked count + last seen. |

Plain text (no `/`): routed to pane of current topic as `send-text`.

## 10. File Structure

```
herdr-telegram-plugin/
├── herdr-plugin.toml          # Plugin manifest (Modelo B with [[build]])
├── package.json               # grammy + dev deps (typescript, @types/node)
├── tsconfig.json              # TS strict mode, target ES2022
├── README.md                  # Setup, commands, troubleshooting
├── LICENSE                    # MIT (auto-generated by gh)
├── .gitignore                 # dist/, node_modules/, .env
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-07-13-herdr-telegram-plugin-design.md  # this file
├── src/
│   ├── index.ts               # Entry: routes to --daemon or --plugin mode
│   ├── daemon.ts              # grammy polling loop
│   ├── plugin.ts              # Spawns daemon if not running
│   ├── mapping.ts             # In-memory + reconcile logic
│   ├── telegram-client.ts     # Grammy wrappers for forum topics
│   ├── herdr-client.ts        # Wraps `herdr` CLI subprocess calls
│   ├── commands.ts            # /help /agents /status /interrupt /trust /digest
│   ├── wait-loop.ts           # Sync wait+read+throttle logic
│   ├── pairing.ts             # Pairing state machine
│   ├── config.ts              # Loads ~/.config/herdr-telegram/config.toml + env
│   ├── state.ts               # Reads/writes $XDG_STATE_HOME/.../state.json
│   ├── logger.ts              # Structured logging
│   └── types.ts               # Shared TS types
└── dist/                      # tsc output (gitignored)
```

## 11. Dependencies

### Runtime

- **`grammy`** ^1.44 — Telegram Bot framework
- **`@grammyjs/types`** ^3.28 — TypeScript types for Telegram objects (transitive via grammy)

### Build/dev

- **`typescript`** ^5.4
- **`@types/node`** ^22
- **`ts-node`** (optional, for dev mode)

### Build steps in `herdr-plugin.toml`

```toml
[[build]]
command = ["npm", "ci"]
platforms = ["linux", "macos", "windows"]

[[build]]
command = ["npx", "tsc"]
platforms = ["linux", "macos", "windows"]
```

`npm ci` is deterministic install from lockfile. `tsc` compiles `src/*.ts` → `dist/*.js`. Manifest entries point to `dist/`.

## 12. Security

- **Single chat_id whitelist**: only authorized chat can interact. Updates from other chats ignored.
- **Pairing requires bot admin + Topics**: validates environment before authorizing.
- **No secrets in repo**: config file is `~/.config/herdr-telegram/config.toml` (user-local, never committed).
- **Token in env or config**: not in code, not in logs (logger redacts).
- **No third-party data egress**: plugin talks only to `api.telegram.org` and `herdr` CLI.
- **Dependency surface**: only `grammy` (+ transitive). Auditable.

## 13. Testing Strategy (initial)

- **Unit tests**: Vitest for `mapping.ts`, `config.ts`, `state.ts`, `commands.ts` (mocking herdr/telegram).
- **Integration smoke**: Manual. Daemon connects to a test Telegram chat, herdr with a fake pane.
- **No E2E automation in v1**: User accepts manual verification on first install.

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Telegram rate limits during long waits | Throttling (3s); honor `retry_after`. |
| herdr version changes CLI output format | Pin to tested herdr version in `min_herdr_version`; surface parsing errors loudly. |
| Pane label collisions (two "Echo" tabs) | Suffix `-2`, `-3`, etc. Log warning. |
| Pairing with wrong chat (user mistakes) | Re-pair requires confirmation in old chat, OR manual state.json delete. |
| Build fails in user's environment | Show exact error from `npm ci` / `tsc`. Document minimum Node version (18+). |
| Daemon crashes silently | PID file becomes stale; next plugin entry detects and respawns. |

## 15. References

- [herdr documentation](https://herdr.dev/docs)
- [herdr plugins docs](https://herdr.dev/docs/plugins/)
- [herdr socket API](https://herdr.dev/docs/socket-api/)
- [herdr-remote (herdr-remote by dcolinmorgan)](https://github.com/dcolinmorgan/herdr-remote) — reference for Telegram bridge shape
- [ogulcancelik/herdr-plugin-examples/agent-telegram-notify](https://github.com/ogulcancelik/herdr-plugin-examples/tree/main/agent-telegram-notify) — reference for plugin structure with zero deps
- [grammy docs](https://grammy.dev)
- [Telegram Bot API: Forum Topics](https://core.telegram.org/bots/api#forum)
- [llblab/pi-telegram#127](https://github.com/llblab/pi-telegram/issues/127) — motivation for this plugin

---

## Open questions (none blocking)

All design decisions resolved during brainstorming. Implementation plan will be generated next via writing-plans skill.