import { describe, expect, it } from "vitest";
import { toolCallCorruptionReason } from "../../extensions/lib/tool-call-corruption.ts";

describe("toolCallCorruptionReason", () => {
	it("rejects multiple JSON objects concatenated in one streamed call", () => {
		expect(toolCallCorruptionReason("bash", '{"command":"pwd"}{"command":"ls"}')).toMatch(/JSON/);
	});

	it("rejects trailing data and incomplete JSON", () => {
		for (const raw of ['{} trailing', '{}\n{}', '{"command":']) {
			expect(toolCallCorruptionReason("Agent", raw)).toMatch(/JSON/);
		}
	});

	it("allows a parameterless call that streamed no argument text", () => {
		expect(toolCallCorruptionReason("cron_list", "")).toBeUndefined();
		expect(toolCallCorruptionReason("exit_plan_mode", "  ")).toBeUndefined();
	});

	it.each(["bash", "powershell", "monitor"])("rejects the escaped-quote truncation on %s", (tool) => {
		const raw = '{"command":"grep -rn \\\"","run_in_background":false}';
		expect(JSON.parse(raw).command).toBe('grep -rn "');
		expect(toolCallCorruptionReason(tool, raw)).toMatch(/double quote/);
	});

	it.each([
		'echo hello',
		'echo "hello"',
		'grep -rn "a quoted string"   ',
		`echo 'a " inside single quotes'`,
		String.raw`echo \"`,
		`echo "it's balanced"`,
		String.raw`echo "a \"quoted\" word"`,
		'echo "unclosed but not ending with a quote',
	])("allows legitimate or out-of-scope commands: %s", (command) => {
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command }))).toBeUndefined();
	});

	it("counts escaped backslashes and ignores apostrophes inside double quotes", () => {
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: String.raw`echo \\"` }))).toMatch(/double quote/);
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: `echo 'a " inside' "` }))).toMatch(/double quote/);
	});

	it("respects PowerShell's backtick escape", () => {
		expect(toolCallCorruptionReason("powershell", JSON.stringify({ command: 'Write-Output `"' }))).toBeUndefined();
		expect(toolCallCorruptionReason("powershell", JSON.stringify({ command: 'Write-Output "a `"quoted`" string"' }))).toBeUndefined();
		expect(toolCallCorruptionReason("powershell", JSON.stringify({ command: 'Write-Output "C:\\"' }))).toBeUndefined();
	});

	it("ignores trailing whitespace and JSON-looking strings", () => {
		expect(toolCallCorruptionReason("Agent", ' {"prompt":"{\\"a\\":1}{\\"b\\":2}"} \n')).toBeUndefined();
	});

	it.each(['{}', '[]', 'null', 'true', '42', '"hello"', '{"command":null}', '{"command":42}'])("allows a single JSON value without a shell command: %s", (raw) => {
		expect(toolCallCorruptionReason("bash", raw)).toBeUndefined();
	});

	it("does not inspect command quotes on non-shell tools or invent missing-argument heuristics", () => {
		expect(toolCallCorruptionReason("Agent", JSON.stringify({ command: 'echo "' }))).toBeUndefined();
		expect(toolCallCorruptionReason("Agent", '{"action":"run"}')).toBeUndefined();
	});
});
