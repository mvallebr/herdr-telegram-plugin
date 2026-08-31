import { describe, expect, it } from "vitest";
import { resolveCompatibleNode } from "../src/node-runtime.js";

describe("resolveCompatibleNode", () => {
  it("skips unavailable and incompatible candidates", () => {
    expect(resolveCompatibleNode(["/missing/node", "/old/node", "/new/node"], (path) => path === "/new/node")).toBe("/new/node");
  });

  it("does not select an older Node when it appears first", () => {
    expect(resolveCompatibleNode(["/usr/bin/node", "/nvm/node"], (path) => path === "/nvm/node")).toBe("/nvm/node");
  });

  it("returns null when no candidate supports the required runtime", () => {
    expect(resolveCompatibleNode(["/old/node"], () => false)).toBeNull();
  });
});
