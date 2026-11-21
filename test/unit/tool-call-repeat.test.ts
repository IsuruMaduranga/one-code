import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRowUnit, REPEAT_CHECK_EVERY, REPEAT_LIMITS, repeatLimit, repeatingUnit, trailingRepeat, type RepeatTail } from "../../extensions/request/tool-call-corruption/repeat.ts";

/** Stream `raw` in `chunk`-sized deltas; the first runaway seen, with how many characters had streamed by then. */
function stream(raw: string, limit: number, chunk = 17): { unit: string; at: number; chars?: number } | undefined {
	let state: RepeatTail | undefined;
	for (let at = 0; at < raw.length; at += chunk) {
		const result = trailingRepeat(state, raw.slice(at, at + chunk), limit);
		state = result.state;
		if (result.unit !== undefined) return { unit: result.unit, at: Math.min(at + chunk, raw.length), chars: result.chars };
	}
	return undefined;
}

const incident = JSON.parse(readFileSync(join(__dirname, "fixtures", "runaway-repeat-incident.json"), "utf8")) as { toolName: string; rawArguments: string };

describe("a tool call's arguments ending in one unit repeated", () => {
	it("catches the incident's runaway bash call within the shell limit, naming the unit", () => {
		const hit = stream(incident.rawArguments, repeatLimit(incident.toolName));
		expect(hit).toBeDefined();
		expect(hit!.unit.replace(/\s+/g, " ").trim()).toBe("Lspnull");
		// Its repetition starts about 360 characters in; the check needs the shell limit plus one check interval.
		expect(hit!.at).toBeLessThan(360 + REPEAT_LIMITS.shell + 1_024);
	});

	it("finds the smallest unit, and leaves blank space alone to the padding check", () => {
		expect(repeatingUnit("abcabcabcabc")).toBe("abc");
		expect(repeatingUnit("x".repeat(100))).toBe("x");
		expect(repeatingUnit(" ".repeat(100))).toBeUndefined();
		expect(repeatingUnit("\\n".repeat(100))).toBe("\\n");
		expect(repeatingUnit("hello world, this is ordinary text")).toBeUndefined();
	});

	it("does not fire on ordinary arguments of any size", () => {
		const prose = Array.from({ length: 400 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog ${i * 7}.`).join("\\n");
		const csv = Array.from({ length: 2_000 }, (_, i) => `${i},item-${i},${(i * 13) % 97},ok`).join("\\n");
		for (const raw of [JSON.stringify({ command: `cat <<'EOF' > notes.txt\n${prose}\nEOF` }), JSON.stringify({ content: csv })]) {
			expect(stream(raw, REPEAT_LIMITS.short)).toBeUndefined();
		}
	});

	it("gives file content and unknown tools room for legitimate repetition", () => {
		const zeros = JSON.stringify({ path: "blank.bin.b64", content: "A".repeat(40_000) });
		const rows = JSON.stringify({ path: "fixture.csv", content: "0,0,0,0\\n".repeat(5_000) });
		expect(repeatLimit("write")).toBe(REPEAT_LIMITS.content);
		expect(repeatLimit("edit")).toBe(REPEAT_LIMITS.content);
		expect(repeatLimit("mcp__server__upload")).toBe(REPEAT_LIMITS.content);
		expect(stream(zeros, repeatLimit("write"))).toBeUndefined();
		expect(stream(rows, repeatLimit("write"))).toBeUndefined();
		// The same text in a short-argument tool is a runaway.
		expect(stream(JSON.stringify({ pattern: "A".repeat(40_000) }), repeatLimit("grep"))?.unit).toBe("A");
	});

	it("fires on file content once it repeats past the content limit", () => {
		const runaway = JSON.stringify({ path: "out.txt", content: "Lspnull  ".repeat(10_000) });
		expect(stream(runaway, repeatLimit("write"))?.unit.trim()).toBe("Lspnull");
	});

	it("keeps only the tail it needs, whatever the call's size", () => {
		let state: RepeatTail | undefined;
		for (let i = 0; i < 2_000; i++) state = trailingRepeat(state, `row ${i} of a long call\n`, REPEAT_LIMITS.short).state;
		// What the last check kept, plus what streamed since (under one check's worth and one delta).
		expect(state!.tail.length).toBeLessThanOrEqual(REPEAT_LIMITS.short + 64 + REPEAT_CHECK_EVERY + 32);
	});

	it("B3: lets a legitimate call repeat whole rows past its tool's limit", () => {
		const row = "2026-11-21 12:00:00 INFO worker heartbeat ok";
		// A heredoc of 300 identical rows (13 KB) in bash, past the shell limit.
		const heredoc = JSON.stringify({ command: `cat <<'EOF' > rows.txt\n${`${row}\n`.repeat(300)}EOF`, description: "Write the fixture rows" });
		expect(heredoc.length).toBeGreaterThan(REPEAT_LIMITS.shell + REPEAT_CHECK_EVERY);
		expect(stream(heredoc, repeatLimit("bash"))).toEqual(undefined);
		// An Agent prompt pasting one log line 100 times (4.5 KB), past the short limit.
		const prompt = JSON.stringify({ task: `Find why the worker repeats this line:\n${`${row}\n`.repeat(100)}What causes it?`, subagent_type: "explore" });
		expect(prompt.length).toBeGreaterThan(REPEAT_LIMITS.short + REPEAT_CHECK_EVERY);
		expect(stream(prompt, repeatLimit("Agent"))).toBeUndefined();
	});

	it("B3: still stops rows that keep repeating to the row limit, and blank lines at the tool's own limit", () => {
		const runawayRows = JSON.stringify({ command: "Lspnull\n".repeat(12_000) });
		const hit = stream(runawayRows, repeatLimit("bash"));
		expect(hit?.unit).toContain("Lspnull");
		expect(hit?.chars).toBe(REPEAT_LIMITS.lines);
		expect(hit!.at).toBeLessThan(REPEAT_LIMITS.lines + 2 * REPEAT_CHECK_EVERY);
		// Escaped blank lines are not rows: the short limit applies, as before.
		const blank = stream(JSON.stringify({ pattern: "\n".repeat(5_000) }), repeatLimit("grep"));
		expect(blank?.chars).toBe(REPEAT_LIMITS.short);
		expect(isRowUnit("\\n\\n")).toBe(false);
		expect(isRowUnit("ok\\n")).toBe(true);
		expect(isRowUnit("Lspnull ")).toBe(false);
	});

	it("reads a row's line break in any JSON escape, and an escaped backslash before n as none", () => {
		// Rows whose line break streams as a Unicode escape are rows: past the short limit, not stopped there.
		for (const escape of ["\\u000a", "\\u000A", "\\r\\n"]) {
			const raw = `{"task":"Find why this repeats: ${`ok${escape}`.repeat(1_000)}"}`;
			expect(raw.length).toBeGreaterThan(REPEAT_LIMITS.short + REPEAT_CHECK_EVERY);
			expect(stream(raw, repeatLimit("Agent"))).toBeUndefined();
			expect(isRowUnit(`ok${escape}`)).toBe(true);
		}
		expect(isRowUnit("u000aok\\")).toBe(true);
		expect(isRowUnit("\\u0020\\u000a")).toBe(false);
		// A backslash and an n, escaped as \\n in the arguments, holds no line break: still stopped at the short limit.
		const literal = JSON.stringify({ pattern: String.raw`ok\n`.repeat(2_000) });
		expect(stream(literal, repeatLimit("grep"))?.chars).toBe(REPEAT_LIMITS.short);
		expect(isRowUnit(String.raw`ok\\n`)).toBe(false);
		expect(isRowUnit("\\nok\\")).toBe(false);
		expect(isRowUnit("\\\\")).toBe(false);
	});
});
