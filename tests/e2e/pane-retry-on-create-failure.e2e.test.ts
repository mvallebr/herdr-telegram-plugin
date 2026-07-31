/**
 * End-to-end regression test for the seen-set retry behaviour.
 *
 * Bug: when the daemon's `onPaneAdded` hook failed to create the Telegram
 * topic (e.g. transient Telegram error), the pane was permanently stuck.
 * `sync()` had already added the pane id to the seen-set before invoking
 * the hook, but the hook threw before `restoreTopic` could persist the
 * mapping. Result: the pane never re-appeared in `added` (so no retry) and
 * had no `known_tabs` entry (so the user had no way to interact with it).
 *
 * Fix: the daemon now calls `paneManager.markFailedAdd(paneId)` whenever
 * `createForumTopic` fails (or returns an invalid thread id). The eviction
 * from the seen-set causes the next `sync()` to report the pane as added
 * again, giving us a retry path.
 *
 * This test stands up the real daemon with `skipTelegramStart: true` and a
 * `customFetch` that throws `createForumTopic` exactly once for a chosen
 * tab name. We then:
 *   1. add the tab to the herdr mock,
 *   2. trigger a poll,
 *   3. assert the pane is NOT in `mappings()` (the failed create wiped
 *      the seen-set entry but never wrote a topic),
 *   4. clear the failure flag,
 *   5. trigger another poll,
 *   6. assert the pane IS now in `mappings()` — proving the next sync
 *      re-emitted the pane and the daemon successfully retried.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon } from "../../src/daemon.js";
import { resetHerdrBinCache } from "../../src/herdr-client.js";
import { TelegramClient } from "../../src/telegram-client.js";
import { PaneManager } from "../../src/pane-manager.js";
import { MockHerdr } from "./herdr-mock.js";

const CHAT_ID = 8911510807;
const PANE_ID = "w1:p1";            // already mapped at startup
const THREAD_ID = 140;              // pre-seeded mapping for PANE_ID
const NEW_PANE_ID = "w1:p-new";     // appears after the rig is up
const NEW_TAB_ID = "w1:t-new";
const NEW_LABEL = "Newly Added Pane";

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

interface FailureState {
  /** Topic names whose `createForumTopic` call must throw on the first hit. */
  failingTopicNames: Set<string>;
  /** Counter so the synthetic thread id is unique per call. */
  topicCounter: number;
  /** How many times each failing topic name has been hit. */
  attempts: Map<string, number>;
}

