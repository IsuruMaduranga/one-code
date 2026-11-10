/**
 * Instruction files may take at most half the model's context window; past it
 * the largest are not loaded. A skipped file's slot carries a note with its
 * path and size, and the user is warned at
 * startup, before the prompt after a model switch that crosses the line, and on
 * a nested attach (decisions/memory-state.md, "Instruction files may take half
 * the window; past it the largest are skipped"). The note's wording and the
 * instructions wiring over Claude Code's instruction files (One Code's
 * source provider): profile/test/instruction-budget-wording.test.ts and
 * profile/test/instruction-budget-wiring.test.ts.
 */
import { describe, expect, it } from "vitest";
import { fitToWindow, skippedInstructionNote, skippedInstructionWarning } from "../../extensions/lib/context/instruction-budget.ts";
import { estimateTextTokens } from "../../extensions/lib/models/pi-ai-estimate.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";

/** A file body of 24,000 characters, and pi-ai's token estimate for it (its chars-per-token depends on pi's version). */
const BIG = "x".repeat(24_000);
const T = estimateTextTokens(BIG);

describe("instruction budget", () => {
	it("skips a file over half the window, never one at half, never without a window", () => {
		const one = [{ path: "/a", content: BIG }];
		expect(fitToWindow(one, 2 * T - 1).skipped).toEqual([{ path: "/a", tokens: T, contextWindow: 2 * T - 1 }]);
		expect(fitToWindow(one, 2 * T).skipped).toEqual([]);
		expect(fitToWindow(one, undefined)).toEqual({ files: one, skipped: [], loaded: T });
		expect(fitToWindow(one, 0).skipped).toEqual([]);
	});

	it("replaces only the oversized file, keeping its path and descriptor", () => {
		const files = [
			{ path: "/p/CLAUDE.md", descriptor: "project", content: BIG },
			{ path: "/p/CLAUDE.local.md", descriptor: "local", content: "small\n" },
		];
		const { files: fitted, skipped } = fitToWindow(files, T);
		expect(skipped).toEqual([{ path: "/p/CLAUDE.md", tokens: T, contextWindow: T }]);
		expect(fitted[0]).toEqual({ path: "/p/CLAUDE.md", descriptor: "project", content: skippedInstructionNote(T, T) });
		expect(fitted[1]).toBe(files[1]);
	});

	it("skips the largest of files that each fit until the rest fit together", () => {
		const larger = `${BIG}${"y".repeat(4_000)}`;
		const files = [
			{ path: "/a", content: BIG },
			{ path: "/b", content: larger },
			{ path: "/c", content: "small" },
		];
		// Half of 3T is 1.5T: /a and /b each fit, together they do not; /b is the larger.
		const fit = fitToWindow(files, 3 * T);
		expect(fit.skipped.map((file) => file.path)).toEqual(["/b"]);
		expect(fit.files[0]).toBe(files[0]);
		expect(fit.files[2]).toBe(files[2]);
		// Together within the share: all load.
		expect(fitToWindow(files, 6 * T).skipped).toEqual([]);
	});

	it("counts tokens other loaded files already take", () => {
		const one = [{ path: "/nested", content: BIG }];
		// Alone it fits half of 3T; beside T already loaded it does not.
		expect(fitToWindow(one, 3 * T).skipped).toEqual([]);
		expect(fitToWindow(one, 3 * T, { used: T }).skipped.map((file) => file.path)).toEqual(["/nested"]);
		// The note in its slot counts.
		expect(fitToWindow(one, 3 * T, { used: T }).loaded).toBe(T + estimateTextTokens(skippedInstructionNote(T, 3 * T)));
	});

	it("counts the note's tokens, so the notes and the kept files together stay within the share", () => {
		const files = [
			{ path: "/a", content: BIG },
			{ path: "/b", content: `${BIG}${"y".repeat(400)}` },
		];
		const note = (tokens: number, window: number) => `${skippedInstructionNote(tokens, window)}${"n".repeat(1_000)}`;
		const noteTokens = estimateTextTokens(note(T, 0));
		// Half of this window holds /a alone, but not /a beside /b's note: both go.
		const window = 2 * T + noteTokens;
		expect(fitToWindow(files, window).skipped.map((file) => file.path)).toEqual(["/b"]);
		const fit = fitToWindow(files, window, { note });
		expect(fit.skipped.map((file) => file.path)).toEqual(["/a", "/b"]);
		expect(fit.loaded).toBeLessThanOrEqual(window / 2);
	});

	it("passes over a file no larger than its note to skip a smaller one that frees tokens", () => {
		const imported = Array.from({ length: 50 }, (_, i) => `/p/some/long/directory/path/imported-${i}.md`);
		const files = [
			{ path: "/a", content: "a".repeat(1_200), imported },
			{ path: "/b", content: "b".repeat(800) },
		];
		const [a, b] = files.map((file) => estimateTextTokens(file.content));
		expect(estimateTextTokens(skippedInstructionNote(a, 0, imported))).toBeGreaterThanOrEqual(a);
		const window = 2 * (a + estimateTextTokens(skippedInstructionNote(b, 0)) + 20);
		expect(a + b).toBeGreaterThan(window / 2);
		expect(fitToWindow(files, window).skipped.map((file) => file.path)).toEqual(["/b"]);
	});

	it("keeps a file no larger than its note", () => {
		const files = [{ path: "/tiny", content: "tiny rules" }];
		expect(fitToWindow(files, 2).skipped).toEqual([]);
	});

	it("skips the earlier of two files of one size, keeping the more specific", () => {
		const files = [
			{ path: "/global", content: BIG },
			{ path: "/project", content: BIG },
		];
		expect(fitToWindow(files, 3 * T).skipped.map((file) => file.path)).toEqual(["/global"]);
	});

	it("hands the profile's note the size, the window and the files a section inlines", () => {
		const context = requireText("context");
		expect(skippedInstructionNote(210_000, 200_000)).toBe(context.skippedInstruction({ tokens: 210_000, contextWindow: 200_000, imported: [] }));
		expect(skippedInstructionNote(210_000, 200_000, ["/p/big.md"])).toBe(context.skippedInstruction({ tokens: 210_000, contextWindow: 200_000, imported: ["/p/big.md"] }));
	});

	it("formats sizes as pi does", () => {
		expect(skippedInstructionWarning("~/CLAUDE.md", { tokens: 600_000, contextWindow: 1_000_000 })).toContain("~/CLAUDE.md (~600k tokens) is not loaded: instruction files may take at most half of this model's 1.0M-token context window");
	});
});
