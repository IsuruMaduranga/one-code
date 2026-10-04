/**
 * permissions + plan-mode on one bus: cycling ctrl+q through every mode must
 * leave exactly the right reminders queued — the mode-change one-shot for the
 * mode where the cycle settled, the auto block only while in auto, and the
 * plan block (naming the plan file) the moment plan mode is entered, without
 * waiting for the next prompt (STEERING-REVIEW-2026-09-05 M3).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL, ReminderQueue } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { CYCLE_KEY } from "../../extensions/permissions/modes.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

describe("permission mode cycle with plan-mode mounted", () => {
	let fake: FakePi;
	let stateDir: string;
	let queue: ReminderQueue;
	const traffic: Array<Record<string, unknown>> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "mode-cycle-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		fake = createFakePi();
		fake.flags.set("dangerously-skip-permissions", true);
		traffic.length = 0;
		queue = new ReminderQueue();
		// Mirror what the system-reminder extension does with the traffic.
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const p = data as { text?: string; remove?: boolean; key?: string; scope?: "next-turn" | "every-turn"; placement?: never; toolCallId?: string };
			traffic.push(p as Record<string, unknown>);
			if (p.remove && p.key) queue.remove(p.key);
			else if (typeof p.text === "string") queue.enqueue(p.text, { scope: p.scope, key: p.key, placement: p.placement, toolCallId: p.toolCallId });
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
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => [] },
		});
		await fake.fire("session_start", {}, ctx);
		await fake.tools.get("enter_plan_mode")!.execute("enter-plan", {}, undefined, undefined, ctx);
		expect(traffic.find((entry) => entry.key === "permission-mode" && entry.text)).toMatchObject({ toolCallId: "enter-plan" });
		expect(traffic.find((entry) => entry.key === "permission-mode-change")).toMatchObject({ toolCallId: "enter-plan" });
		expect(queue.takeOneShots("read-before")).toEqual([]);
		expect(queue.takeOneShots("enter-plan")).toHaveLength(1);
	});

	it("binds auto activation and both exit-plan announcements to the approving tool result", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			hasUI: true,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => [] },
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
		expect(queue.takeOneShots("read-before")).toEqual([]);
		expect(queue.takeOneShots("approve-plan")).toHaveLength(2);
	});

	it.each([["plan", "bypassPermissions"], ["auto", "default"]])("cycling out of %s announces %s as a one-shot", async (from, to) => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => [] },
		});
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: from });
		queue.takeOneShots();
		const shortcut = vi.mocked(fake.pi.registerShortcut as (key: string, options: { handler: (ctx: unknown) => void }) => void)
			.mock.calls.find(([key]) => key === CYCLE_KEY)!;
		shortcut[1].handler(ctx);
		expect(queue.takeOneShots().map((entry) => entry.text)).toEqual([`The user's permission mode is now "${to}".`]);
	});

	it("a redundant enter_plan_mode call preserves the standing plan block and its anchor", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => [] },
		});
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "plan" });
		queue.drain([{ role: "user", content: "x", timestamp: Date.now() + 1 } as never]);
		const standing = queue.persistentEntries("sticky-append");
		expect(standing).toHaveLength(1);
		await fake.tools.get("enter_plan_mode")!.execute("repeat", {}, undefined, undefined, ctx);
		expect(queue.persistentEntries("sticky-append")).toEqual(standing);
	});

	it("bypass → auto → default → acceptEdits → plan leaves the plan block and a plan announcement naming the file", async () => {
		const ctx = createFakeCtx({
			cwd: stateDir,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku", cost: { input: 1, output: 1 } }] },
			model: { provider: "anthropic", id: "claude-sonnet", cost: { input: 3, output: 15 } },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => stateDir, getBranch: () => [] },
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
		const drained = queue.drain([{ role: "user", content: "x", timestamp: Date.now() + 1 } as never]);
		const sticky = drained.filter((e) => e.placement === "sticky-append");
		expect(sticky).toHaveLength(1);
		expect(sticky[0].text).toContain(join(stateDir, "plans"));
		expect(sticky[0].text).not.toContain("Auto mode is active");
		const oneShots = drained.filter((e) => e.placement === "last-append");
		expect(oneShots).toHaveLength(1);
		expect(oneShots[0].text).toContain('now "plan"');
	});
});
