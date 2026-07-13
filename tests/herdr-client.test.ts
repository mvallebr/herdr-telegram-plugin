import { describe, it, expect } from "vitest";
import { parseAgentList, buildSendTextArgs, buildWaitArgs } from "../src/herdr-client.js";

describe("parseAgentList", () => {
  it("parses herdr agent list JSON output", () => {
    const raw = JSON.stringify({
      id: "cli:agent:list",
      result: {
        agents: [
          {
            agent: "pi",
            agent_status: "idle",
            cwd: "/home/user/project",
            pane_id: "w1:pZ",
            tab_id: "w1:tZ",
            workspace_id: "w1",
          },
        ],
      },
    });
    const agents = parseAgentList(raw);
    expect(agents).toHaveLength(1);
    expect(agents[0].pane_id).toBe("w1:pZ");
    expect(agents[0].agent).toBe("pi");
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseAgentList("{ invalid }")).toEqual([]);
  });

  it("returns empty array for missing result", () => {
    expect(parseAgentList('{"id":"x"}')).toEqual([]);
  });
});

describe("buildSendTextArgs", () => {
  it("builds correct args tuple", () => {
    expect(buildSendTextArgs("w1:pZ", "hello world")).toEqual([
      "pane", "run", "w1:pZ", "hello world",
    ]);
  });
});

describe("buildWaitArgs", () => {
  it("builds correct args tuple with timeout in ms", () => {
    expect(buildWaitArgs("w1:pZ", 5)).toEqual([
      "agent", "wait", "w1:pZ", "--status", "idle", "--timeout", "5000",
    ]);
  });
});
