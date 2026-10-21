/**
 * plan-mode/index.ts wiring: the standing plan block must be back on the
 * reminder queue the moment the mode becomes plan — a ctrl+q during a long turn
 * used to leave every remaining request of that turn without it while edits
 * were denied "see the plan-mode reminder" (STEERING-REVIEW-2026-09-05 M3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODE_CHANNEL, PLAN_FILE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/permissions/modes.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import { buildPlanModeReminder } from "../../extensions/plan-mode/reminder.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

describe("plan-mode wiring", () => {
	let fake: FakePi;
	let stateDir: string;
	const reminders: Array<{ key?: string; text?: string; placement?: string; scope?: string; remove?: boolean }> = [];
	const planFiles: Array<{ path: string }> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "plan-mode-wiring-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		fake = createFakePi();
		reminders.length = 0;
		planFiles.length = 0;
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		fake.events.on(PLAN_FILE_CHANNEL, (data) => planFiles.push(data as never));
		planModeExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("keeps the run's plan-file entry state across a /reload, though the model created the file since", async () => {
		const branch = () => fake.branch;
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: branch } }));
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const before = reminders.filter((r) => r.key === "permission-mode" && !r.remove).at(-1)?.text;
		mkdirSync(join(planFiles[0].path, ".."), { recursive: true });
		writeFileSync(planFiles[0].path, "# the plan\n");
		// /reload: a new instance on the same branch, still in plan mode.
		const reloaded = createFakePi();
		const after: Array<{ key?: string; text?: string; remove?: boolean }> = [];
		reloaded.events.on(REMINDER_CHANNEL, (data) => after.push(data as never));
		planModeExtension(reloaded.pi as never);
		const entries = [...fake.branch];
		await reloaded.fireOne("session_start", { reason: "reload" }, createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => [...entries, ...reloaded.branch] } }));
		reloaded.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		expect(after.filter((r) => r.key === "permission-mode" && !r.remove).at(-1)?.text).toBe(before);
	});

	describe("a fork gets its own copy of the plan (R3-M19, Claude Code's copyPlanForFork)", () => {
		const standing = (list: Array<{ key?: string; text?: string; remove?: boolean }>) => list.filter((r) => r.key === "permission-mode" && !r.remove).at(-1)?.text;
		/** The parent session: in plan mode, its plan written. */
		const planInParent = async () => {
			await fake.fireOne("session_start", {}, createFakeCtx({ cwd: stateDir, sessionManager: { getSessionId: () => "parent", getBranch: () => fake.branch } }));
			fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
			const path = planFiles[0].path;
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, "# the plan\n");
			return path;
		};
		/** A new instance in session `fork` on `entries` (a fork copies the parent's), still in plan mode. */
		const openFork = async (entries: FakePi["branch"], event: string, all: FakePi["branch"] = entries) => {
			const forked = createFakePi();
			const seen: Array<{ key?: string; text?: string; remove?: boolean }> = [];
			const paths: string[] = [];
			forked.events.on(REMINDER_CHANNEL, (data) => seen.push(data as never));
			forked.events.on(PLAN_FILE_CHANNEL, (data) => paths.push((data as { path: string }).path));
			planModeExtension(forked.pi as never);
			const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getSessionId: () => "fork", getBranch: () => [...entries, ...forked.branch], getEntries: () => [...all, ...forked.branch] } });
			await forked.fireOne(event, { reason: "fork" }, ctx);
			forked.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
			return { forked, seen, path: paths.at(-1)! };
		};

		it("copies the plan to a new file, and the fork's block says the copy exists", async () => {
			const parentPath = await planInParent();
			// The parent's run began before its plan was written.
			expect(standing(reminders)).toBe(buildPlanModeReminder(parentPath, false));
			const fork = await openFork([...fake.branch], "session_start");
			expect(fork.path).not.toBe(parentPath);
			expect(readFileSync(fork.path, "utf8")).toBe("# the plan\n");
			expect(standing(fork.seen)).toBe(buildPlanModeReminder(fork.path, true));
			writeFileSync(fork.path, "# the fork's plan\n");
			expect(readFileSync(parentPath, "utf8")).toBe("# the plan\n");
		});

		it("a /tree in the fork to a node before the copy takes the same copy, not another", async () => {
			const parentPath = await planInParent();
			const parentEntries = [...fake.branch];
			const fork = await openFork(parentEntries, "session_start");
			writeFileSync(fork.path, "# the fork's plan\n");
			const tree = await openFork(parentEntries, "session_tree", [...parentEntries, ...fork.forked.branch]);
			expect(tree.path).toBe(fork.path);
			expect(readFileSync(fork.path, "utf8")).toBe("# the fork's plan\n");
			expect(tree.path).not.toBe(parentPath);
		});

		it("a resume of the parent keeps its own file; a record with no session id is the session's own", async () => {
			const parentPath = await planInParent();
			const resumed = createFakePi();
			const paths: string[] = [];
			resumed.events.on(PLAN_FILE_CHANNEL, (data) => paths.push((data as { path: string }).path));
			planModeExtension(resumed.pi as never);
			const legacy = fake.branch.map((entry) => (entry.customType === "one-code:plan-mode-file" ? { ...entry, data: { path: parentPath } } : entry));
			await resumed.fireOne("session_start", { reason: "startup" }, createFakeCtx({ cwd: stateDir, sessionManager: { getSessionId: () => "other", getBranch: () => [...legacy, ...resumed.branch] } }));
			resumed.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
			expect(paths.at(-1)).toBe(parentPath);
		});
	});

	it("after a compaction, re-attaches the plan and says the file exists now (R3-M20)", async () => {
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch } });
		await fake.fireOne("session_start", {}, ctx);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const atEntry = reminders.filter((r) => r.key === "permission-mode" && !r.remove).at(-1)?.text;
		mkdirSync(join(planFiles[0].path, ".."), { recursive: true });
		writeFileSync(planFiles[0].path, "# the plan\n1. Step one.\n");
		await fake.fireOne("session_compact", {}, ctx);
		const standing = reminders.filter((r) => r.key === "permission-mode" && !r.remove).at(-1)?.text;
		expect(standing).not.toBe(atEntry);
		const restore = reminders.find((r) => r.text?.startsWith("A plan file exists from plan mode at:"));
		expect(restore?.text).toContain("1. Step one.");
		expect(restore?.placement).toBe("user-prepend");
	});

	it("after a compaction, an unreadable plan path (a directory) skips the re-attach instead of throwing", async () => {
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch } });
		await fake.fireOne("session_start", {}, ctx);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const atEntry = reminders.filter((r) => r.key === "permission-mode" && !r.remove).at(-1)?.text;
		mkdirSync(planFiles[0].path, { recursive: true });
		await expect(fake.fireOne("session_compact", {}, ctx)).resolves.toBeUndefined();
		// The mode block still follows the compaction; only the restore is skipped.
		expect(reminders.filter((r) => r.key === "permission-mode" && !r.remove).at(-1)?.text).not.toBe(atEntry);
		expect(reminders.find((r) => r.text?.startsWith("A plan file exists from plan mode at:"))).toBeUndefined();
	});

	it("re-installs the sticky plan block and announces the plan file synchronously when the mode becomes plan mid-turn", async () => {
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch } }));
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });

		expect(planFiles).toHaveLength(1);
		const standing = reminders.find((r) => r.key === "permission-mode" && !r.remove);
		expect(standing).toBeDefined();
		expect(standing?.placement).toBe("sticky-append");
		expect(standing?.text).toContain(planFiles[0].path);

		// Staying in plan mode (a repeated status broadcast) does not re-emit; leaving does nothing here.
		reminders.length = 0;
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "default", paused: false });
		expect(reminders).toHaveLength(0);
	});

	it("installs startup plan state before the first prompt can be stamped", async () => {
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch } }));
		expect(reminders.find((r) => r.key === "permission-mode")?.placement).toBe("sticky-append");
	});

	it("without a context yet (a session that starts in plan mode), before_agent_start installs the block", async () => {
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		expect(reminders).toHaveLength(0);
		await fake.fireOne("before_agent_start", {}, createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch } }));
		expect(reminders.find((r) => r.key === "permission-mode")?.placement).toBe("sticky-append");
	});
});

