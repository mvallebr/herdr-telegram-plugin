import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const readme = readFileSync(join(root, "README.md"), "utf8");

describe("README operational instructions", () => {
  it("uses the Herdr owner/repository install form", () => {
    expect(readme).toContain("herdr plugin install mvallebr/herdr-telegram-plugin --yes");
    expect(readme).not.toContain("herdr plugin install https://github.com/");
  });

  it("documents the smoke preflight and polling recovery", () => {
    expect(readme).toContain("npm run smoke");
    expect(readme).toContain("409 Conflict");
  });
});
