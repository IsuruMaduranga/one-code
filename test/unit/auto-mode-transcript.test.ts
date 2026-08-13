import { describe, expect, it } from "vitest";
import { ccToolName, renderTranscript, type TranscriptEntry } from "../../extensions/auto-mode/transcript.ts";

describe("ccToolName", () => {
	it("maps native snake_case names to Claude Code's PascalCase", () => {
		expect(ccToolName("bash")).toBe("Bash");
		expect(ccToolName("edit")).toBe("Edit");
		expect(ccToolName("find")).toBe("Glob");
		expect(ccToolName("subagent")).toBe("Task");
		expect(ccToolName("web_fetch")).toBe("WebFetch");
	});

	it("passes unknown names (including mcp__) through unchanged", () => {
		expect(ccToolName("mcp__server__tool")).toBe("mcp__server__tool");
	});
});

describe("renderTranscript", () => {
	const entries: TranscriptEntry[] = [
		{ kind: "user", text: "clean up /tmp/x" },
		{ kind: "tool", tool: "bash", input: { command: "rm -rf /tmp/x" } },
		{ kind: "tool", tool: "edit", input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" } },
	];

	it("wraps the lines in a <transcript> block", () => {
		const out = renderTranscript(entries);
		expect(out.startsWith("<transcript>\n")).toBe(true);
		expect(out.endsWith("\n</transcript>")).toBe(true);
	});

	it("renders a user message as {\"user\":…}", () => {
		expect(renderTranscript([entries[0]])).toContain('{"user":"clean up /tmp/x"}');
	});

	it("renders bash as the command string, others as the input object", () => {
		const out = renderTranscript(entries);
		expect(out).toContain('{"Bash":"rm -rf /tmp/x"}');
		expect(out).toContain('{"Edit":{"file_path":"/repo/a.ts"');
	});

	it("never carries tool results — only inputs are ever passed in", () => {
		// The type has no result channel; this asserts the contract stays that way.
		const out = renderTranscript([{ kind: "tool", tool: "read", input: { file_path: "/x" } }]);
		expect(out).not.toContain("result");
	});

	it("clips an oversized field so one argument cannot dominate", () => {
		const out = renderTranscript([{ kind: "tool", tool: "bash", input: { command: "x".repeat(50_000) } }], {
			maxField: 100,
		});
		expect(out).toContain("truncated");
		expect(out.length).toBeLessThan(1000);
	});

	it("drops oldest entries past the char budget but always keeps the action under review", () => {
		const many: TranscriptEntry[] = Array.from({ length: 50 }, (_v, i) => ({
			kind: "tool",
			tool: "bash",
			input: { command: `echo step-${i} ${"x".repeat(200)}` },
		}));
		many.push({ kind: "tool", tool: "bash", input: { command: "THE-ACTION-UNDER-REVIEW" } });
		const out = renderTranscript(many, { maxChars: 2000 });
		expect(out).toContain("THE-ACTION-UNDER-REVIEW"); // last entry always kept
		expect(out).toContain("omitted for length");
		expect(out).not.toContain("step-0 ");
	});
});
