import { describe, expect, it } from "vitest";
import { mergeGrepWindows } from "../../extensions/search-tools/grep-merge.ts";

// pi's grep prints one window per match, so nearby matches repeated shared lines.
describe("mergeGrepWindows", () => {
	it("shows each line once, a match as a match, in order", () => {
		const text = ["a.js-1- one", "a.js:2: two", "a.js-3- three", "a.js-2- two", "a.js:3: three", "a.js-4- four"].join("\n");
		expect(mergeGrepWindows(text)).toBe(["a.js-1- one", "a.js:2: two", "a.js:3: three", "a.js-4- four"].join("\n"));
	});

	it("never merges lines of different files and keeps notices", () => {
		const text = ["a.js:1: same", "b.js:1: same", "", "[10 matches limit reached. Use limit=20 for more, or refine pattern]"].join("\n");
		expect(mergeGrepWindows(text)).toBe(text);
	});

	it("reads a row by its first separator, so text holding `:N: ` or `-N- ` still merges", () => {
		const text = ["a.yml-2- k:3: v", "a.yml:3: x-1- y", "a.yml:2: k:3: v", "a.yml-3- x-1- y"].join("\n");
		expect(mergeGrepWindows(text)).toBe(["a.yml:2: k:3: v", "a.yml:3: x-1- y"].join("\n"));
	});
});
