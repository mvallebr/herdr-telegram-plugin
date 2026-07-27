/**
 * Inline-keyboard factories used by Working and Final messages emitted
 * from the observe-loop.
 *
 * Each button uses `callback_data` in the form `act:<command>[:<args>]:<threadId>`
 * so the daemon's callback handler can route the tap to the matching
 * command without re-invoking the full update pipeline.
 */

export interface KeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = {
  inline_keyboard: KeyboardButton[][];
};

export type TurnKind = "idle" | "follow";

/**
 * Working-phase keyboard. `hasFollow` toggles the second button between
 * `Unfollow` (when an active follow subscription is on the thread) and
 * nothing (when there is no follow context).
 */
export function workingKeyboard(threadId: number, hasFollow: boolean): InlineKeyboard {
  const row: KeyboardButton[] = [
    { text: "Stop", callback_data: `act:stop:${threadId}` },
    { text: "Last", callback_data: `act:last:${threadId}` },
    { text: "Status", callback_data: `act:status:${threadId}` },
  ];
  if (hasFollow) {
    row.splice(1, 0, { text: "Unfollow", callback_data: `act:unfollow:${threadId}` });
  }
  return { inline_keyboard: [row] };
}

/**
 * Final-phase keyboard. No `Stop` (turn is over); no `New turn` (turns
 * are created by user messages, not commands). When a follow subscription
 * was active we show a "Unfollow" instead of the "Follow 5/30" pair.
 */
export function finalKeyboard(threadId: number, hasFollow: boolean): InlineKeyboard {
  if (hasFollow) {
    return {
      inline_keyboard: [[
        { text: "Unfollow", callback_data: `act:unfollow:${threadId}` },
        { text: "Last", callback_data: `act:last:${threadId}` },
        { text: "Status", callback_data: `act:status:${threadId}` },
      ]],
    };
  }
  return {
    inline_keyboard: [[
      { text: "Follow 5m", callback_data: `act:follow:5:${threadId}` },
      { text: "Follow 30m", callback_data: `act:follow:30:${threadId}` },
      { text: "Last", callback_data: `act:last:${threadId}` },
      { text: "Status", callback_data: `act:status:${threadId}` },
    ]],
  };
}

/** Convenience: parse `act:<command>[:<args>]:<threadId>`. Returns
 *  null when the payload does not match. */
export function parseActionCallback(
  data: string,
): { command: string; args: string; threadId: number } | null {
  const m = data.match(/^act:([^:]+)(?::([^:]+))?:(\d+)$/);
  if (!m) return null;
  return { command: m[1], args: m[2] ?? "", threadId: parseInt(m[3], 10) };
}
