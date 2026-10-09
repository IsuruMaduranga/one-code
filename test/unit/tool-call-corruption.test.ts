import { describe, expect, it } from "vitest";
import { scanToolCallMarkup, toolCallCorruptionReason } from "../../extensions/lib/tool-call-corruption.ts";

describe("toolCallCorruptionReason", () => {
	it("rejects multiple JSON objects concatenated in one streamed call", () => {
		expect(toolCallCorruptionReason("bash", '{"command":"pwd"}{"command":"ls"}')).toMatchObject({ kind: "corrupt", reason: expect.stringMatching(/JSON/) });
	});

	it("rejects trailing data and incomplete JSON", () => {
		for (const raw of ['{} trailing', '{}\n{}', '{"command":']) {
			expect(toolCallCorruptionReason("Agent", raw)?.reason).toMatch(/JSON/);
		}
	});

	it("allows a parameterless call that streamed no argument text", () => {
		expect(toolCallCorruptionReason("cron_list", "")).toBeUndefined();
		expect(toolCallCorruptionReason("exit_plan_mode", "  ")).toBeUndefined();
	});

	it.each(["bash", "powershell", "monitor"])("rejects the escaped-quote truncation on %s", (tool) => {
		const raw = '{"command":"grep -rn \\\"","run_in_background":false}';
		expect(JSON.parse(raw).command).toBe('grep -rn "');
		expect(toolCallCorruptionReason(tool, raw)).toMatchObject({ kind: "corrupt", reason: expect.stringMatching(/double quote/) });
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
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: String.raw`echo \\"` }))?.reason).toMatch(/double quote/);
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: `echo 'a " inside' "` }))?.reason).toMatch(/double quote/);
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

	it("suspects a command cut off before an escaped quote (Morph's spaced shape)", () => {
		expect(toolCallCorruptionReason("bash", '{ "command": "grep -rn "\t, "timeout": 120000 }')).toMatchObject({ kind: "suspect", reason: expect.stringContaining('"-rn"') });
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: "python3 -c " }))?.kind).toBe("suspect");
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: "git commit -m " }))?.kind).toBe("suspect");
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: "grep -rn x src --include=" }))).toMatchObject({ kind: "suspect", reason: expect.stringContaining('"--include="') });
		expect(toolCallCorruptionReason("monitor", JSON.stringify({ command: "tail -f\t" }))?.kind).toBe("suspect");
	});

	it.each([
		"ls  ",
		"ls\n",
		"cat <<EOF\nx\nEOF\n",
		"a == b",
		"export FOO=",
		"base64 -d <<< SGVsbG8=",
		"FOO= make",
		"npm test ",
		"git status ",
		"cat > notes.md <<'EOF'\nThe 5\" floppy\nEOF\necho \"done\"",
		"cat <<EOF > a.txt\nsay \"hi\nEOF\necho \"x\"",
		"# measure 3\" pipe\nls \"a b\"",
		"ls \"a b\" # the 3\" pipe\necho \"x\"",
	])("allows a valid shell command: %j", (command) => {
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command }))).toBeUndefined();
	});

	it("still sees an unbalanced quote next to a '#' that does not start a comment", () => {
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: 'echo a#b "' }))?.kind).toBe("corrupt");
		expect(toolCallCorruptionReason("bash", JSON.stringify({ command: 'echo "a #b" "' }))?.kind).toBe("corrupt");
	});

	it("allows PowerShell here-strings and comments with an odd quote", () => {
		expect(toolCallCorruptionReason("powershell", JSON.stringify({ command: '@"\n5" disk\n"@ | Set-Content a.txt; Write-Host "x"' }))).toBeUndefined();
		expect(toolCallCorruptionReason("powershell", JSON.stringify({ command: "@'\n5\" disk\n'@ | Set-Content a.txt; Write-Host \"x\"" }))).toBeUndefined();
		expect(toolCallCorruptionReason("powershell", JSON.stringify({ command: '# a 3" pipe\nWrite-Host "x"' }))).toBeUndefined();
	});

	it("leaves a trailing space alone on non-shell tools", () => {
		expect(toolCallCorruptionReason("Agent", JSON.stringify({ command: "grep -rn " }))).toBeUndefined();
	});
});

describe("scanToolCallMarkup", () => {
	const leak = '{"path": "src/a.py</arg_value></tool_call><tool_call>read<arg_key>limit</arg_key><arg_value>null</arg_value><arg_key>path';

	it("counts GLM tool-call markup leaked into JSON arguments", () => {
		expect(scanToolCallMarkup(leak, 0).count).toBe(3);
	});

	it("counts each match once when the text arrives in deltas", () => {
		let text = "";
		let next = 0;
		let count = 0;
		for (const char of leak.repeat(3)) {
			text += char;
			const scan = scanToolCallMarkup(text, next);
			count += scan.count;
			next = scan.next;
		}
		expect(count).toBe(9);
	});

	it("reaches the limit on a single leaked call (Morph, 2026-10-05)", () => {
		const raw = '{"path": "src/text_utils.py</arg_value></tool_call><tool_call>bash<arg_key>command</arg_key><arg_value>python3 -c ", "offset": null}';
		expect(scanToolCallMarkup(raw, 0).count).toBe(2);
	});

	it("ignores lone tags and ordinary angle brackets", () => {
		expect(scanToolCallMarkup('{"content":"<tool_call> and </arg_value> a < b > c"}', 0).count).toBe(0);
	});

	const tags = "</arg_value><arg_key>x</arg_key><arg_value>";

	it("counts markup in file content written or edited on its own, apart from the call's other arguments", () => {
		expect(scanToolCallMarkup(JSON.stringify({ path: "a.test.ts", content: `expect("${tags}")` }), 0)).toMatchObject({ count: 0, contentCount: 2 });
		expect(scanToolCallMarkup(JSON.stringify({ path: "a.ts", edits: [{ oldText: tags, newText: `${tags}!` }] }), 0)).toMatchObject({ count: 0, contentCount: 4 });
		expect(scanToolCallMarkup(JSON.stringify({ cell_id: "c1", new_source: tags }), 0)).toMatchObject({ count: 0, contentCount: 2 });
		expect(scanToolCallMarkup(JSON.stringify({ content: `say "hi" \\" ${tags}` }), 0)).toMatchObject({ count: 0, contentCount: 2 });
	});

	it("still counts markup in a write's path or after its content string closed", () => {
		expect(scanToolCallMarkup(`{"path": "a.py${tags}`, 0)).toMatchObject({ count: 2, contentCount: 0 });
		expect(scanToolCallMarkup(`{"content": "ok", "path": "a.py${tags}`, 0)).toMatchObject({ count: 2, contentCount: 0 });
		expect(scanToolCallMarkup(JSON.stringify({ command: `echo ${tags}` }), 0)).toMatchObject({ count: 2, contentCount: 0 });
	});

	it("classifies content markup the same when the text arrives in deltas", () => {
		const raw = JSON.stringify({ path: "a.ts", content: `a "quoted" ${tags} b \\ ${tags}` }) + `{"path": "b${tags}`;
		let text = "";
		let next = 0;
		let count = 0;
		let contentCount = 0;
		for (const char of raw) {
			text += char;
			const scan = scanToolCallMarkup(text, next);
			count += scan.count;
			contentCount += scan.contentCount;
			next = scan.next;
		}
		expect({ count, contentCount }).toEqual({ count: 2, contentCount: 4 });
	});
});
