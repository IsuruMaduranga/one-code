/**
 * Instruction files may take at most half the model's context window; past it
 * the largest are not loaded. A skipped file's slot carries a note with its
 * path and size, and the user is warned at
 * startup, before the prompt after a model switch that crosses the line, and on
 * a nested attach (decisions/memory-state.md, "Instruction files may take half
 * the window; past it the largest are skipped").
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import {
	fitToWindow,
	restoredInstructionNotice,
	skippedInstructionNote,
	skippedInstructionWarning,
} from "../../extensions/lib/instruction-budget.ts";
import { estimateTextTokens } from "../../extensions/lib/pi-ai-estimate.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

/** A file body of 24,000 characters, and pi-ai's token estimate for it (its chars-per-token depends on pi's version). */
const BIG = "x".repeat(24_000);
const T = estimateTextTokens(BIG);

describe("instruction budget", () => {
	it("skips a file over half the window, never one at half, never without a window", () => {
		const one = [{ path: "/a", content: BIG }];
		expect(fitToWindow(one, 2 * T - 1).skipped).toEqual([{ path: "/a", tokens: T, contextWindow: 2 * T - 1 }]);
		expect(fitToWindow(one, 2 * T).skipped).toEqual([]);
		expect(fitToWindow(one, undefined)).toEqual({ files: one, skipped: [] });
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

	it("skips the earlier of two files of one size, keeping the more specific", () => {
		const files = [
			{ path: "/global", content: BIG },
			{ path: "/project", content: BIG },
		];
		expect(fitToWindow(files, 3 * T).skipped.map((file) => file.path)).toEqual(["/global"]);
	});

	it("tells the model the size, the window, the files a section inlines, and to read what it needs", () => {
		expect(skippedInstructionNote(210_000, 200_000)).toBe(
			"This file is not loaded: it is about 210,000 tokens, and instruction files may take at most half of this model's 200,000-token context window. " +
				"Read the parts of it that bear on your task when you need them.\n",
		);
		expect(skippedInstructionNote(210_000, 200_000, ["/p/big.md"])).toMatch(/^This file and the files it imports \(\/p\/big\.md\) are not loaded: together they are about 210,000 tokens/);
	});

	it("formats sizes as pi does", () => {
		expect(skippedInstructionWarning("~/CLAUDE.md", { tokens: 600_000, contextWindow: 1_000_000 })).toContain("~/CLAUDE.md (~600k tokens) is not loaded: instruction files may take at most half of this model's 1.0M-token context window");
	});
});

describe("claude-context: an oversized instruction file", () => {
	let fake: FakePi;
	let dir: string;
	const reminders: Array<{ key?: string; text?: string; placement?: string; toolCallId?: string }> = [];
	const model = (contextWindow: number) => ({ provider: "test", id: `m-${contextWindow}`, api: "test", contextWindow });
	const block = () => reminders.filter((r) => r.key === "claude-context").at(-1)?.text ?? "";
	const body = (marker: string) => `${marker} ${BIG}\n`;
	/** The estimate for a file written with `body`. */
	const tokens = (marker: string) => estimateTextTokens(body(marker));
	const SMALL = T; // the big file is over half of it
	const LARGE = 4 * T; // the big file fits
	/** Notices reach the UI when the notice queue's batch closes, a macrotask later. */
	const notified = async (ctx: Record<string, unknown>) => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		return ctx._notified;
	};
	const switchTo = (ctx: Record<string, unknown>, contextWindow: number) =>
		fake.fireOne("model_select", { type: "model_select", model: model(contextWindow), previousModel: undefined, source: "set" }, ctx);
	const prompt = (ctx: Record<string, unknown>) => fake.fire("before_agent_start", {}, ctx);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "instruction-budget-"));
		stubHome(dir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, ".claude"));
		writeFileSync(join(dir, "CLAUDE.md"), body("BIG-RULES"));
		writeFileSync(join(dir, "CLAUDE.local.md"), "Small rules.\n");
		fake = createFakePi();
		reminders.length = 0;
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		claudeContextExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("rides as a note in its slot, and the user is warned once", async () => {
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, model: model(SMALL) });
		await fake.fireOne("session_start", {}, ctx);
		expect(block()).not.toContain("BIG-RULES");
		expect(block()).toContain(`Contents of ${join(dir, "CLAUDE.md")} (project instructions, checked into the codebase):\n\n${skippedInstructionNote(tokens("BIG-RULES"), SMALL)}`);
		expect(block()).toContain("Small rules.");
		await prompt(ctx);
		expect(await notified(ctx)).toEqual([{ message: skippedInstructionWarning("~/CLAUDE.md", { tokens: tokens("BIG-RULES"), contextWindow: SMALL }), type: "warning" }]);
	});

	it("loads in full on a larger window; a model switch moves it across the line, told before the next prompt", async () => {
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, model: model(LARGE) });
		await fake.fireOne("session_start", {}, ctx);
		expect(block()).toContain("BIG-RULES");

		await switchTo(ctx, SMALL);
		expect(block()).not.toContain("BIG-RULES");
		// Cycling back and forth before a prompt says nothing; the prompt says the net change.
		await switchTo(ctx, LARGE);
		await switchTo(ctx, SMALL);
		expect(await notified(ctx)).toEqual([]);
		await prompt(ctx);
		expect(await notified(ctx)).toEqual([{ message: skippedInstructionWarning("~/CLAUDE.md", { tokens: tokens("BIG-RULES"), contextWindow: SMALL }), type: "warning" }]);

		await switchTo(ctx, LARGE);
		expect(block()).toContain("BIG-RULES");
		await prompt(ctx);
		expect(((await notified(ctx)) as unknown[]).at(-1)).toEqual({ message: restoredInstructionNotice("~/CLAUDE.md", LARGE), type: "info" });
	});

	it("does not rebuild the block on a switch that leaves the fit's text the same", async () => {
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, model: model(LARGE) });
		await fake.fireOne("session_start", {}, ctx);
		const emitted = reminders.filter((r) => r.key === "claude-context").length;
		await switchTo(ctx, 8 * T);
		expect(reminders.filter((r) => r.key === "claude-context")).toHaveLength(emitted);
	});

	it("skips the larger of two files that each fit when together they pass the share, warning once", async () => {
		writeFileSync(join(dir, "CLAUDE.md"), body("HALF-A"));
		writeFileSync(join(dir, "CLAUDE.local.md"), body("HALF-BIGGER"));
		const window = 2 * tokens("HALF-A") + 10;
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, model: model(window) });
		await fake.fireOne("session_start", {}, ctx);
		expect(block()).toContain("HALF-A");
		expect(block()).not.toContain("HALF-BIGGER");
		await prompt(ctx);
		await prompt(ctx);
		expect(await notified(ctx)).toEqual([{ message: skippedInstructionWarning("~/CLAUDE.local.md", { tokens: tokens("HALF-BIGGER"), contextWindow: window }), type: "warning" }]);
	});

	it("is loaded whole when the model's window is unknown", async () => {
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: dir, hasUI: true }));
		expect(block()).toContain("BIG-RULES");
	});

	it("does not mark a skipped nested file's imports as shown", async () => {
		writeFileSync(join(dir, "CLAUDE.md"), "Root rules.\n");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "rules.md"), "Imported rule.\n");
		writeFileSync(join(dir, "src", "CLAUDE.md"), `@./rules.md\n${body("NESTED-BIG")}`);
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, model: model(SMALL) });
		await fake.fireOne("session_start", {}, ctx);
		await fake.fire("tool_result", { toolName: "read", toolCallId: "r1", input: { path: "src/a.ts" }, isError: false, content: [] }, ctx);
		const recorded = fake.branch.filter((entry) => (entry as { customType?: string }).customType === "one-code:nested-instructions-shown");
		const keys = recorded.flatMap((entry) => ((entry as { data?: { keys?: string[] } }).data?.keys ?? []));
		expect(keys.some((key) => key.endsWith(join("src", "CLAUDE.md")))).toBe(true);
		expect(keys.some((key) => key.endsWith("rules.md"))).toBe(false);
	});

	it("attaches a nested file over the line as the note, with a warning", async () => {
		writeFileSync(join(dir, "CLAUDE.md"), "Root rules.\n");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "CLAUDE.md"), body("NESTED-BIG"));
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, model: model(SMALL) });
		await fake.fireOne("session_start", {}, ctx);
		await fake.fire("tool_result", { toolName: "read", toolCallId: "r1", input: { path: "src/a.ts" }, isError: false, content: [] }, ctx);
		const attached = reminders.filter((r) => r.toolCallId === "r1").map((r) => r.text);
		expect(attached).toEqual([`Contents of ${join(dir, "src", "CLAUDE.md")}:\n\n${skippedInstructionNote(tokens("NESTED-BIG"), SMALL)}`]);
		expect(await notified(ctx)).toEqual([{ message: skippedInstructionWarning("~/src/CLAUDE.md", { tokens: tokens("NESTED-BIG"), contextWindow: SMALL }), type: "warning" }]);
	});
});
