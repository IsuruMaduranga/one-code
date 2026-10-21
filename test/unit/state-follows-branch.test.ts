/**
 * Durable session state follows the branch (design.md section 4.3, decided
 * with the user in section 13): the latest `one-code:state` entry on the
 * branch wins at a resume, /reload, a fork and a /tree switch. Regression
 * cases for round-1 H4 (the permission mode came back as the settings default)
 * and H3 (a resume revived ultracode's standing block while the mode was off).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import effortExtension from "../../extensions/effort/index.ts";
import { makeRecord, RECORD } from "../../extensions/lib/ledger/records.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../../extensions/permissions/modes.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const stateEntry = (key: string, value: unknown) => ({ type: "custom", id: `s-${key}`, parentId: null, customType: RECORD.state, data: makeRecord("state", "0.6.0", { key, value }) });

describe("the permission mode follows the branch (H4)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mode-follows-"));
		vi.stubEnv("ONECODE_STATE_DIR", join(dir, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function start(branch: unknown[], flags: Record<string, string | boolean> = {}) {
		const fake = createFakePi();
		for (const [name, value] of Object.entries(flags)) fake.flags.set(name, value);
		const modes: string[] = [];
		fake.events.on(PERMISSION_STATUS_CHANNEL, (data) => modes.push((data as PermissionStatus).mode));
		permissionsExtension(fake.pi as never);
		const ctx = createFakeCtx({
			cwd: dir,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			sessionManager: { getSessionId: () => "s", getSessionDir: () => join(dir, "session"), getBranch: () => [...branch, ...fake.branch] },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		return { fake, ctx, modes, mode: () => modes.at(-1) };
	}

	it("resumes in the mode the branch last recorded, and records every switch", async () => {
		const first = await start([]);
		first.fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
		const resumed = await start(first.fake.branch);
		expect(resumed.mode()).toBe("acceptEdits");
	});

	it("never restores a stored bypassPermissions: it needs its flag again", async () => {
		const resumed = await start([stateEntry("permission-mode", "bypassPermissions")]);
		expect(resumed.mode()).not.toBe("bypassPermissions");
	});

	it("lets a flag win over the branch", async () => {
		const resumed = await start([stateEntry("permission-mode", "plan")], { "permission-mode": "default" });
		expect(resumed.mode()).toBe("default");
	});

	it("takes the selected branch's mode on /tree", async () => {
		const run = await start([]);
		run.fake.events.emit(MODE_CHANNEL, { mode: "plan" });
		const other = [stateEntry("permission-mode", "acceptEdits")];
		await run.fake.fire("session_tree", {}, { ...run.ctx, sessionManager: { ...(run.ctx.sessionManager as object), getBranch: () => other } });
		expect(run.mode()).toBe("acceptEdits");
	});
});

describe("ultracode follows the branch (H3)", () => {
	async function start(branch: unknown[], level = "xhigh") {
		const fake = createFakePi();
		(fake.pi.getThinkingLevel as ReturnType<typeof vi.fn>).mockReturnValue(level);
		const reminders: ReminderPayload[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as ReminderPayload));
		effortExtension(fake.pi as never);
		await fake.fire("session_start", {}, createFakeCtx({ sessionManager: { getBranch: () => branch } }));
		const standing = () => reminders.filter((r) => r.key === "ultracode-mode").at(-1);
		return { standing };
	}

	it("comes back on with its standing block when the branch recorded it on at pi's restored level", async () => {
		const resumed = await start([stateEntry("ultracode", { on: true, level: "xhigh" })]);
		expect(resumed.standing()).toMatchObject({ placement: "sticky-append" });
	});

	it("stays off, with no standing block, when the branch recorded it off or pi's level moved", async () => {
		expect((await start([stateEntry("ultracode", { on: false })])).standing()).toMatchObject({ remove: true });
		expect((await start([stateEntry("ultracode", { on: true, level: "xhigh" })], "high")).standing()).toMatchObject({ remove: true });
		expect((await start([])).standing()).toMatchObject({ remove: true });
	});
});

describe("hook context waiting for a prompt follows the branch (R2-M8)", () => {
	it("survives a /reload and rides the next prompt", async () => {
		const { default: hooksExtension } = await import("../../extensions/hooks/index.ts");
		const fake = createFakePi();
		hooksExtension(fake.pi as never);
		const branch = [stateEntry("hooks:pending-context", [{ event: "SessionStart", text: "the build is red" }])];
		const ctx = createFakeCtx({ cwd: process.cwd(), sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined, getSessionDir: () => undefined, getBranch: () => branch } });
		await fake.fire("session_start", { reason: "reload" }, ctx);
		const delivered = await fake.fireOne<{ message?: { content: string } }>("before_agent_start", { prompt: "next" }, ctx);
		expect(delivered?.message?.content).toContain("the build is red");
		// Delivered: the queue the branch records is empty now.
		expect(fake.branch.at(-1)?.data).toMatchObject({ key: "hooks:pending-context", value: [] });
	});
});
