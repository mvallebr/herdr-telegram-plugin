import type { AgentWrapper } from "./agent-wrapper.js";

export interface TurnReporter {
  progress(elapsedSeconds: number, preview?: string): Promise<void>;
  final(text: string, source: string, alreadyPublished?: boolean): Promise<void>;
  failed(reason: string): Promise<void>;
}

export interface TurnCoordinatorDeps {
  sleep(ms: number): Promise<void>;
  now(): number;
}

export async function coordinateTurn(
  wrapper: AgentWrapper,
  reporter: TurnReporter,
  options: { prompt: string; progressIntervalMs: number; maxWaitMs: number; maxProgressUpdates?: number },
  deps: TurnCoordinatorDeps
): Promise<void> {
  const startedAt = deps.now();
  await wrapper.submit(options.prompt);

  let progressCount = 0;
  let lastPreview = "";
  while (deps.now() - startedAt <= options.maxWaitMs) {
    const status = await wrapper.status();
    if (status.state === "final") {
      const sameAsPreview = normalize(status.text) !== "" && normalize(status.text) === normalize(lastPreview);
      await reporter.final(status.text, status.source, sameAsPreview);
      return;
    }
    if (status.state === "failed") {
      await reporter.failed(status.reason);
      return;
    }
    await deps.sleep(options.progressIntervalMs);
    const elapsed = Math.floor((deps.now() - startedAt) / 1000);
    const preview = status.preview?.trim();
    // Publishing cadence is Coordinator policy. Adapters report facts only;
    // Telegram receives a neutral heartbeat on every configured interval and
    // a preview only when that preview changed.
    if (options.maxProgressUpdates === undefined || options.maxProgressUpdates < 0 || progressCount < options.maxProgressUpdates) {
      progressCount += 1;
      await reporter.progress(elapsed, preview && preview !== lastPreview ? preview : undefined);
      if (preview) lastPreview = preview;
    }
  }
  await reporter.failed("Timed out waiting for the agent response.");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
