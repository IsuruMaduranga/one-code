/**
 * One Code's memory wording: the system prompt's memory section and the
 * warning under a MEMORY.md index cut at its load limits. The base's
 * memory.test.ts checks where the cut falls and what it passes the profile.
 */
import { describe, expect, it } from "vitest";
import { INDEX_MAX_CHARS, INDEX_MAX_LINES, truncateIndex } from "../../extensions/lib/context/memory-content.ts";
import { memoryPromptSection } from "../text/system-prompt/memory.ts";

describe("memoryPromptSection", () => {
	it("names the directory and describes the file format", () => {
		const section = memoryPromptSection("/Users/u/.claude/projects/-tmp-project/memory");
		expect(section).toContain("# Memory");
		expect(section).toContain("/Users/u/.claude/projects/-tmp-project/memory/");
		expect(section).toContain("MEMORY.md");
		expect(section).toContain("type: user | feedback | project | reference");
	});

	it("is deterministic for a given directory (both variants)", () => {
		const dir = "/Users/u/.claude/projects/-p/memory";
		expect(memoryPromptSection(dir)).toBe(memoryPromptSection(dir));
		expect(memoryPromptSection(dir, true)).toBe(memoryPromptSection(dir, true));
	});

	it("verbose mode adds the long spec and differs from compact", () => {
		const dir = "/Users/u/.claude/projects/-p/memory";
		const verbose = memoryPromptSection(dir, true);
		expect(verbose.startsWith("# auto memory\n")).toBe(true);
		expect(verbose).toContain("write to it directly with the write tool");
		expect(verbose).toContain(`${dir}/`);
		expect(verbose).toContain("## Types of memory");
		expect(verbose).toContain("## What NOT to save in memory");
		expect(verbose).toContain("## How to save memories");
		expect(verbose).toContain("## Before recommending from memory");
		expect(verbose).not.toMatch(/\s$/); // the composer adds the blank line after it
		expect(verbose).toContain("MEMORY.md");
		expect(verbose).not.toBe(memoryPromptSection(dir, false));
	});
});

describe("One Code's MEMORY.md cut warning", () => {
	it("caps at the line limit and says what was cut, the way Claude Code does", () => {
		const long = `${Array.from({ length: INDEX_MAX_LINES + 30 }, (_, i) => `- [entry ${i + 1}](e${i + 1}.md) — one line`).join("\n")}\n`;
		const out = truncateIndex(long);
		const kept = long.split("\n").slice(0, INDEX_MAX_LINES).join("\n");
		expect(out).toBe(
			`${kept}\n\n> WARNING: MEMORY.md is 230 lines (limit: 200). Only part of it was loaded: 30 of 230 lines were cut off, starting at line 201 ("- [entry 201](e201.md) — one line"). Keep index entries to one line under ~200 chars; move detail into topic files.\n`,
		);
	});

	it("caps at the character limit at the last line break, naming both sizes", () => {
		const line = `- ${"x".repeat(98)}`; // 100 characters
		const long = Array.from({ length: 150 }, () => `${line}${"y".repeat(100)}`).join("\n"); // 150 lines of 200 chars
		const out = truncateIndex(long);
		const [kept, warning] = out.split("\n\n> WARNING: ");
		expect(kept.length).toBeLessThanOrEqual(INDEX_MAX_CHARS);
		expect(long.startsWith(kept)).toBe(true);
		expect(long[kept.length]).toBe("\n");
		expect(warning).toBe(
			`MEMORY.md is 29.4KB (limit: 24.4KB) \u2014 index entries are too long. Only part of it was loaded: 26 of 150 lines were cut off, starting at line 125 ("${`${line}${"y".repeat(100)}`.slice(0, 79)}\u2026"). Keep index entries to one line under ~200 chars; move detail into topic files.\n`,
		);
	});

	it("cuts a single overlong line at the character limit", () => {
		const out = truncateIndex("x".repeat(INDEX_MAX_CHARS + 10));
		expect(out).toContain(`Only part of it was loaded: everything after the first ${INDEX_MAX_CHARS} characters of line 1 was cut off.`);
		expect(out.endsWith("move detail into topic files.\n")).toBe(true);
	});
});
