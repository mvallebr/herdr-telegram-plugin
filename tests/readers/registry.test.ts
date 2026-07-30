import { describe, it, expect } from "vitest";
import { createAgentOutputReader } from "../../src/readers/registry.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("createAgentOutputReader — unknown agent", () => {
  it("returns a scrape reader when no structured source is known", () => {
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "agy",
      session: undefined,
      readPane: () => "scraped",
      logger,
    });
    expect(reader.kind).toBe("scrape");
    expect(reader.read(100)).toBe("scraped");
  });
});

describe("ScrapeReader", () => {
  it("strips terminal status bars at the scrape boundary", () => {
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "agy",
      session: undefined,
      readPane: () => "real output\nModel: something",
      logger,
    });
    expect(reader.read(100)).toBe("real output");
  });
});
