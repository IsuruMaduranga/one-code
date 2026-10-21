/**
 * permissions + plan-mode on one bus: cycling ctrl+q through every mode must
 * leave exactly the right reminders — the mode-change one-shot for the mode
 * where the cycle settled (the latest pending entry per key), the auto block
 * only while in auto, and the plan block (naming the plan file) the moment
 * plan mode is entered, without waiting for the next prompt
 * (STEERING-REVIEW-2026-09-05 M3).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { LiveReminders, REMINDER_CHANNEL, type ReminderPayload } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { CYCLE_KEY } from "../../extensions/permissions/modes.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

describe("permission mode cycle with plan-mode mounted", () => {
	let fake: FakePi;
	let stateDir: string;
	let live: LiveReminders;
	/** One-shots in emission order, as system-reminder persists them. */
	let pending: ReminderPayload[];
	const traffic: Array<Record<string, unknown>> = [];
	/** The one-shots bound to `toolCallId`'s result. */
	const boundTo = (toolCallId: string) => pending.filter((payload) => payload.toolCallId === toolCallId);
	/** What the next request carries: the latest pending one-shot per key (the ledger's outbox). */
	const outbox = () => pending.filter((payload, i) => payload.key === undefined || !pending.slice(i + 1).some((later) => later.key === payload.key));

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "mode-cycle-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		fake = createFakePi();
		fake.flags.set("dangerously-skip-permissions", true);
		traffic.length = 0;
		live = new LiveReminders();
		pending = [];
		// Mirror what the system-reminder extension does with the traffic.
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const payload = data as ReminderPayload;
			traffic.push(payload as Record<string, unknown>);
			if (live.apply(payload) === "one-shot") pending.push(payload);
		});
		permissionsExtension(fake.pi as never);
		planModeExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("binds entering plan mode and its switch announcement to the entering tool result", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => fake.branch },
		});
		await fake.fire("session_start", {}, ctx);
		await fake.tools.get("enter_plan_mode")!.execute("enter-plan", {}, undefined, undefined, ctx);
		expect(traffic.find((entry) => entry.key === "permission-mode" && entry.text)).toMatchObject({ toolCallId: "enter-plan" });
		expect(traffic.find((entry) => entry.key === "permission-mode-change")).toMatchObject({ toolCallId: "enter-plan" });
		expect(boundTo("read-before")).toEqual([]);
		expect(boundTo("enter-plan")).toHaveLength(1);
	});

	it("binds auto activation and both exit-plan announcements to the approving tool result", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			hasUI: true,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => fake.branch },
			ui: { custom: async () => 1 }, // auto follows the pre-plan bypass mode
		});
		await fake.fire("session_start", {}, ctx);
		const entered = await fake.tools.get("enter_plan_mode")!.execute("enter-plan", {}, undefined, undefined, ctx) as { details: { planFilePath: string } };
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(entered.details.planFilePath, "# Plan\n1. Done.\n");
		traffic.length = 0;
		await fake.tools.get("exit_plan_mode")!.execute("approve-plan", {}, undefined, undefined, ctx);
		expect(traffic.find((entry) => entry.key === "permission-mode" && entry.text)).toMatchObject({ toolCallId: "approve-plan" });
		expect(traffic.find((entry) => entry.key === "permission-mode-change")).toMatchObject({ toolCallId: "approve-plan" });
		expect(traffic.find((entry) => typeof entry.text === "string" && entry.text.includes("You have exited plan mode."))).toMatchObject({ toolCallId: "approve-plan" });
		expect(boundTo("read-before")).toEqual([]);
		expect(boundTo("approve-plan")).toHaveLength(2);
	});

	it.each([["plan", "bypassPermissions"], ["auto", "default"]])("cycling out of %s announces %s as a one-shot", async (from, to) => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => fake.branch },
		});
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: from });
		pending.length = 0;
		const shortcut = vi.mocked(fake.pi.registerShortcut as (key: string, options: { handler: (ctx: unknown) => void }) => void)
			.mock.calls.find(([key]) => key === CYCLE_KEY)!;
		shortcut[1].handler(ctx);
		expect(pending.map((entry) => entry.text)).toEqual([`The user's permission mode is now "${to}".`]);
	});

	it("a redundant enter_plan_mode call preserves the standing plan block and its anchor", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => fake.branch },
		});
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "plan" });
		const standing = structuredClone(live.stickyEntries());
		expect(standing).toHaveLength(1);
		await fake.tools.get("enter_plan_mode")!.execute("repeat", {}, undefined, undefined, ctx);
		expect(live.stickyEntries()).toEqual(standing);
	});

	it("bypass → auto → default → acceptEdits → plan leaves the plan block and a plan announcement naming the file", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku", cost: { input: 1, output: 1 } }] },
			model: { provider: "anthropic", id: "claude-sonnet", cost: { input: 3, output: 15 } },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => fake.branch },
			hasUI: true,
		});
		await fake.fire("session_start", {}, ctx);
		await fake.fire("agent_start", {}, ctx);
		traffic.length = 0;

		for (const mode of ["auto", "default", "acceptEdits", "plan"]) fake.events.emit(MODE_CHANNEL, { mode });

		const announce = traffic.filter((t) => t.key === "permission-mode-change").map((t) => t.text as string);
		expect(announce).toHaveLength(4);
		expect(announce[3]).toContain('now "plan"');
		expect(announce[3]).toContain(join(stateDir, "plans"));

		// What the next request would carry: the plan block (sticky) and the last announce only.
		const sticky = live.stickyEntries();
		expect(sticky).toHaveLength(1);
		expect(sticky[0].text).toContain(join(stateDir, "plans"));
		expect(sticky[0].text).not.toContain("Auto mode is active");
		const oneShots = outbox().filter((entry) => entry.key === "permission-mode-change");
		expect(oneShots).toHaveLength(1);
		expect(oneShots[0].text).toContain('now "plan"');
	});
});

