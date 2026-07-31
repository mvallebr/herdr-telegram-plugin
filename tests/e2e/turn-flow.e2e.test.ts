/**
 * End-to-end tests for the daemon's turn flow. We:
 *   1. Replace the `herdr` binary with a mock that returns a controlled
 *      sequence of pane reads.
 *   2. Start the real daemon with `skipTelegramStart: true` so the bot
 *      does not poll the real Telegram network; we dispatch synthetic
 *      updates via the exposed `daemon.tg.bot.handleUpdate`.
 *   3. Patch `TelegramClient.prototype.sendMessage`,
 *      `setMessageReaction`, `answerCallbackQuery` to capture every call
 *      without ever touching the network.
 *   4. Assert that the captured sequence is Working tick(s) → pane
 *      delta(s) → Final consolidated, with the Final containing the last
 *      emitted delta (not the raw pane content).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Update } from "grammy";
import { startDaemon } from "../../src/daemon.js";
import { resetHerdrBinCache } from "../../src/herdr-client.js";
import { TelegramClient } from "../../src/telegram-client.js";
import { PaneManager } from "../../src/pane-manager.js";
import { MockHerdr } from "./herdr-mock.js";

const PANE_ID = "w1:p1";
const THREAD_ID = 140;
const CHAT_ID = 8911510807;

interface CapturedSend {
  chatId: number;
  threadId: number;
  text: string;
  reply_markup?: unknown;
}
interface CapturedReaction {
  chatId: number;
  messageId: number;
  reactions: Array<{ type: "emoji"; emoji: string }>;
}
interface CapturedCallbackAnswer {
  callbackQueryId: string;
  text: string;
}

const capture = {
  sent: [] as CapturedSend[],
  reactions: [] as CapturedReaction[],
  callbackAnswers: [] as CapturedCallbackAnswer[],
};

function patchTelegramClientPrototype(): void {
  // The daemon's emitPaneEvent handler calls tg.sendMessage directly
  // (PaneAgent emits OutputEvents; the daemon turns them into Telegram
  // messages). Patching the prototype covers that path. JavaScript
  // regular functions called as methods receive `this` via the
  // binding, NOT as a positional argument — so the parameter list
  // starts with chatId (the first real arg of tg.sendMessage).
  TelegramClient.prototype.sendMessage = async function (
    chatId: number,
    threadId: number,
    body: string,
    opts?: { disable_notification?: boolean; reply_markup?: unknown },
  ) {
    capture.sent.push({ chatId, threadId, text: body, reply_markup: opts?.reply_markup });
    return capture.sent.length;
  };
}

/** Returns a custom fetch that intercepts calls to api.telegram.org and
 *  records the meaningful API calls into the test capture. Used by
 *  startDaemon({ customFetch }). */
function makeTelegramFetch(): typeof fetch {
  // Stable counter for synthetic message_thread_ids returned by
  // createForumTopic. We hand back a real number so the daemon's
  // reconcile() keeps the mapping keys well-formed.
  let topicCounter = 0;
  return async function patchedFetch(
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const urlStr = String(url);
    if (!/api\.telegram\.org/.test(urlStr)) {
      throw new Error(`patchedFetch cannot forward ${urlStr}; tests must stub every fetch`);
    }
    const method = urlStr.match(/\/bot[^/]+\/([^?]+)/)?.[1] ?? "unknown";
    let payload: Record<string, unknown> = {};
    try {
      const text = init?.body ? String(init.body) : "";
      payload = text ? JSON.parse(text) : {};
    } catch {
      // ignore — payload stays empty
    }
    if (method === "setMessageReaction") {
      capture.reactions.push({
        chatId: Number(payload.chat_id),
        messageId: Number(payload.message_id),
        reactions: payload.reaction as Array<{ type: "emoji"; emoji: string }>,
      });
    } else if (method === "answerCallbackQuery") {
      capture.callbackAnswers.push({
        callbackQueryId: String(payload.callback_query_id ?? ""),
        text: String(payload.text ?? ""),
      });
    } else if (method === "sendMessage") {
      capture.sent.push({
        chatId: Number(payload.chat_id),
        threadId: Number(payload.message_thread_id ?? 0),
        text: String(payload.text ?? ""),
        reply_markup: payload.reply_markup,
      });
    } else if (method === "getChat") {
      return new Response(JSON.stringify({ ok: true, result: { id: Number(payload.chat_id), type: "private", permissions: { can_manage_topics: true } } }), { status: 200, headers: { "content-type": "application/json" } });
    } else if (method === "getForumTopics") {
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200, headers: { "content-type": "application/json" } });
    } else if (method === "createForumTopic") {
      // Return a unique synthetic message_thread_id so the daemon's
      // reconcile() can keep the mapping stable across calls.
      const id = 200000 + topicCounter;
      topicCounter += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_thread_id: id, name: String(payload.name ?? "topic"), icon_color: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    } else if (method === "editForumTopic" || method === "deleteForumTopic") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// Provide a fake botInfo so grammy's `handleUpdate` accepts our synthetic
