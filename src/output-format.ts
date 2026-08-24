/**
 * Output-formatting helpers used by the registry's scrape reader, the
 * commands module (/last), and the daemon's topic seeding. Lives in its
 * own module so the scrape reader does not have to take a dependency on
 * Telegram-specific code.
 */

export function isNaturalLanguageLine(line: string): boolean {
  if (!line || line.length > 300) return false;
  if (/^\d[\d,.]*\s+tokens$/.test(line.trim()) || /^LSPs? are disabled$/.test(line.trim())) return false;
  if (/[─━═]{20,}/.test(line) || /^ctx_\w+ /.test(line) || /^<\/?[a-z_]/i.test(line.trim())) return false;
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  // Reject other control characters (keep printable Unicode incl. emoji, scripts).
  if (/\p{C}/u.test(stripped)) return false;
  return !/[─━═|~^$%\\·•]/.test(stripped);
}

/** Strip context-mode banners and terminal chrome from scraped output. */
export function cleanPaneOutput(content: string): string {
  let clean = content.replace(/<session_state[\s\S]*?<\/session_state>/g, "");
  // Remove terminal control sequences before line filtering so useful text
  // wrapped in colour/cursor escapes is retained without the escapes.
  clean = clean.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  // Terminal UIs (notably OpenCode) prefix otherwise useful prompt/output
  // lines with a vertical border. Remove that chrome before line filtering so
  // the submitted-prompt anchor remains available for extraction.
  clean = clean.replace(/^[\s┃│▏▕]+/gm, "");
  clean = clean.replace(/[\s┃│▏▕]+$/gm, "");
  clean = clean.split("\n").filter((line) => !line.includes("context-mode active")).join("\n");
  return clean.split("\n").filter(isNaturalLanguageLine).join("\n").trim();
}

/** Remove terminal status lines that refresh independently of agent output. */
export function stripStatusBar(content: string): string {
  const lines = content.split("\n");
  while (lines.length) {
    const last = lines.at(-1)!;
    if (
      last.trim() === "" ||
      /^[─━═]{20,}/.test(last.trim()) ||
      /^.{3,} · /.test(last.trim()) ||
      /^Model: /.test(last.trim()) ||
      /^\S+\s+\S+\s+[^\s]+\$$/.test(last.trim())
    ) lines.pop();
    else break;
  }
  return lines.join("\n");
}

/** Return only content after the last occurrence of the submitted prompt. */
export function extractResponseSince(content: string, userInput: string): string {
  const lines = content.split("\n");
  const userLines = userInput.split("\n").filter((line) => line.trim());
  const anchor = userLines.at(-1) ?? userInput;
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(anchor)) { index = i; break; }
    // Some terminal UIs append status text to the prompt line or wrap its
    // tail. The first 80 chars remain a unique, safe turn anchor.
    if (anchor.length > 80 && lines[i].includes(anchor.slice(0, 80))) { index = i; break; }
  }
  if (index < 0) return "";
  const after = lines.slice(index + 1);
  while (after.length && (after[0].trim() === "")) after.shift();
  return stripStatusBar(after.join("\n"));
}

/** Scrape only a response unambiguously anchored to the submitted prompt. */
export function extractScreenResponse(content: string, userInput: string): string {
  // Locate the prompt before filtering. Long OpenCode prompt lines can carry
  // terminal metadata and exceed the prose filter, but remain the safest
  // correlation anchor for this turn.
  const dechromed = content.replace(/^[\s┃│▏▕]+/gm, "");
  return cleanPaneOutput(extractResponseSince(dechromed, userInput));
}

/**
 * Fallback when a terminal UI removes the submitted prompt after accepting
 * it. Returns only the changed suffix when a stable snapshot has a shared
 * prefix; callers must use it only for content observed after `submit`.
 */
export function extractScreenDelta(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let shared = 0;
  while (shared < oldLines.length && shared < newLines.length && oldLines[shared] === newLines[shared]) shared += 1;
  if (shared === 0 || shared === newLines.length) return "";
  return cleanPaneOutput(newLines.slice(shared).join("\n"));
}
