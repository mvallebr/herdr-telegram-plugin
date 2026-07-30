/**
 * Regression test for the /unpair handler in src/daemon.ts.
 *
 * Bug: /unpair iterated only `state.known_topics` to decide which Telegram
 * forum topics to delete. Topics that ended up in `state.thread_mappings`
 * but never in `state.known_topics` (which can happen after a /reconcile
 * that bound an existing-but-uncached topic) were left behind as orphans
 * in the chat.
 *
 * Fix: /unpair must delete the union of `known_topics` and
 * `thread_mappings` keys, then reset state.
 *
 * This test sets up a state where `thread_mappings[142]` is present but
 * `known_topics` is empty, dispatches /unpair, and asserts that
 * `deleteForumTopic` was called for thread 142.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Update } from "grammy";
import { startDaemon } from "../../src/daemon.js";
import { resetHerdrBinCache } from "../../src/herdr-client.js";
import { TelegramClient } from "../../src/telegram-client.js";
import { MockHerdr } from "./herdr-mock.js";

const CHAT_ID = 8911510807;
const PANE_ID = "w1:p1";
const ORPHAN_THREAD_ID = 142;   // in thread_mappings but NOT in known_topics
const REGISTERED_THREAD_ID = 150; // in BOTH thread_mappings and known_topics

interface DeleteCall { chatId: number; threadId: number }
const deletes: DeleteCall[] = [];

/** Patch sendMessage so we don't reach the network through that path. */
function patchTelegramClientPrototype(): void {
  TelegramClient.prototype.sendMessage = async function (
    chatId: number,
    _threadId: number,
    _body: string,
  ) {
    return chatId; // pretend it succeeded
  };
}

/** Custom fetch that records every deleteForumTopic call. Other Telegram
 *  methods return ok:true so the daemon doesn't crash. */
function makeTelegramFetch(): typeof fetch {
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
    if (method === "deleteForumTopic") {
      deletes.push({
        chatId: Number(payload.chat_id),
        threadId: Number(payload.message_thread_id),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "getChat") {
      return new Response(JSON.stringify({ ok: true, result: { id: Number(payload.chat_id), type: "private", permissions: { can_manage_topics: true } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "getForumTopics") {
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const FAKE_BOT_INFO = {
  id: 9999,
  is_bot: true as const,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function buildUnpairUpdate(updateId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      // /unpair must work even outside a topic (send in General)
      chat: { id: CHAT_ID, type: "private" },
      from: { id: CHAT_ID, is_bot: false, first_name: "Test" },
      text: "/unpair",
      date: Math.floor(Date.now() / 1000),
    },
  };
}

interface TestRig {
  herdr: MockHerdr;
  configDir: string;
  stateDir: string;
  stop: () => Promise<void>;
  dispatch: (update: Update) => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  patchTelegramClientPrototype();

  const herdr = new MockHerdr();
  process.env.HERDR_BIN_PATH = herdr.bin;
  process.env.MOCK_HERDR_STATE = herdr.statePath;
  resetHerdrBinCache();

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

  const tmpRoot = mkdtempSync(join(tmpdir(), "herdr-tg-unpair-"));
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

  // Pre-seed state so that:
  //   - ORPHAN_THREAD_ID is in thread_mappings but NOT in known_topics
  //   - REGISTERED_THREAD_ID is in BOTH
  // This models the scenario where /reconcile produced a mapping without
  // the topic ever being created in this session (e.g. topic existed from
  // a previous run, or seeded by a watcher that bypassed known_topics).
  writeFileSync(
    join(stateDir, "state.json"),
    JSON.stringify({
      authorized_chat_id: CHAT_ID,
      paired_at: new Date().toISOString(),
      thread_mappings: {
        [ORPHAN_THREAD_ID]: {
          pane_id: PANE_ID,
          label: "Echo",
          agent: "pi",
          created_at: new Date().toISOString(),
        },
        [REGISTERED_THREAD_ID]: {
          pane_id: `${PANE_ID}:secondary`,
          label: "Other",
          agent: "pi",
          created_at: new Date().toISOString(),
        },
      },
      known_topics: {
        [REGISTERED_THREAD_ID]: {
          name: "Other",
          created_at: new Date().toISOString(),
        },
      },
      known_tabs: {},
    }),
  );

  const daemon = await startDaemon({
    configDir,
    stateDir,
    skipTelegramStart: true,
    customFetch: makeTelegramFetch(),
  });
  const tg = (daemon as unknown as { tg: TelegramClient }).tg;
  if (!tg) throw new Error("daemon.tg was not exposed (skipTelegramStart: true required)");
  (tg.bot as { botInfo: unknown }).botInfo = FAKE_BOT_INFO;

  // Let grammy settle handlers.
  await new Promise((r) => setTimeout(r, 10));

  return {
    herdr,
    configDir,
    stateDir,
    stop: daemon.stop,
    async dispatch(update: Update) {
      await tg.bot.handleUpdate(update);
    },
  };
}

describe("E2E: /unpair deletes the union of known_topics + thread_mappings", () => {
  let rig: TestRig;

  beforeEach(async () => {
    deletes.length = 0;
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

  it("calls deleteForumTopic for every thread id in known_topics ∪ thread_mappings", async () => {
    await rig.dispatch(buildUnpairUpdate(1));

    const deletedThreadIds = deletes.map((d) => d.threadId);
    // The orphan thread id (only in thread_mappings, not in known_topics)
    // must have been deleted. This is the regression assertion.
    expect(deletedThreadIds).toContain(ORPHAN_THREAD_ID);
    // The thread id present in both must also be deleted.
    expect(deletedThreadIds).toContain(REGISTERED_THREAD_ID);
    // All delete calls must target the paired chat.
    for (const d of deletes) expect(d.chatId).toBe(CHAT_ID);
    // No duplicates — the union must deduplicate.
    expect(deletedThreadIds).toEqual([...new Set(deletedThreadIds)]);
  });
});
