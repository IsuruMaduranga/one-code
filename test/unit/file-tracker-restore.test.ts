import { describe, expect, it } from "vitest";
import { keptReadPaths, lastTouchesOnBranch } from "../../extensions/file-tracker/replay.ts";
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
		expect(blocks).toEqual([tooLargeNote("/w/big.txt"), readCallBlock("/w/small.txt"), readResultBlock("one\ntwo")]);
		expect(restored).toEqual(["/w/small.txt"]);
		expect(blocks[0]).toBe(
			"Note: /w/big.txt was read before the last conversation was summarized, but the contents are too large to include. Use read tool if you need to access it.",
		);
		expect(blocks[1]).toBe('Called the read tool with the following input: {"path":"/w/small.txt"}');
		expect(blocks[2]).toBe("Result of calling the read tool:\none\ntwo");
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

const call = (id: string, name: string, path: string) => ({ type: "toolCall", id, name, arguments: { path } });
const assistant = (...content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
const result = (toolCallId: string, timestamp: number, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId, isError, timestamp } });

describe("keptReadPaths", () => {
	it("lists files a successful read in the kept turns returned, whichever path field names them", () => {
		const fileRead = { type: "toolCall", id: "4", name: "read", arguments: { file_path: "d.ts" } };
		const kept = [assistant(call("1", "read", "a.ts"), call("2", "read", "b.ts"), call("3", "edit", "c.ts"), fileRead), result("1", 1), result("2", 2, true), result("3", 3), result("4", 4)];
		expect(keptReadPaths(kept)).toEqual(["a.ts", "d.ts"]);
	});
});

describe("lastTouchesOnBranch", () => {
	it("keeps each read or written file's last successful result time", () => {
		const branch = [
			assistant(call("1", "read", "a.ts"), call("2", "write", "b.ts"), call("3", "bash", "c.ts")),
			result("1", 10),
			result("2", 20),
			result("3", 30),
			assistant(call("4", "edit", "a.ts"), call("5", "read", "b.ts")),
			result("4", 40),
			result("5", 50, true),
		];
		expect(lastTouchesOnBranch(branch)).toEqual(new Map([["a.ts", 40], ["b.ts", 20]]));
	});
});
