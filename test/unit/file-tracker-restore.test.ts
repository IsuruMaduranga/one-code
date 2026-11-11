import { describe, expect, it } from "vitest";
import { RESTORE_FILE_MAX_TOKENS, restoreBlocks, restoreCandidates } from "../../extensions/safety/file-tracker/restore.ts";
import { fileTrackerText } from "../../extensions/safety/file-tracker/text.ts";

const fileTracker = fileTrackerText;

const tokens = (text: string) => Math.ceil(text.length / 4);

describe("restoreCandidates", () => {
	it("takes the five newest by modification time, after the skip list", () => {
		const touched = new Map(["a", "b", "c", "d", "e", "f", "g"].map((path, i) => [path, i]));
		expect(restoreCandidates(touched, (path) => path === "g")).toEqual(["f", "e", "d", "c", "b"]);
	});
});

describe("restoreBlocks", () => {
	it("restores a small file as a read call and result, and names a large one in a note", () => {
		const big = "x".repeat(RESTORE_FILE_MAX_TOKENS * 4 + 4);
		const { blocks, restored } = restoreBlocks(
			[
				{ path: "/w/big.txt", text: big },
				{ path: "/w/gone.txt", text: undefined },
				{ path: "/w/small.txt", text: "one\ntwo" },
			],
			tokens,
			fileTracker,
		);
		// The result block is the one that puts the file back in context.
		expect(blocks.map((block) => block.restores)).toEqual([undefined, undefined, "/w/small.txt"]);
		expect(restored).toEqual(["/w/small.txt"]);
		expect(blocks.map((block) => block.text)).toEqual([
			fileTracker.tooLargeToRestore({ path: "/w/big.txt" }),
			fileTracker.restoredCall({ path: "/w/small.txt" }),
			fileTracker.restoredResult({ text: "one\ntwo" }),
		]);
	});

	it("skips a file whose blocks would take the total past 50,000 tokens and keeps going", () => {
		const nearCap = "y".repeat(RESTORE_FILE_MAX_TOKENS * 4 - 400);
		const reads = Array.from({ length: 12 }, (_, i) => ({ path: `/w/${i}`, text: nearCap }));
		const { restored } = restoreBlocks(reads, tokens, fileTracker);
		expect(restored.length).toBe(10);
		const withSmall = restoreBlocks([...reads, { path: "/w/tiny", text: "t" }], tokens, fileTracker);
		expect(withSmall.restored.at(-1)).toBe("/w/tiny");
	});
});
