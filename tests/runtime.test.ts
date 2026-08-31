import { describe, expect, it } from "vitest";
import { runtimeRequirementError } from "../src/runtime.js";

describe("runtime requirements", () => {
  it("rejects Node versions older than the structured-output requirement", () => {
    expect(runtimeRequirementError("18.19.1", false)).toContain("Node.js >= 22.5.0");
  });

  it("rejects Node 22 runtimes without node:sqlite", () => {
    expect(runtimeRequirementError("22.5.0", false)).toContain("node:sqlite");
  });

  it("accepts a supported Node runtime with node:sqlite", () => {
    expect(runtimeRequirementError("22.23.1", true)).toBeNull();
  });
});
