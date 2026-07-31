/**
 * Regression test for the /pair "Reconciled: N panes mapped." count bug.
 *
 * Bug: after /pair, the daemon returned "Reconciled: 0 panes mapped." even
 * though the PaneManager was about to create 3 Telegram topics via its
 * `onPaneAdded` hook. The handler used the in-memory `reconcile()` result
 * which ran BEFORE the hook fired `tg.createForumTopic` + `restoreTopic`,
 * so the reply was sent before the new mappings landed in state.
 *
 * Fix: the /pair (and /reconcile) handlers now `await
 * paneManager.awaitInflight()` between `poll()` and reading `mappings()`.
 * `awaitInflight()` waits for every `onPaneAdded`/`onPaneRemoved`/
 * `onPaneRenamed` promise fired by `poll()` to settle, so by the time the
 * count is read, every successfully-created topic is in
 * `thread_mappings` and visible to `mappings()`.
 *
 * This test seeds the rig with three pre-existing herdr tabs that are NOT
 * yet in `thread_mappings`, sends /pair, captures every reply, and asserts
 * that the count message reflects 3 panes — not 0.
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

const CHAT_ID = 8911510807;

const PANE_CONFIGS: Array<{ pane_id: string; tab_id: string; label: string }> = [
  { pane_id: "w1:p1", tab_id: "w1:t1", label: "Echo" },
  { pane_id: "w1:p2", tab_id: "w1:t2", label: "Build" },
  { pane_id: "w1:p3", tab_id: "w1:t3", label: "Lint" },
];

interface CapturedSend { chatId: number; threadId: number; text: string }
const sends: CapturedSend[] = [];

function patchTelegramClientPrototype(): void {
  TelegramClient.prototype.sendMessage = async function (
    chatId: number,
    threadId: number,
    body: string,
  ) {
    sends.push({ chatId, threadId, text: body });
    return sends.length;
  };
}

/** Stable counter for synthetic message_thread_ids returned by
 *  createForumTopic. We hand back a real number so the daemon's
 *  reconcile() keeps the mapping keys well-formed. */
