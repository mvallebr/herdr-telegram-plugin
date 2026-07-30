import { describe, it, expect } from "vitest";
import {
  cleanPaneOutput,
  extractResponseSince,
  extractScreenResponse,
  extractScreenDelta,
} from "../src/output-format.js";

describe("cleanPaneOutput", () => {
  it("removes multiline context-mode banner block", () => {
    const input = `some agent output
context-mode active. Hierarchy: ctx_batch_execute > ctx_execute
<session_state source="compaction">
<session_mode>implement</session_mode>
</session_state>
more agent output after`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("context-mode active");
    expect(out).not.toContain("<session_state");
    expect(out).toContain("some agent output");
    expect(out).toContain("more agent output after");
  });

  it("filters individual context-mode lines as a fallback", () => {
    const input = `context-mode active. some text
<session_mode>foo</session_mode>
real output`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("context-mode active");
    expect(out).not.toContain("<session_mode>");
    expect(out).toContain("real output");
  });

  it("filters lines containing long separator runs", () => {
    const input = `─ something nice ──────────────────────
real output`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("─");
    expect(out).toContain("real output");
  });

  it("filters lines longer than 300 chars", () => {
    const longLine = "x".repeat(500);
    const out = cleanPaneOutput(`real\n${longLine}\nafter`);
    expect(out).toContain("real");
    expect(out).toContain("after");
    expect(out).not.toContain(longLine);
  });

  it("removes <session_state> blocks without the context-mode preamble", () => {
    const input = `agent response here
<session_state source="something-else">
<session_mode>plan</session_mode>
<some_other_key>some value</some_other_key>
</session_state>
more response`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("<session_state");
    expect(out).not.toContain("</session_state>");
    expect(out).toContain("agent response here");
    expect(out).toContain("more response");
  });

  it("filters status bars / debug overlays (high non-word ratio)", () => {
    const input = `here is a normal sentence
~12 % | $0.50 | 1.2k/300k | ctx=8% | mode=implement | R=99%
the agent continued discussing the topic`;
    const out = cleanPaneOutput(input);
    expect(out).toContain("here is a normal sentence");
    expect(out).toContain("the agent continued");
    expect(out).not.toContain("ctx=8%");
  });

  it("filters lines starting with XML-like opening tags", () => {
    const input = `agent response
<tool_name>bash</tool_name>
<tool_args>ls -la</tool_args>
<result>total 42</result>
the response continues`;
    const out = cleanPaneOutput(input);
    expect(out).toContain("agent response");
    expect(out).toContain("the response continues");
    expect(out).not.toContain("<tool_name>");
    expect(out).not.toContain("<result>");
  });

  it("keeps single-line responses intact", () => {
    const out = cleanPaneOutput("São 13/07/2026, 19:21:47 (horário de Brasília).");
    expect(out).toBe("São 13/07/2026, 19:21:47 (horário de Brasília).");
  });

  it("strips ANSI escape codes from status bars before scoring", () => {
    const input = "real response\n\x1b[32m~12 % | $0.50 | 1.2k/300k\x1b[0m\nmore response";
    const out = cleanPaneOutput(input);
    expect(out).toContain("real response");
    expect(out).toContain("more response");
  });

  it("preserves lines with common emoji (🚀, ✅, 🎉)", () => {
    const input = "Recebido com sucesso! 🚀 O teste chegou perfeitamente.\nplain line";
    const out = cleanPaneOutput(input);
    expect(out).toContain("Recebido com sucesso! 🚀 O teste chegou perfeitamente.");
    expect(out).toContain("plain line");
  });

  it("preserves lines with checkmarks and other Unicode symbols (✅, ⏳, ❌)", () => {
    const input = "✅ done\n⏳ working\n❌ failed\nplain";
    const out = cleanPaneOutput(input);
    expect(out).toContain("✅ done");
    expect(out).toContain("⏳ working");
    expect(out).toContain("❌ failed");
  });

  it("preserves lines with non-Latin scripts (Cyrillic, Greek, accented)", () => {
    const input = "Olá mundo\nПривет мир\nΓειά σου Κόσμε";
    const out = cleanPaneOutput(input);
    expect(out).toContain("Olá mundo");
    expect(out).toContain("Привет мир");
    expect(out).toContain("Γειά σου Κόσμε");
  });

  it("still strips visual separators and lines that are pure ANSI noise", () => {
    const input = "real\n──────\nmore real\n\x1b[31m\x1b[0m";
    const out = cleanPaneOutput(input);
    expect(out).toContain("real");
    expect(out).toContain("more real");
    expect(out).not.toContain("──────");
    // Empty line with only ANSI escapes should be filtered as control chars
    expect(out).not.toMatch(/^\s*$/m);
  });
});

describe("extractResponseSince", () => {
  it("returns lines after user input anchor", () => {
    const content = "old\n qual a hora?\nresponse line\nmore";
    expect(extractResponseSince(content, "qual a hora?")).toBe("response line\nmore");
  });

  it("uses last non-blank line of user input as anchor", () => {
    const content = "before\n hello world\nagent says hi";
    expect(extractResponseSince(content, "hello\nworld")).toBe("agent says hi");
  });

  it("returns empty when anchor not found", () => {
    expect(extractResponseSince("some pane\ntext", "not in pane")).toBe("");
  });

  it("trims trailing separators, status bars, and empty lines", () => {
    const sep20 = "─".repeat(20);
    const content = `old\noi\nresponse text\n\n${sep20}\n~/foo · cost`;
    expect(extractResponseSince(content, "oi")).toBe("response text");
  });

  it("trims trailing shell prompts", () => {
    const content = "before\n query\nresult line\n~/cod · main $";
    expect(extractResponseSince(content, "query")).toBe("result line");
  });
});

describe("extractScreenResponse", () => {
  it("returns empty when the exact prompt is absent instead of leaking terminal text", () => {
    const content = [
      "older output",
      "› a wrapped or transformed prompt",
      "Useful final answer",
      "─".repeat(31),
      "status · 10%",
    ].join("\n");
    expect(extractScreenResponse(content, "original long prompt")).toBe("");
  });

  it("still returns the exact anchored response", () => {
    expect(extractScreenResponse("prompt\nclean reply", "prompt")).toBe("clean reply");
  });

  it("keeps an OpenCode prompt anchor after stripping its terminal border", () => {
    const prompt = "Keep it under 4000 characters. Summarize what we've been working on: original goal, progress, blockers, next steps.";
    const pane = `┃  ${prompt}\n┃\n┃  Original goal\n┃  A clean summary`;
    expect(extractScreenResponse(pane, prompt)).toBe("Original goal\nA clean summary");
  });
});

describe("extractScreenDelta", () => {
  it("returns only new terminal text when a prompt disappears after submit", () => {
    expect(extractScreenDelta("header\nold", "header\nnew answer")).toBe("new answer");
  });

  it("fails closed when there is no stable shared prefix", () => {
    expect(extractScreenDelta("old", "unrelated")).toBe("");
  });
});
