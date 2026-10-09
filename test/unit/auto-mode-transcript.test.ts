import { describe, expect, it } from "vitest";
import { actionLength, ccToolName, MAX_ACTION_CHARS, renderTranscript, type TranscriptEntry } from "../../extensions/auto-mode/transcript.ts";

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

	it("preserves oversized earlier fields, which can contain creation evidence", () => {
		const out = renderTranscript(
			[
				{ kind: "tool", tool: "bash", input: { command: "x".repeat(50_000) } },
				{ kind: "tool", tool: "bash", input: { command: "ls" } },
			],
		);
		expect(out).not.toContain("truncated");
		expect(out).toContain("x".repeat(50_000));
	});

	// AUTO-MODE-SECURITY-REVIEW-2026-09-24 M1: the tool runs the whole input, so
	// a suffix past the clip ran unseen by the classifier.
	it("never clips the action under review", () => {
		const command = `python3 -c "${"# pad\n".repeat(400)}print('HIDDEN_ACTION')"`;
		const out = renderTranscript([{ kind: "tool", tool: "bash", input: { command } }]);
		expect(out).not.toContain("truncated");
		expect(out).toContain("HIDDEN_ACTION");
		expect(actionLength([{ kind: "tool", tool: "bash", input: { command } }])).toBeGreaterThan(MAX_ACTION_CHARS / 100);
	});

	it("keeps the earlier entries and the action under review without a rolling budget", () => {
		const many: TranscriptEntry[] = Array.from({ length: 50 }, (_v, i) => ({
			kind: "tool",
			tool: "bash",
			input: { command: `echo step-${i} ${"x".repeat(200)}` },
		}));
		many.push({ kind: "tool", tool: "bash", input: { command: "THE-ACTION-UNDER-REVIEW" } });
		const out = renderTranscript(many);
		expect(out).toContain("THE-ACTION-UNDER-REVIEW"); // last entry always kept
		expect(out).not.toContain("omitted for length");
		expect(out).toContain("step-0 ");
	});
});

describe("rule denials", () => {
	it("renders a denial as its own line, naming the rule and what was attempted", () => {
		const out = renderTranscript([
			{ kind: "user", text: "Delete scripts/slow_build.sh" },
			{ kind: "denied", tool: "bash", subject: "rm scripts/slow_build.sh", rule: "Bash(rm:*)" },
			{ kind: "tool", tool: "bash", input: { command: "python3 -c \"import os; os.remove('scripts/slow_build.sh')\"" } },
		]);
		expect(out).toContain('"denied_by_permission_rule"');
		expect(out).toContain('"rule":"Bash(rm:*)"');
		expect(out).toContain('"attempted":"rm scripts/slow_build.sh"');
		expect(out).toContain('"tool":"Bash"');
	});

	it("keeps the whole denied subject so an equivalent-effect retry cannot hide its suffix", () => {
		const out = renderTranscript(
			[
				{ kind: "denied", tool: "bash", subject: "x".repeat(5000), rule: "Bash(rm:*)" },
				{ kind: "tool", tool: "bash", input: { command: "ls" } },
			],
		);
		expect(out).not.toContain("truncated");
		expect(out).toContain("x".repeat(5000));
	});
});

