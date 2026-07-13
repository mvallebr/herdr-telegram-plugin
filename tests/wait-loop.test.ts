import { describe, it, expect } from "vitest";
import { shouldThrottle, formatElapsed } from "../src/wait-loop.js";

describe("shouldThrottle", () => {
  it("returns true within throttle window", () => {
    expect(shouldThrottle(Date.now(), 3000)).toBe(true);
  });

  it("returns false after throttle window", () => {
    expect(shouldThrottle(Date.now() - 4000, 3000)).toBe(false);
  });

  it("returns false if exactly at threshold", () => {
    expect(shouldThrottle(Date.now() - 3000, 3000)).toBe(false);
  });
});

describe("formatElapsed", () => {
  it("formats seconds only", () => {
    expect(formatElapsed(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(125)).toBe("2m 5s");
  });

  it("formats hours, minutes, seconds", () => {
    expect(formatElapsed(3661)).toBe("1h 1m 1s");
  });

  it("formats zero", () => {
    expect(formatElapsed(0)).toBe("0s");
  });
});
