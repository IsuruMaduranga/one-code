import { describe, expect, it } from "vitest";
import {
	readCallBlock,
	readResultBlock,
	RESTORE_FILE_MAX_TOKENS,
	restoreBlocks,
	restoreCandidates,
	tooLargeNote,
} from "../../extensions/file-tracker/restore.ts";

const tokens = (text: string) => Math.ceil(text.length / 4);

describe("restoreCandidates", () => {
	it("takes the five newest by modification time, after the skip list", () => {
		const touched = new Map(["a", "b", "c", "d", "e", "f", "g"].map((path, i) => [path, i]));
		expect(restoreCandidates(touched, (path) => path === "g")).toEqual(["f", "e", "d", "c", "b"]);
	});
});

describe("restoreBlocks", () => {
	it("restores a small file as Claude Code's read call and result, and names a large one in a note", () => {
		const big = "x".repeat(RESTORE_FILE_MAX_TOKENS * 4 + 4);
		const { blocks, restored } = restoreBlocks(
			[
				{ path: "/w/big.txt", text: big },
				{ path: "/w/gone.txt", text: undefined },
				{ path: "/w/small.txt", text: "one\ntwo" },
			],
			tokens,
		);
		// The result block is the one that puts the file back in context.
		expect(blocks).toEqual([{ text: tooLargeNote("/w/big.txt") }, { text: readCallBlock("/w/small.txt") }, { text: readResultBlock("one\ntwo"), restores: "/w/small.txt" }]);
		expect(restored).toEqual(["/w/small.txt"]);
		expect(blocks[0].text).toBe(
			"Note: /w/big.txt was read before the last conversation was summarized, but the contents are too large to include. Use read tool if you need to access it.",
		);
		expect(blocks[1].text).toBe('Called the read tool with the following input: {"path":"/w/small.txt"}');
		expect(blocks[2].text).toBe("Result of calling the read tool:\none\ntwo");
	});

	it("skips a file whose blocks would take the total past 50,000 tokens and keeps going", () => {
		const nearCap = "y".repeat(RESTORE_FILE_MAX_TOKENS * 4 - 400);
		const reads = Array.from({ length: 12 }, (_, i) => ({ path: `/w/${i}`, text: nearCap }));
		const { restored } = restoreBlocks(reads, tokens);
		expect(restored.length).toBe(10);
		const withSmall = restoreBlocks([...reads, { path: "/w/tiny", text: "t" }], tokens);
		expect(withSmall.restored.at(-1)).toBe("/w/tiny");
	});
});
