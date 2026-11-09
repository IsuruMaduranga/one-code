/**
 * The instruction budget over Claude Code's instruction files (One Code's
 * source provider): a CLAUDE.md over half the window rides as a note in its
 * slot, the user is warned at startup, before the prompt after a model switch
 * that crosses the line, and on a nested attach. The budget itself:
 * test/unit/instruction-budget.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import { restoredInstructionNotice, skippedInstructionNote, skippedInstructionWarning } from "../../extensions/lib/context/instruction-budget.ts";
import { estimateTextTokens } from "../../extensions/lib/models/pi-ai-estimate.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import { createFakeCtx, createFakePi, type FakePi } from "../../test/unit/helpers/fake-pi.ts";
import { stubHome } from "../../test/unit/helpers/home.ts";

/** A file body of 24,000 characters, and pi-ai's token estimate for it (its chars-per-token depends on pi's version). */
const BIG = "x".repeat(24_000);
const T = estimateTextTokens(BIG);

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
		// Room for HALF-A and the note in HALF-BIGGER's slot, not for both files.
		const window = 2 * tokens("HALF-A") + 400;
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

	it("gives a nested file only what the loaded top-level files leave of the half", async () => {
		// Root: about 0.4 of the window; the nested file alone about 0.35, so together they pass the half.
		writeFileSync(join(dir, "CLAUDE.md"), body("ROOT-RULES"));
		writeFileSync(join(dir, "CLAUDE.local.md"), "Small.\n");
		mkdirSync(join(dir, "src"));
		const nestedBody = `NESTED ${"y".repeat(20_000)}\n`;
		writeFileSync(join(dir, "src", "CLAUDE.md"), nestedBody);
		const window = Math.ceil(tokens("ROOT-RULES") / 0.4);
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, model: model(window) });
		await fake.fireOne("session_start", {}, ctx);
		expect(block()).toContain("ROOT-RULES");
		await fake.fire("tool_result", { toolName: "read", toolCallId: "r2", input: { path: "src/a.ts" }, isError: false, content: [] }, ctx);
		const attached = reminders.filter((r) => r.toolCallId === "r2").map((r) => r.text ?? "");
		expect(attached).toHaveLength(1);
		expect(attached[0]).not.toContain("NESTED");
		expect(attached[0]).toContain("This file is not loaded");
	});

	it("gives a nested file only what the nested files still in context leave of the half", async () => {
		writeFileSync(join(dir, "CLAUDE.md"), "Root rules.\n");
		mkdirSync(join(dir, "a"));
		mkdirSync(join(dir, "b"));
		writeFileSync(join(dir, "a", "CLAUDE.md"), body("NESTED-A"));
		writeFileSync(join(dir, "b", "CLAUDE.md"), body("NESTED-B"));
		// Each fits the half alone (about 0.4 of the window); together they do not.
		const window = Math.ceil(tokens("NESTED-A") / 0.4);
		let branch: unknown[] = [];
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, model: model(window), sessionManager: { getBranch: () => branch } });
		await fake.fireOne("session_start", {}, ctx);
		const read = (path: string, toolCallId: string) => fake.fire("tool_result", { toolName: "read", toolCallId, input: { path }, isError: false, content: [] }, ctx);
		const attached = (toolCallId: string) => reminders.filter((r) => r.toolCallId === toolCallId).map((r) => r.text ?? "");
		const result = (toolCallId: string) => ({ type: "message", message: { role: "toolResult", toolCallId, toolName: "read", content: [], isError: false, timestamp: 1 } });

		await read("a/x.ts", "r1");
		expect(attached("r1")[0]).toContain("NESTED-A");
		// A resumed branch that still holds r1 counts it from the recorded entry.
		branch = [result("r1"), ...fake.branch];
		await fake.fire("session_tree", {}, ctx);
		await read("b/x.ts", "r2");
		expect(attached("r2")[0]).not.toContain("NESTED-B");
		expect(attached("r2")[0]).toContain("This file is not loaded");

		// A branch without r1 frees its share.
		branch = [];
		await fake.fire("session_tree", {}, ctx);
		await read("b/y.ts", "r3");
		expect(attached("r3")[0]).toContain("NESTED-B");
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
