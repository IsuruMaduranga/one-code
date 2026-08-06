import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistIfLarge, PERSIST_MAX_BYTES } from "../../extensions/lib/persisted-output.ts";

describe("persistIfLarge", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-persist-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes small output through untouched, writing nothing", () => {
		const text = "line 1\nline 2";
		expect(persistIfLarge(text, { dir, id: "toolu_01" })).toBe(text);
		expect(existsSync(join(dir, "tool-results"))).toBe(false);
	});

	it("persists oversized output and returns the Claude Code block", () => {
		const text = "x".repeat(PERSIST_MAX_BYTES + 1);
		const block = persistIfLarge(text, { dir, id: "toolu_01AbC" });

		const file = join(dir, "tool-results", "toolu_01AbC.txt");
		expect(readFileSync(file, "utf-8")).toBe(text);
		expect(block).toContain("<persisted-output>");
		expect(block).toContain(`Output too large (50.0KB). Full output saved to: ${file}`);
		expect(block).toContain("Preview (first 2KB):");
		expect(block).toContain("x".repeat(2048));
		expect(block.endsWith("...\n</persisted-output>")).toBe(true);
		// The whole point: the block is a fraction of the original.
		expect(block.length).toBeLessThan(3000);
	});

	it("sanitises the id so a hostile tool-call id cannot escape tool-results/", () => {
		const text = "y".repeat(PERSIST_MAX_BYTES + 1);
		persistIfLarge(text, { dir, id: "../../evil/../id" });
		expect(existsSync(join(dir, "tool-results", ".._.._evil_.._id.txt"))).toBe(true);
	});

	it("degrades to the preview with the error named when the write fails", () => {
		const text = "z".repeat(PERSIST_MAX_BYTES + 1);
		// A file where the tool-results *directory* should be makes mkdir fail.
		writeFileSync(join(dir, "tool-results"), "");
		const block = persistIfLarge(text, { dir, id: "id" });
		expect(block).toContain("could not be saved");
		expect(block).toContain("Preview (first 2KB):");
		expect(block.length).toBeLessThan(3000);
	});

	it("respects custom limits", () => {
		const text = "abcdefghij";
		const block = persistIfLarge(text, { dir, id: "small", maxBytes: 5, previewBytes: 3 });
		expect(block).toContain("abc");
		expect(block).not.toContain("abcdefghij\n");
		expect(readFileSync(join(dir, "tool-results", "small.txt"), "utf-8")).toBe(text);
	});
});
