import { describe, it, expect } from "vitest";
import { formatLastReadback } from "../src/commands.js";
import type { ThreadMapping } from "../src/types.js";

const ECHO_MAPPING: ThreadMapping = {
  pane_id: "w1:pZ",
  label: "Echo",
  agent: "pi",
  created_at: "x",
};

describe("formatLastReadback", () => {
  const fixedTs = "2026-07-25T13:00:00.000Z";

  it("includes timestamp, label and the cleaned pane content", () => {
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: "echo says hi\n",
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });
    expect(out).toContain(fixedTs);
    expect(out).toContain("Echo");
    expect(out).toContain("echo says hi");
    expect(out).not.toContain("painel imprimindo");
  });

  it("truncates content longer than the configured limit", () => {
    // Realistic natural-language lines under the 300-char line filter.
    const line = "the agent says hello and continues to explain things";
    const big = Array.from({ length: 200 }, () => line).join("\n");
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: big,
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });
    expect(out).toMatch(/\(\.\.\. \d+ chars omitted\)/);
    expect(out.length).toBeLessThan(big.length);
  });

  it("does not truncate content shorter than the limit", () => {
    const small = "short message";
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: small,
      busy: false,
      now: () => fixedTs,
      truncateAt: 3000,
    });
    expect(out).not.toMatch(/chars omitted/);
    expect(out).toContain(small);
  });

  it("appends a busy hint when busy=true", () => {
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: "still working\n",
      busy: true,
      now: () => fixedTs,
      truncateAt: 3000,
    });
    expect(out).toContain("(painel imprimindo");
  });

  it("honors a custom truncateAt for unit tests", () => {
    const line = "natural language sentence for the test";
    const out = formatLastReadback({
      mapping: ECHO_MAPPING,
      rawPane: Array.from({ length: 20 }, () => line).join("\n"),
      busy: false,
      now: () => fixedTs,
      truncateAt: 50,
    });
    expect(out).toMatch(/\(\.\.\. \d+ chars omitted\)/);
  });
});