describe("exit_plan_mode and the mode before planning (PERMISSIONS-REVIEW-2026-09-05 M4)", () => {
	let fake: FakePi;
	let stateDir: string;
	const modeRequests: Array<{ mode?: string }> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "plan-mode-exit-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		fake = createFakePi();
		modeRequests.length = 0;
		fake.events.on(MODE_CHANNEL, (data) => modeRequests.push(data as never));
		planModeExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	/** Enter plan mode (status broadcast + tool) and write a plan into the allocated file. */
	const enterPlanWithPlanText = async (ctx: Record<string, unknown>) => {
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const entered = (await fake.tools.get("enter_plan_mode")!.execute("t1", {}, undefined, undefined, ctx)) as {
			details: { planFilePath: string };
		};
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(entered.details.planFilePath, "# The plan\n\n1. do it\n");
		return entered.details.planFilePath;
	};

	type ViewerComponent = { render: (width: number) => string[]; handleInput: (data: string) => void };
	type ViewerFactory = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => ViewerComponent;
	/** A `ctx.ui.custom` that renders the approval viewer once (capturing the choices) and confirms the pre-selected option. */
	const confirmPreselected = (offered: string[][]) =>
		vi.fn(async (factory: ViewerFactory) => {
			let picked: unknown;
			const component = factory({ requestRender: () => {} }, {}, {}, (v) => (picked = v));
			offered.push(component.render(120));
			component.handleInput("\r");
			return picked;
		});

	it("headless: refuses to leave plan mode and points at the plan file (the model used to exit by itself)", async () => {
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, hasUI: false });
		await fake.fireOne("session_start", {}, ctx);
		const planFile = await enterPlanWithPlanText(ctx);
		modeRequests.length = 0;
		const result = (await fake.tools.get("exit_plan_mode")!.execute("t2", {}, undefined, undefined, ctx)) as {
			isError?: boolean;
			content: Array<{ text: string }>;
			details: { approved?: boolean };
		};
		expect(result.isError).toBe(true);
		expect(result.details.approved).toBe(false);
		expect(result.content[0].text).toContain("interactive session");
		expect(result.content[0].text).toContain(planFile);
		// No mode change was requested: the session stays in plan mode.
		expect(modeRequests).toHaveLength(0);
	});

	it("interactive: the mode the session was in before planning is offered first and pre-selected", async () => {
		const offered: string[][] = [];
		const ctx = createFakeCtx({
			cwd: stateDir,
			sessionManager: { getBranch: () => fake.branch },
			hasUI: true,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			ui: { custom: confirmPreselected(offered) },
		});
		await fake.fireOne("session_start", {}, ctx);
		// The session was in acceptEdits, then entered plan mode.
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "acceptEdits", paused: false });
		await enterPlanWithPlanText(ctx);
		modeRequests.length = 0;

		const exitReminders: Array<{ text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => exitReminders.push(data as { text?: string }));
		const result = (await fake.tools.get("exit_plan_mode")!.execute("t3", {}, undefined, undefined, ctx)) as { details: { approved?: boolean } };
		expect(result.details.approved).toBe(true);
		expect(exitReminders.some((entry) => entry.text?.includes("You have exited plan mode."))).toBe(true);
		expect(modeRequests).toEqual([{ mode: "acceptEdits", toolCallId: "t3" }]);
		const text = offered[0].join("\n");
		expect(text).toContain("back to auto-accept edits (the mode before planning)");
		// The fixed choice for the same mode is not listed twice; auto is still offered.
		expect(text.match(/auto-accept edits/g)).toHaveLength(1);
		expect(text).toContain("Approve — auto mode");
	});

	it("a session that STARTED in plan mode has no pre-plan mode: the fixed list, manual approvals pre-selected", async () => {
		const offered: string[][] = [];
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom: confirmPreselected(offered) } });
		await fake.fireOne("session_start", {}, ctx);
		await enterPlanWithPlanText(ctx); // the first status seen is plan itself
		modeRequests.length = 0;
		await fake.tools.get("exit_plan_mode")!.execute("t4", {}, undefined, undefined, ctx);
		expect(modeRequests).toEqual([{ mode: "default", toolCallId: "t4" }]);
		expect(offered[0].join("\n")).not.toContain("the mode before planning");
	});

	/** A `ctx.ui.custom` that answers each showing of the approval viewer with the next key from `keys`. */
	const pressEach = (keys: string[]) =>
		vi.fn(async (factory: ViewerFactory) => {
			let picked: unknown;
			const component = factory({ requestRender: () => {} }, {}, {}, (v) => (picked = v));
			component.render(120);
			component.handleInput(keys.shift() ?? "\x1b");
			return picked;
		});

	type ExitResult = { isError?: boolean; terminate?: boolean; content: Array<{ text: string }>; details: { approved?: boolean; feedback?: string } };

	it("keep planning asks what to change and sends the words back; the turn goes on in plan mode", async () => {
		const input = vi.fn(async () => "name it greet.txt instead");
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom: pressEach(["3"]), input } });
		await fake.fireOne("session_start", {}, ctx);
		await enterPlanWithPlanText(ctx);
		modeRequests.length = 0;
		const result = (await fake.tools.get("exit_plan_mode")!.execute("t6", {}, undefined, undefined, ctx)) as ExitResult;
		await fake.fire("tool_execution_end", { toolCallId: "t6" }, ctx);
		expect(input).toHaveBeenCalledWith("Tell the agent what to change", undefined, expect.anything());
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ approved: false, feedback: "name it greet.txt instead" });
		expect(result.content[0].text).toContain("To tell you how to proceed, the user said:\nname it greet.txt instead");
		expect(result.terminate).toBeUndefined();
		expect(ctx.abort).not.toHaveBeenCalled();
		expect(modeRequests).toHaveLength(0);
	});

	it("Esc on the approval rejects without words and stops the turn once the result is recorded", async () => {
		const input = vi.fn(async () => "unused");
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom: pressEach(["\x1b"]), input } });
		await fake.fireOne("session_start", {}, ctx);
		await enterPlanWithPlanText(ctx);
		modeRequests.length = 0;
		const result = (await fake.tools.get("exit_plan_mode")!.execute("t7", {}, undefined, undefined, ctx)) as ExitResult;
		expect(input).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("STOP what you are doing");
		expect(result.terminate).toBe(true);
		expect(ctx.abort).not.toHaveBeenCalled(); // not before pi records the result
		await fake.fire("tool_execution_end", { toolCallId: "t7" }, ctx);
		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(modeRequests).toHaveLength(0);
	});

	it("an aborted turn closes the approval as a cancel instead of leaving it open", async () => {
		const closedWith: unknown[] = [];
		const controller = new AbortController();
		const custom = vi.fn(
			(factory: ViewerFactory) =>
				new Promise((resolve) => {
					const component = factory({ requestRender: () => {} }, {}, {}, (v) => {
						closedWith.push(v);
						resolve(v);
					});
					component.render(120);
					controller.abort();
				}),
		);
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom } });
		await fake.fireOne("session_start", {}, ctx);
		await enterPlanWithPlanText(ctx);
		modeRequests.length = 0;
		await fake.tools.get("exit_plan_mode")!.execute("t9", {}, controller.signal, undefined, ctx);
		expect(closedWith).toEqual([null]);
		expect(modeRequests).toHaveLength(0);
	});

	it("a blank keep-planning answer reopens the approval", async () => {
		const custom = pressEach(["3", "2"]);
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom, input: vi.fn(async () => "") } });
		await fake.fireOne("session_start", {}, ctx);
		await enterPlanWithPlanText(ctx);
		modeRequests.length = 0;
		const result = (await fake.tools.get("exit_plan_mode")!.execute("t8", {}, undefined, undefined, ctx)) as ExitResult;
		expect(custom).toHaveBeenCalledTimes(2);
		expect(result.details.approved).toBe(true);
		expect(modeRequests).toEqual([{ mode: "default", toolCallId: "t8" }]);
	});

	it("interactive: a steady frame is served from cache, not re-wrapped (TUI-REVIEW M1)", async () => {
		// render() twice at the same width with no input between → the exact same
		// array is returned, proving the plan was not re-wrapped and the frame not
		// rebuilt while the spinner drives repaints.
		let firstRender: string[] | undefined;
		let secondRender: string[] | undefined;
		const custom = vi.fn(async (factory: ViewerFactory) => {
			let picked: unknown;
			const component = factory({ requestRender: () => {} }, {}, {}, (v) => (picked = v));
			firstRender = component.render(120);
			secondRender = component.render(120);
			component.handleInput("\r");
			return picked;
		});
		const ctx = createFakeCtx({ cwd: stateDir, sessionManager: { getBranch: () => fake.branch }, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom } });
		await fake.fireOne("session_start", {}, ctx);
		await enterPlanWithPlanText(ctx);
		await fake.tools.get("exit_plan_mode")!.execute("t5", {}, undefined, undefined, ctx);
		expect(firstRender).toBeDefined();
		expect(secondRender).toBe(firstRender); // same reference: cache hit, no rework
	});
});
