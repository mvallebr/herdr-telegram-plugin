import type { ThreadMapping } from "./types.js";

export interface FollowSubscription {
  threadId: number;
  mapping: ThreadMapping;
  /** When the subscription was last touched (ms epoch). */
  startedAt: number;
  /** When the subscription expires (ms epoch). `Infinity` when timeoutMs=0. */
  expiresAt: number;
  /** Original timeout in ms (preserved for reset / touch). `0` = no timeout. */
  timeoutMs: number;
}

export interface FollowClock {
  now(): number;
}

const realClock: FollowClock = { now: () => Date.now() };

/**
 * In-memory subscription registry. /follow adds an entry, /unfollow removes,
 * /touch resets the timer on user message. Lost on daemon restart by design
 * (decision: subscriptions are session-scoped, not persisted).
 */
export class FollowManager {
  private readonly subs = new Map<number, FollowSubscription>();

  constructor(private readonly clock: FollowClock = realClock) {}

  /** Start or replace a subscription for the given thread. */
  subscribe(threadId: number, mapping: ThreadMapping, timeoutMinutes: number): FollowSubscription {
    const timeoutMs = Math.max(0, Math.floor(timeoutMinutes)) * 60_000;
    const now = this.clock.now();
    const sub: FollowSubscription = {
      threadId,
      mapping,
      startedAt: now,
      timeoutMs,
      // timeoutMs=0 means "no timeout" — never expires. Use Infinity so
      // arithmetic comparisons stay well-defined.
      expiresAt: timeoutMs === 0 ? Number.POSITIVE_INFINITY : now + timeoutMs,
    };
    this.subs.set(threadId, sub);
    return sub;
  }

  /** Reset the timer on a user message while subscribed. No-op if absent. */
  touch(threadId: number): void {
    const sub = this.subs.get(threadId);
    if (!sub) return;
    const now = this.clock.now();
    sub.expiresAt = sub.timeoutMs === 0 ? Number.POSITIVE_INFINITY : now + sub.timeoutMs;
  }

  /** Drop a subscription. Returns true if one existed. */
  remove(threadId: number): boolean {
    return this.subs.delete(threadId);
  }

  /** Snapshot of a single subscription, or null when not subscribed. */
  get(threadId: number): FollowSubscription | null {
    return this.subs.get(threadId) ?? null;
  }

  /** All threadIds whose subscription has expired. timeoutMs=0 never expires. */
  listExpired(): number[] {
    const now = this.clock.now();
    const expired: number[] = [];
    for (const sub of this.subs.values()) {
      if (sub.expiresAt <= now) expired.push(sub.threadId);
    }
    return expired;
  }

  /** Is this thread's subscription past its expiration? */
  isExpired(threadId: number): boolean {
    const sub = this.subs.get(threadId);
    if (!sub) return false;
    return sub.expiresAt <= this.clock.now();
  }

  /** Current subscription count. */
  get size(): number {
    return this.subs.size;
  }

  /** Snapshots of every active subscription. */
  listAll(): FollowSubscription[] {
    return Array.from(this.subs.values());
  }
}