describe("plan mode follows the branch across /tree (permissions' session_tree runs first)", () => {
	type Entry = { type: string; id: string; parentId: string | null; customType?: string; data?: unknown };
	let fake: FakePi;
	let stateDir: string;
	let branch: Entry[];
	const reminders: ReminderPayload[] = [];
	const modeRequests: Array<{ mode?: string }> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "plan-tree-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		fake = createFakePi();
		branch = [];
		reminders.length = 0;
		// A session tree: appends extend the current branch, a /tree swaps it.
		let next = 0;
		fake.pi.appendEntry = (customType: string, data?: unknown) => {
			branch = [...branch, { type: "custom", id: `e${++next}`, parentId: branch.at(-1)?.id ?? null, customType, data }];
		};
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as ReminderPayload));
		permissionsExtension(fake.pi as never);
		planModeExtension(fake.pi as never);
		fake.events.on(MODE_CHANNEL, (data) => modeRequests.push(data as { mode?: string }));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("keeps the selected branch's plan file, its entry-time wording and the mode it entered plan mode from", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			hasUI: true,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => branch },
			ui: { custom: async () => 0 }, // the first choice
		});
		const tree = async (to: Entry[]) => {
			branch = to;
			await fake.fire("session_tree", {}, ctx);
		};
		const standing = () => reminders.filter((r) => r.key === "permission-mode" && !r.remove && r.placement === "sticky-append").at(-1)?.text ?? "";
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
		const root = branch;

		// Branch B: plan mode entered from acceptEdits, the plan not written yet.
		fake.events.emit(MODE_CHANNEL, { mode: "plan" });
		const planB = /at (\S+\.md)/.exec(standing())![1];
		expect(standing()).toContain("No plan file exists yet");
		const leafB = branch;

		// Branch A: back before B, plan mode from default (a plan file of its own), then out to default.
		await tree(root);
		fake.events.emit(MODE_CHANNEL, { mode: "default" });
		fake.events.emit(MODE_CHANNEL, { mode: "plan" });
		const planA = /at (\S+\.md)/.exec(standing())![1];
		expect(planA).not.toBe(planB);
		fake.events.emit(MODE_CHANNEL, { mode: "default" });

		// The model writes B's plan on disk since; then /tree back to B's leaf.
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(planB, "# Plan B\n1. Do it.\n");
		await tree(leafB);

		expect(standing()).toContain(planB);
		// The run on B began with no plan file: its block keeps that wording.
		expect(standing()).toContain("No plan file exists yet");
		const entryStates = branch.filter((e) => e.customType === "one-code:state" && (e.data as { key?: string }).key === "plan-mode:entry");
		expect(JSON.stringify(entryStates)).not.toContain(planA);

		// The approval offers B's mode before planning, acceptEdits, first.
		modeRequests.length = 0;
		await fake.tools.get("exit_plan_mode")!.execute("approve", {}, undefined, undefined, ctx);
		expect(modeRequests).toEqual([{ mode: "acceptEdits", toolCallId: "approve" }]);
	});

	it("restores the mode before planning after a /reload inside the run", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			hasUI: true,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => branch },
			ui: { custom: async () => 0 },
		});
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
		fake.events.emit(MODE_CHANNEL, { mode: "plan" });
		const plan = /at (\S+\.md)/.exec(reminders.filter((r) => r.key === "permission-mode" && r.text).at(-1)!.text!)![1];
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(plan, "# Plan\n1. Do it.\n");

		// /reload: fresh instances on the same branch, which says plan mode.
		const reloaded = createFakePi();
		reloaded.pi.appendEntry = fake.pi.appendEntry;
		const requests: Array<{ mode?: string }> = [];
		permissionsExtension(reloaded.pi as never);
		planModeExtension(reloaded.pi as never);
		reloaded.events.on(MODE_CHANNEL, (data) => requests.push(data as { mode?: string }));
		await reloaded.fire("session_start", { reason: "reload" }, ctx);
		await reloaded.tools.get("exit_plan_mode")!.execute("approve", {}, undefined, undefined, ctx);
		expect(requests).toEqual([{ mode: "acceptEdits", toolCallId: "approve" }]);
	});
});