interface FetchState {
  topicCounter: number;
}
function makeTelegramFetch(state: FetchState): typeof fetch {
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
    if (method === "sendMessage") {
      sends.push({
        chatId: Number(payload.chat_id),
        threadId: Number(payload.message_thread_id ?? 0),
        text: String(payload.text ?? ""),
      });
      // Real sendMessage returns a Message; we only care about success here.
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "getChat") {
      return new Response(JSON.stringify({ ok: true, result: { id: CHAT_ID, type: "private", permissions: { can_manage_topics: true } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "getForumTopics") {
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "createForumTopic") {
      const id = 200000 + state.topicCounter;
      state.topicCounter += 1;
      const name = String(payload.name ?? "topic");
      // Track the topic names actually requested — lets us assert the
      // count against the number of topics that were created (one per pane).
      sends.push({
        chatId: Number(payload.chat_id),
        threadId: 0,
        text: `[createForumTopic] ${name}`,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_thread_id: id, name, icon_color: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "editForumTopic" || method === "deleteForumTopic") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
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

function buildPairUpdate(updateId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: CHAT_ID, type: "private" },
      from: { id: CHAT_ID, is_bot: false, first_name: "Test" },
      text: "/pair",
      date: Math.floor(Date.now() / 1000),
    },
  };
}

function buildReconcileUpdate(updateId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: CHAT_ID, type: "private" },
      from: { id: CHAT_ID, is_bot: false, first_name: "Test" },
      text: "/reconcile",
      date: Math.floor(Date.now() / 1000),
    },
  };
}

interface TestRig {
  herdr: MockHerdr;
  configDir: string;
  stateDir: string;
  paneManager: PaneManager;
  stop: () => Promise<void>;
  dispatch: (update: Update) => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  patchTelegramClientPrototype();

  const herdr = new MockHerdr();
  process.env.HERDR_BIN_PATH = herdr.bin;
  process.env.MOCK_HERDR_STATE = herdr.statePath;
  resetHerdrBinCache();

  // Seed herdr with THREE agent panes (each with its own tab). The daemon
  // must create three Telegram topics for them after /pair.
  const panes: Record<string, { reads: string[]; text_history: string[]; key_history: string[] }> = {};
  const agents: Record<string, { status: "idle" }> = {};
  const tabs: Array<{ tab_id: string; workspace_id: string; pane_id: string; label: string; agent: string }> = [];
  for (const cfg of PANE_CONFIGS) {
    panes[cfg.pane_id] = { reads: ["baseline\n"], text_history: [], key_history: [] };
    agents[cfg.pane_id] = { status: "idle" };
    tabs.push({
      tab_id: cfg.tab_id,
      workspace_id: "w1",
      pane_id: cfg.pane_id,
      label: cfg.label,
      agent: "pi",
    });
  }
  herdr.setState({ panes, agents, tabs, read_counts: {}, list_count: 0 });

  const tmpRoot = mkdtempSync(join(tmpdir(), "herdr-tg-pair-count-"));
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
  // Important: state.json starts UNPAIRED so /pair is the trigger for
  // topic creation. thread_mappings/known_tabs are empty — this models
  // a fresh install where no topics exist yet.
  writeFileSync(
    join(stateDir, "state.json"),
    JSON.stringify({
      authorized_chat_id: null,
      paired_at: null,
      thread_mappings: {},
      known_topics: {},
      known_tabs: {},
    }),
  );

  const daemon = await startDaemon({
    configDir,
    stateDir,
    skipTelegramStart: true,
    customFetch: makeTelegramFetch({ topicCounter: 0 }),
  });
  const tg = (daemon as unknown as { tg: TelegramClient }).tg;
  if (!tg) throw new Error("daemon.tg was not exposed (skipTelegramStart: true required)");
  (tg.bot as { botInfo: unknown }).botInfo = FAKE_BOT_INFO;
  // Let grammy settle handlers.
  await new Promise((r) => setTimeout(r, 10));

  const paneManager = (daemon as unknown as { paneManager: PaneManager }).paneManager;
  if (!paneManager) throw new Error("daemon.paneManager was not exposed (skipTelegramStart: true required)");

  return {
    herdr,
    configDir,
    stateDir,
    paneManager,
    stop: daemon.stop,
    async dispatch(update: Update) {
      await tg.bot.handleUpdate(update);
    },
  };
}

describe("E2E: /pair reports an accurate pane count after topic creation", () => {
  let rig: TestRig;

  beforeEach(async () => {
    sends.length = 0;
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

  it("reports the actual pane count after /pair creates topics", async () => {
    // Sanity: the daemon's PaneManager starts with no mappings (and the
    // any-launched watcher hasn't run yet because state is unpaired).
    expect(rig.paneManager.mappings().size).toBe(0);

    // Send /pair. The handler will:
    //   1. persist authorized_chat_id
    //   2. reply "Chat authorized. Reconciling tabs..."
    //   3. paneManager.poll()  →  result.added contains 3 pane ids
    //   4. onPaneAdded fires for each (calls createForumTopic + restoreTopic)
    //   5. await paneManager.awaitInflight()  ← THE FIX
    //   6. read paneManager.mappings().size == 3
    //   7. reply "Reconciled: 3 panes mapped."
    await rig.dispatch(buildPairUpdate(1));

    // Find the "Reconciled: N panes mapped." reply.
    const reconciled = sends.find((m) => m.text.startsWith("Reconciled:"));
    expect(reconciled).toBeDefined();
    expect(reconciled!.text).toBe(`Reconciled: ${PANE_CONFIGS.length} panes mapped.`);
  });

  it("creates one Telegram topic per pane and persists the mapping count", async () => {
    await rig.dispatch(buildPairUpdate(1));

    // The fetch log must show one createForumTopic call per pane label —
    // the daemon should not have skipped any pane due to a race.
    const created = sends.filter((m) => m.text.startsWith("[createForumTopic]"));
    expect(created).toHaveLength(PANE_CONFIGS.length);
    const createdNames = created.map((m) => m.text.replace("[createForumTopic] ", ""));
    for (const cfg of PANE_CONFIGS) {
      expect(createdNames).toContain(cfg.label);
    }

    // The mapping count in the manager must equal the number of panes —
    // both are derived from the same source of truth (state.thread_mappings).
    expect(rig.paneManager.mappings().size).toBe(PANE_CONFIGS.length);
    for (const cfg of PANE_CONFIGS) {
      const found = [...rig.paneManager.mappings().values()].some(
        (m) => m.pane_id === cfg.pane_id,
      );
      expect(found).toBe(true);
    }
  });

  it("/reconcile reports an accurate count when new panes are added mid-session", async () => {
    // Pre-pair so /reconcile is the trigger (the /pair path is covered by
    // the test above).
    await rig.dispatch(buildPairUpdate(1));
    sends.length = 0; // clear "/pair" chatter

    // Add a brand new pane mid-session that the manager has never seen.
    const NEW_PANE_ID = "w1:p-new";
    const NEW_TAB_ID = "w1:t-new";
    const NEW_LABEL = "NewlyAdded";
    rig.herdr.addTab({
      tab_id: NEW_TAB_ID,
      workspace_id: "w1",
      pane_id: NEW_PANE_ID,
      label: NEW_LABEL,
      agent: "pi",
    });
    rig.herdr.addAgent(NEW_PANE_ID, "idle");

    // /reconcile must mint a topic for the new pane AND report the
    // accurate count. Without `awaitInflight()` in the handler, the
    // "Reconciled: N panes mapped." reply would be sent before the new
    // mapping landed in state — the same race /pair had.
    await rig.dispatch(buildReconcileUpdate(2));

    const reconciled = sends.find((m) => m.text.startsWith("Reconciled:"));
    expect(reconciled).toBeDefined();
    expect(reconciled!.text).toBe(
      `Reconciled: ${PANE_CONFIGS.length + 1} panes mapped.`,
    );

    // The new pane must now be in mappings().
    const newPaneMapped = [...rig.paneManager.mappings().values()].some(
      (m) => m.pane_id === NEW_PANE_ID,
    );
    expect(newPaneMapped).toBe(true);
  });
});
