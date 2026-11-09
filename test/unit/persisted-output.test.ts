import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistIfLarge, PERSIST_MAX_BYTES } from "../../extensions/lib/request/persisted-output.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";

const words = requireText("toolResults");
/** The block the base builds around the profile's two lines. */
const block = (saved: string, preview: string, kb = 2) => ["<persisted-output>", saved, "", words.previewHeading({ kb }), preview, "...", "</persisted-output>"].join("\n");

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
		const out = persistIfLarge(text, { dir, id: "toolu_01AbC" });

		const file = join(dir, "tool-results", "toolu_01AbC.txt");
		expect(readFileSync(file, "utf-8")).toBe(text);
		expect(out).toBe(block(words.persisted({ size: "50.0KB", file }), "x".repeat(2048)));
		// The whole point: the block is a fraction of the original.
		expect(out.length).toBeLessThan(3000);
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
		let saveError = "";
		try {
			mkdirSync(join(dir, "tool-results"), { recursive: true });
		} catch (error) {
			saveError = (error as Error).message;
		}
		expect(saveError).not.toBe("");
		const out = persistIfLarge(text, { dir, id: "id" });
		expect(out).toBe(block(words.persisted({ size: "50.0KB", file: join(dir, "tool-results", "id.txt"), saveError }), "z".repeat(2048)));
		expect(out.length).toBeLessThan(3000);
	});

	it("respects custom limits", () => {
		const text = "abcdefghij";
		const out = persistIfLarge(text, { dir, id: "small", maxBytes: 5, previewBytes: 3 });
		expect(out).toBe(block(words.persisted({ size: "0.0KB", file: join(dir, "tool-results", "small.txt") }), "abc", 0));
		expect(readFileSync(join(dir, "tool-results", "small.txt"), "utf-8")).toBe(text);
	});
});