function makeTelegramFetch(state: FailureState): typeof fetch {
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
    } else if (method === "getChat") {
      return new Response(JSON.stringify({ ok: true, result: { id: Number(payload.chat_id), type: "private", permissions: { can_manage_topics: true } } }), { status: 200, headers: { "content-type": "application/json" } });
    } else if (method === "getForumTopics") {
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200, headers: { "content-type": "application/json" } });
    } else if (method === "createForumTopic") {
      const name = String(payload.name ?? "topic");
      const attempts = (state.attempts.get(name) ?? 0) + 1;
      state.attempts.set(name, attempts);
      if (state.failingTopicNames.has(name) && attempts === 1) {
        // Simulate a transient Telegram error on the FIRST attempt only.
        // The daemon must catch this, call `markFailedAdd`, and let the
        // next poll retry.
        return new Response(
          JSON.stringify({ ok: false, error_code: 500, description: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      const id = 200000 + state.topicCounter;
      state.topicCounter += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_thread_id: id, name, icon_color: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    } else if (method === "editForumTopic" || method === "deleteForumTopic") {
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

interface TestRig {
  herdr: MockHerdr;
  configDir: string;
  stateDir: string;
  paneManager: PaneManager;
  stop: () => Promise<void>;
  tick: (ms?: number) => Promise<void>;
}

async function setupRig(failureState: FailureState): Promise<TestRig> {
  patchTelegramClientPrototype();

  const herdr = new MockHerdr();
  process.env.HERDR_BIN_PATH = herdr.bin;
  process.env.MOCK_HERDR_STATE = herdr.statePath;
  resetHerdrBinCache();

  herdr.setState({
    panes: {
      [PANE_ID]: { reads: ["baseline\n"], text_history: [], key_history: [] },
    },
    agents: {
      [PANE_ID]: { status: "idle" },
    },
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", pane_id: PANE_ID, label: "Echo", agent: "pi" },
    ],
    read_counts: {},
    list_count: 0,
  });

  const tmpRoot = mkdtempSync(join(tmpdir(), "herdr-tg-retry-"));
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

  const daemon = await startDaemon({
    configDir,
    stateDir,
    skipTelegramStart: true,
    customFetch: makeTelegramFetch(failureState),
  });
  const tg = (daemon as unknown as { tg: TelegramClient }).tg;
  if (!tg) throw new Error("daemon.tg was not exposed (skipTelegramStart: true required)");
  (tg.bot as { botInfo: unknown }).botInfo = FAKE_BOT_INFO;
  await new Promise((r) => setTimeout(r, 10));

  const paneManager = (daemon as unknown as { paneManager: PaneManager }).paneManager;
  if (!paneManager) throw new Error("daemon.paneManager was not exposed");

  return {
    herdr,
    configDir,
    stateDir,
    paneManager,
    stop: daemon.stop,
    async tick(ms = 60) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
}

describe("E2E: pane retry when createForumTopic fails transiently", () => {
  let rig: TestRig;
  let failureState: FailureState;

  beforeEach(async () => {
    sends.length = 0;
    failureState = {
      failingTopicNames: new Set(),
      topicCounter: 0,
      attempts: new Map(),
    };
    rig = await setupRig(failureState);
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

  it("calls markFailedAdd on failure and re-emits the pane on the next poll", async () => {
    // Arm the fetch to fail the FIRST createForumTopic call for our new
    // tab. Subsequent calls (i.e. the retry) will succeed.
    failureState.failingTopicNames.add(NEW_LABEL);

    // Add a new tab AND its agent to the herdr mock AFTER the daemon has
    // started so the pane is genuinely a discovery — the manager's next
    // poll will see it as new and route it through onPaneAdded. The
    // mock's agent-list shim looks up the tab by pane_id to populate
    // tab_id/label, so both must be present before the next poll.
    rig.herdr.addTab({
      tab_id: NEW_TAB_ID,
      workspace_id: "w1",
      pane_id: NEW_PANE_ID,
      label: NEW_LABEL,
      agent: "pi",
    });
    rig.herdr.addAgent(NEW_PANE_ID, "idle");

    // Trigger a poll. onPaneAdded runs asynchronously; we need a few ticks
    // for the hook to complete (including the failed fetch + markFailedAdd).
    rig.paneManager.poll();
    for (let i = 0; i < 8; i++) await rig.tick(50);

    // Sanity: the failing topic name was attempted exactly once. (The
    // existing pre-seeded PANE_ID's createForumTopic uses label "Echo"
    // and is unaffected by the failure flag.)
    expect(failureState.attempts.get(NEW_LABEL)).toBe(1);

    // The new pane must NOT have a mapping: createForumTopic failed, so
    // restoreTopic never ran. Without the fix, it would also be missing
    // from the seen-set's "to be re-emitted" list (because sync() had
    // already added it), and the pane would be permanently orphaned.
    const mappingsAfterFail = [...rig.paneManager.mappings().values()];
    expect(mappingsAfterFail.some((m) => m.pane_id === NEW_PANE_ID)).toBe(false);
    expect(rig.paneManager.state().known_tabs?.[NEW_TAB_ID]).toBeUndefined();

    // Trigger another poll. The seen-set should have been evicted on the
    // first attempt, so the manager MUST report the pane as added again.
    rig.paneManager.poll();
    for (let i = 0; i < 8; i++) await rig.tick(50);

    // This time createForumTopic succeeds — fetch returns ok:true with a
    // synthetic message_thread_id, restoreTopic persists the mapping.
    expect(failureState.attempts.get(NEW_LABEL)).toBe(2);

    // The pane is now bound to a thread. Verify the mapping is in place.
    const mappingsAfterRetry = [...rig.paneManager.mappings().values()];
    const mappingForNewPane = mappingsAfterRetry.find(
      (m) => m.pane_id === NEW_PANE_ID,
    );
    expect(mappingForNewPane).toBeDefined();
    expect(mappingForNewPane?.label).toBe(NEW_LABEL);
    expect(rig.paneManager.state().known_tabs?.[NEW_TAB_ID]?.label).toBe(NEW_LABEL);

    // A subsequent poll must NOT re-emit the pane: the seen-set now
    // contains it, and there is a known_tabs entry. (Defensive: also
    // guards against markAdded being a no-op as expected.)
    const callsBefore = failureState.attempts.get(NEW_LABEL) ?? 0;
    rig.paneManager.poll();
    for (let i = 0; i < 4; i++) await rig.tick(50);
    expect(failureState.attempts.get(NEW_LABEL)).toBe(callsBefore);
  });
});