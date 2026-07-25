import type { AgentWrapper } from "./agent-wrapper.js";

export interface TurnReporter {
  progress(elapsedSeconds: number, preview?: string): Promise<void>;
  blocked(question?: string): Promise<void>;
  final(text: string, source: string, alreadyPublished?: boolean): Promise<void>;
  failed(reason: string): Promise<void>;
}

export interface TurnCoordinatorDeps {
  sleep(ms: number): Promise<void>;
  now(): number;
}

interface PendingFinal {
  text: string;
  source: string;
  detectedAt: number;
}

export interface CoordinateTurnOptions {
  prompt: string;
  progressIntervalMs: number;
  maxWaitMs: number;
  maxProgressUpdates?: number;
  /** Min ms the same final response must persist before publish. Default 0
   *  (immediate). Set >0 to apply universally to all wrappers, including
   *  JSONL session-log adapters, so premature `final_answer` events do not
   *  close the turn while the agent is still working. */
  stabilityWindowMs?: number;
}

export async function coordinateTurn(
  wrapper: AgentWrapper,
  reporter: TurnReporter,
  options: CoordinateTurnOptions,
  deps: TurnCoordinatorDeps
): Promise<void> {
  const startedAt = deps.now();
  await wrapper.submit(options.prompt);

  let progressCount = 0;
  let lastPreview = "";
  let pending: PendingFinal | null = null;
  const stabilityMs = options.stabilityWindowMs ?? 0;

  while (deps.now() - startedAt <= options.maxWaitMs) {
    const status = await wrapper.status();

    // Blocked always preempts: an interactive question must reach the user
    // even if a final answer happened to slip in earlier.
    if (status.state === "blocked") {
      await reporter.blocked(status.question);
      return;
    }

    if (status.state === "final") {
      // Compare with any existing pending: same normalized text keeps the
      // window (still computing the same thing), different text resets the
      // pending candidate (output evolved).
      const sameAsPending: boolean =
        !!pending && normalize(status.text) === normalize(pending.text);
      const now: number = deps.now();
      const preservedDetectedAt: number = pending ? pending.detectedAt : now;
      pending = {
        text: status.text,
        source: status.source,
        detectedAt: sameAsPending ? preservedDetectedAt : now,
      };

      // Stability window: only publish after the same final persists for
      // `stabilityMs`. Zero (default) keeps the legacy immediate behavior.
      if (
        stabilityMs === 0 ||
        deps.now() - pending.detectedAt >= stabilityMs
      ) {
        const sameAsPreview =
          normalize(status.text) !== "" &&
          normalize(status.text) === normalize(lastPreview);
        await reporter.final(status.text, status.source, sameAsPreview);
        return;
      }
      // Not stable yet: fall through to sleep + retry.
    } else if (status.state === "working") {
      // Discard any pending final from a previous poll — the agent is still
      // computing; what looked final was a JSONL flicker.
      pending = null;
    } else if (status.state === "failed") {
      // Discard any pending final and report the failure.
      pending = null;
      await reporter.failed(status.reason);
      return;
    }

    await deps.sleep(options.progressIntervalMs);
    const elapsed = Math.floor((deps.now() - startedAt) / 1000);
    const preview = status.state === "working" ? status.preview?.trim() : undefined;
    if (
      options.maxProgressUpdates === undefined ||
      options.maxProgressUpdates < 0 ||
      progressCount < options.maxProgressUpdates
    ) {
      progressCount += 1;
      await reporter.progress(
        elapsed,
        preview && preview !== lastPreview ? preview : undefined
      );
      if (preview) lastPreview = preview;
    }
  }
  await reporter.failed("Timed out waiting for the agent response.");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
