/**
 * permissions + plan-mode on one bus: cycling ctrl+q through every mode must
 * leave exactly the right reminders queued — the mode-change one-shot for the
 * mode where the cycle settled, the auto block only while in auto, and the
 * plan block (naming the plan file) the moment plan mode is entered, without
 * waiting for the next prompt (STEERING-REVIEW-2026-09-05 M3).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL, ReminderQueue } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

describe("permission mode cycle with plan-mode mounted", () => {
	let fake: FakePi;
	let stateDir: string;
	const queue = new ReminderQueue();
	const traffic: Array<Record<string, unknown>> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "mode-cycle-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		fake = createFakePi();
		fake.flags.set("dangerously-skip-permissions", true);
		traffic.length = 0;
		// Mirror what the system-reminder extension does with the traffic.
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const p = data as { text?: string; remove?: boolean; key?: string; scope?: "next-turn" | "every-turn"; placement?: never };
			traffic.push(p as Record<string, unknown>);
			if (p.remove && p.key) queue.remove(p.key);
			else if (typeof p.text === "string") queue.enqueue(p.text, { scope: p.scope, key: p.key, placement: p.placement });
		});
		permissionsExtension(fake.pi as never);
		planModeExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
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
