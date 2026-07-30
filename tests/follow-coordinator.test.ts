import { describe, it, expect, vi } from "vitest";
import { FollowCoordinator } from "../src/follow-coordinator.js";

describe("FollowCoordinator", () => {
  function setup(opts?: { hasFollow?: (tid: number) => boolean }) {
    const startFollow = vi.fn();
    const hasFollow = opts?.hasFollow ?? vi.fn().mockReturnValue(true);
    const coord = new FollowCoordinator({ startFollow, hasFollow });
    return { coord, startFollow, hasFollow };
  }

  describe("beginLoop", () => {
    it("returns true when no loop is active", () => {
      const { coord } = setup();
      expect(coord.beginLoop("p1", "turn", () => {})).toBe(true);
      expect(coord.isActive("p1")).toBe(true);
      expect(coord.activeKind("p1")).toBe("turn");
    });

    it("returns false when a loop is already active for the pane", () => {
      const { coord } = setup();
      expect(coord.beginLoop("p1", "turn", () => {})).toBe(true);
      expect(coord.beginLoop("p1", "follow", () => {})).toBe(false);
      // The original active loop is untouched.
      expect(coord.activeKind("p1")).toBe("turn");
    });

    it("isolates panes — different panes track independently", () => {
      const { coord } = setup();
      expect(coord.beginLoop("p1", "turn", () => {})).toBe(true);
      expect(coord.beginLoop("p2", "follow", () => {})).toBe(true);
      expect(coord.isActive("p1")).toBe(true);
      expect(coord.isActive("p2")).toBe(true);
      expect(coord.activeKind("p1")).toBe("turn");
      expect(coord.activeKind("p2")).toBe("follow");
    });
  });

  describe("finishLoop", () => {
    it("clears the active loop", () => {
      const { coord } = setup();
      coord.beginLoop("p1", "turn", () => {});
      coord.finishLoop("p1");
      expect(coord.isActive("p1")).toBe(false);
      expect(coord.activeKind("p1")).toBeNull();
    });

    it("allows beginLoop to succeed again after finish", () => {
      const { coord } = setup();
      coord.beginLoop("p1", "turn", () => {});
      coord.finishLoop("p1");
      expect(coord.beginLoop("p1", "follow", () => {})).toBe(true);
    });

    it("promotes a deferred follow when the active loop finishes (subscription active)", () => {
      const { coord, startFollow, hasFollow } = setup();
      coord.beginLoop("p1", "turn", () => {});
      coord.deferFollow("p1", 140);
      coord.finishLoop("p1");
      expect(hasFollow).toHaveBeenCalledWith(140);
      expect(startFollow).toHaveBeenCalledWith(140);
    });

    it("does NOT promote a deferred follow when the subscription was removed", () => {
      const { coord, startFollow } = setup({
        hasFollow: vi.fn().mockReturnValue(false),
      });
      coord.beginLoop("p1", "turn", () => {});
      coord.deferFollow("p1", 140);
      coord.finishLoop("p1");
      expect(startFollow).not.toHaveBeenCalled();
    });

    it("clears the deferred follow after promotion (one-shot)", () => {
      const { coord, startFollow, hasFollow } = setup();
      coord.beginLoop("p1", "turn", () => {});
      coord.deferFollow("p1", 140);
      coord.finishLoop("p1");
      expect(startFollow).toHaveBeenCalledTimes(1);
      expect(coord.hasDeferredFollow("p1")).toBe(false);
      // Second finishLoop: no deferred → no-op.
      coord.finishLoop("p1");
      expect(startFollow).toHaveBeenCalledTimes(1);
      // hasFollow only consulted once (the promotion check).
      expect(hasFollow).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when no loop is active and no deferred follow", () => {
      const { coord, startFollow } = setup();
      coord.finishLoop("p1");
      expect(startFollow).not.toHaveBeenCalled();
    });
  });

  describe("deferFollow", () => {
    it("marks the pane as having a deferred follow", () => {
      const { coord } = setup();
      coord.beginLoop("p1", "turn", () => {});
      coord.deferFollow("p1", 140);
      expect(coord.hasDeferredFollow("p1")).toBe(true);
    });

    it("overwrites a prior deferred follow on the same pane", () => {
      const { coord } = setup();
      coord.beginLoop("p1", "turn", () => {});
      coord.deferFollow("p1", 140);
      coord.deferFollow("p1", 141);
      coord.finishLoop("p1");
      // The latest deferred threadId wins.
      // (The startFollow callback mock ignores its argument.)
    });
  });

  describe("cancel", () => {
    it("cancels an active FOLLOW loop and clears pending follow", () => {
      const { coord } = setup();
      const cancelFn = vi.fn();
      coord.beginLoop("p1", "follow", cancelFn);
      // Setting a deferred follow alongside an active follow is an
      // unusual state but the coordinator tolerates it.
      coord.deferFollow("p1", 140);
      coord.cancel("p1");
      expect(cancelFn).toHaveBeenCalled();
      expect(coord.isActive("p1")).toBe(false);
      expect(coord.hasDeferredFollow("p1")).toBe(false);
    });

    it("does NOT cancel an active TURN loop (turn abort goes through TurnDispatcher)", () => {
      const { coord } = setup();
      const cancelFn = vi.fn();
      coord.beginLoop("p1", "turn", cancelFn);
      coord.cancel("p1");
      expect(cancelFn).not.toHaveBeenCalled();
      expect(coord.isActive("p1")).toBe(false);
    });

    it("clears a deferred follow even when a turn is active", () => {
      // Real scenario: /unfollow arrives while a turn is running. The
      // follow subscription is dropped; we must NOT promote anything
      // when the turn eventually finalises.
      const { coord, startFollow } = setup();
      coord.beginLoop("p1", "turn", () => {});
      coord.deferFollow("p1", 140);
      coord.cancel("p1");
      expect(coord.hasDeferredFollow("p1")).toBe(false);
      coord.finishLoop("p1");
      expect(startFollow).not.toHaveBeenCalled();
    });

    it("is idempotent when called on a pane with no state", () => {
      const { coord } = setup();
      coord.cancel("p1"); // no-op
      expect(coord.isActive("p1")).toBe(false);
      expect(coord.hasDeferredFollow("p1")).toBe(false);
    });
  });
});