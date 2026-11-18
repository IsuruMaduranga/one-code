import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPEAT_LIMITS, repeatLimit, repeatingUnit, trailingRepeat, type RepeatTail } from "../../extensions/request/tool-call-corruption/repeat.ts";

/** Stream `raw` in `chunk`-sized deltas; the first runaway seen, with how many characters had streamed by then. */
function stream(raw: string, limit: number, chunk = 17): { unit: string; at: number } | undefined {
	let state: RepeatTail | undefined;
	for (let at = 0; at < raw.length; at += chunk) {
		const result = trailingRepeat(state, raw.slice(at, at + chunk), limit);
		state = result.state;
		if (result.runaway) return { unit: result.runaway.unit, at: Math.min(at + chunk, raw.length) };
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
		expect(state!.tail.length).toBeLessThanOrEqual(REPEAT_LIMITS.short + 64);
	});
});