// updates without calling getMe() (which would hit the real Telegram API).
const FAKE_BOT_INFO = {
  id: 9999,
  is_bot: true as const,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function buildMessageUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      message_thread_id: THREAD_ID,
      chat: { id: CHAT_ID, type: "private" },
      from: { id: CHAT_ID, is_bot: false, first_name: "Test" },
      text,
      date: Math.floor(Date.now() / 1000),
    },
  };
}

function buildCallbackUpdate(
  updateId: number,
  messageId: number,
  data: string,
): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: CHAT_ID, is_bot: false, first_name: "Test" },
      chat_instance: `chat-${updateId}`,
      message: {
        message_id: messageId,
        chat: { id: CHAT_ID, type: "private" },
        message_thread_id: THREAD_ID,
        from: { id: CHAT_ID, is_bot: false, first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "(stub)",
      },
      data,
    },
  };
}

interface TestRig {
  herdr: MockHerdr;
  configDir: string;
  stateDir: string;
  paneId: string;
  stop: () => Promise<void>;
  dispatch: (update: Update) => Promise<void>;
  tick: (ms?: number) => Promise<void>;
  /** Direct access to the daemon's PaneManager (test-only). */
  paneManager: PaneManager;
}

async function setupRig(): Promise<TestRig> {
  // Patch the prototype BEFORE the daemon imports TelegramClient.
  patchTelegramClientPrototype();

  // Set HERDR_BIN_PATH so the daemon spawns the mock instead of `herdr`.
  const herdr = new MockHerdr();
  process.env.HERDR_BIN_PATH = herdr.bin;
  // The mock script reads MOCK_HERDR_STATE to find its state file. Without
  // this it would crash on the first readState() call.
  process.env.MOCK_HERDR_STATE = herdr.statePath;
  resetHerdrBinCache();

  // Patch the prototype for the daemon's tg.sendMessage path, and
  // pass a custom fetch to startDaemon so grammy never hits the network.
  patchTelegramClientPrototype();
  const customFetch = makeTelegramFetch();

  herdr.setState({
    panes: {
      [PANE_ID]: { reads: ["baseline\n"], text_history: [], key_history: [] },
    },
    agents: { [PANE_ID]: { status: "idle" } },
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", pane_id: PANE_ID, label: "Echo", agent: "pi" },
    ],
    read_counts: {},
    list_count: 0,
  });

  const tmpRoot = mkdtempSync(join(tmpdir(), "herdr-tg-e2e-"));
  const configDir = join(tmpRoot, "config");
  const stateDir = join(tmpRoot, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.toml"),
    [
      "[telegram]",
      'bot_token = "test-token-1234"',
      `chat_id = ${CHAT_ID}`,
      "progress_interval_ms = 50",
      "throttle_ms = 0",
      "wait_timeout_s = 30",
      "max_total_wait_s = 30",
      "max_progress_updates = -1",
      "stability_window_ms = 200",
      "follow_timeout_minutes = 30",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(stateDir, "state.json"),
    JSON.stringify({
      authorized_chat_id: CHAT_ID,
      paired_at: new Date().toISOString(),
      thread_mappings: {
        [THREAD_ID]: {
          pane_id: PANE_ID,
          label: "Echo",
          agent: "pi",
          created_at: new Date().toISOString(),
        },
      },
      known_topics: {},
      known_tabs: {},
    }),
  );

  const daemon = await startDaemon({ configDir, stateDir, skipTelegramStart: true, customFetch });
  const tg = (daemon as unknown as { tg: TelegramClient }).tg;
  if (!tg) throw new Error("daemon.tg was not exposed (skipTelegramStart: true required)");

  // grammy requires botInfo before handleUpdate accepts synthetic updates.
  // We monkey-patch the bot so the next handleUpdate skips getMe().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tg.bot as any).botInfo = FAKE_BOT_INFO;

  // Give the bot a moment to register all handlers (startDaemon is
  // synchronous in handler registration, but bot internal state may
  // need a microtask to settle).
  await new Promise((r) => setTimeout(r, 10));

  const paneManager = (daemon as unknown as { paneManager: PaneManager }).paneManager;
  if (!paneManager) throw new Error("daemon.paneManager was not exposed (skipTelegramStart: true required)");

  return {
    herdr,
    configDir,
    stateDir,
    paneId: PANE_ID,
    paneManager,
    stop: daemon.stop,
    async dispatch(update: Update) {
      await tg.bot.handleUpdate(update);
    },
    async tick(ms = 60) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
}

function resetCapture(): void {
  capture.sent.length = 0;
  capture.reactions.length = 0;
  capture.callbackAnswers.length = 0;
}

describe("E2E: turn flow (mocked herdr, real grammy)", () => {
  let rig: TestRig;

  beforeEach(async () => {
    resetCapture();
    rig = await setupRig();
  });

  afterEach(async () => {
    await rig.stop();
    rig.herdr.cleanup();
    rmSync(rig.configDir, { recursive: true, force: true });
    rmSync(rig.stateDir, { recursive: true, force: true });
    delete process.env.HERDR_BIN_PATH;
    delete process.env.MOCK_HERDR_STATE;
    resetHerdrBinCache();
  });

  it("emits Working ticks and a Final with the last delta when the pane grows then stabilises", async () => {
    rig.herdr.setPaneContent(rig.paneId, [
      "intro\n",
      "intro\nagent response part 1\n",
      "intro\nagent response part 1\nagent response part 2\n",
      "intro\nagent response part 1\nagent response part 2\n",
      "intro\nagent response part 1\nagent response part 2\n",
      "intro\nagent response part 1\nagent response part 2\n",
    ]);

    await rig.dispatch(buildMessageUpdate(1, "olá agente"));

    // progressIntervalMs=50, stabilityMs=200 → ~4-6 polls before finalising.
    for (let i = 0; i < 30; i++) {
      await rig.tick(50);
    }

    const working = capture.sent.filter((m) => m.text.startsWith("⏳ Working"));
    expect(working.length).toBeGreaterThan(0);

    const finals = capture.sent.filter((m) => m.text.startsWith("✅"));
    expect(finals).toHaveLength(1);
    // The Final must contain the agent's last delta, not the raw pane.
    expect(finals[0].text).toContain("agent response part 2");
  });

  it("passes a follow message straight to the pane when a turn is already running (👀 reaction)", async () => {
    // First pane content sequence: agent response grows for a long time
    // so the turn stays alive across several polls.
    const growing: string[] = ["start\n"];
    for (let i = 0; i < 20; i++) {
      growing.push(growing[i] + `line ${i + 1}\n`);
    }
    rig.herdr.setPaneContent(rig.paneId, growing);

    await rig.dispatch(buildMessageUpdate(1, "olá agente"));
    // Let the first turn start ticking — wait enough ticks for the observe
    // loop to make at least 2 readPane calls and confirm it is running.
    for (let i = 0; i < 8; i++) await rig.tick(50);

    // While the first turn is mid-flight, send a second message.
    resetCapture();
    await rig.dispatch(buildMessageUpdate(2, "segunda mensagem"));

    for (let i = 0; i < 6; i++) await rig.tick(50);

    // The second message should have been sent straight to the pane
    // (text_history) and reacted with 👀.
    const textHistory = rig.herdr.textHistory(rig.paneId);
    expect(textHistory).toContain("segunda mensagem");
    expect(capture.reactions.some((r) => r.reactions.some((rr) => rr.emoji === "👀"))).toBe(true);
  });

  it("treats a second `act:follow` callback as a touch, not a restart", async () => {
    // Arm follow directly via the PaneAgent so we bypass the grammy
    // /follow command handler (blocked by the message:text middleware
    // returning early for commands). The test is about the
    // callback_query:data handler behaviour, not the /follow command
    // itself.
    rig.paneManager.getPaneAgent(PANE_ID)?.enableFollow(Date.now() + 5 * 60_000);
    for (let i = 0; i < 4; i++) await rig.tick(50);

    // The follow subscription is active. Now simulate a click on Follow 5m
    // (the inline button). threadId in the callback data must match THREAD_ID.
    const callbackMsgId = 1;
    await rig.dispatch(buildCallbackUpdate(2, callbackMsgId, `act:follow:5:${THREAD_ID}`));
    for (let i = 0; i < 4; i++) await rig.tick(50);

    // Toast should be "Following 5m." — the daemon's wiring collapses
    // the touch into enableFollow() which keeps a single loop.
    const followToast = capture.callbackAnswers.find((c) => c.text.toLowerCase().includes("5m"));
    expect(followToast).toBeDefined();
    expect(followToast!.text.toLowerCase()).toContain("following");
  });
});
