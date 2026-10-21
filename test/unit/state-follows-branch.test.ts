/**
 * Durable session state follows the branch (design.md section 4.3, decided
 * with the user in section 13): the latest `one-code:state` entry on the
 * branch wins at a resume, /reload, a fork and a /tree switch. Regression
 * cases for round-1 H4 (the permission mode came back as the settings default)
 * and H3 (a resume revived ultracode's standing block while the mode was off).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import effortExtension from "../../extensions/effort/index.ts";
import { makeRecord, RECORD } from "../../extensions/lib/ledger/records.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../../extensions/permissions/modes.ts";
import { MODE_ENV } from "../../extensions/lib/permission-gate.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stateEntry } from "./helpers/state-entry.ts";

/** A request recorded on the branch: its model was told the mode in force. */
const requestEntry = {
	type: "custom",
	id: "r1",
	parentId: null,
	customType: RECORD.request,
	data: makeRecord("request", "0.6.0", { identity: { api: "anthropic-messages", provider: "anthropic", model: "claude-haiku", auth: "key" }, keep: 0, append: [], head: "h", blobs: {}, consumed: [] }),
};

describe("the permission mode follows the branch (H4)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mode-follows-"));
		vi.stubEnv("ONECODE_STATE_DIR", join(dir, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
		vi.stubEnv(MODE_ENV, "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function start(branch: unknown[], flags: Record<string, string | boolean> = {}, reason = "startup", reminders?: ReminderPayload[]) {
		const fake = createFakePi();
		if (reminders) fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as ReminderPayload));
		for (const [name, value] of Object.entries(flags)) fake.flags.set(name, value);
		const modes: string[] = [];
		fake.events.on(PERMISSION_STATUS_CHANNEL, (data) => modes.push((data as PermissionStatus).mode));
		permissionsExtension(fake.pi as never);
		const ctx = createFakeCtx({
			cwd: dir,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku" }] },
			sessionManager: { getSessionId: () => "s", getSessionDir: () => join(dir, "session"), getBranch: () => [...branch, ...fake.branch] },
		});
		await fake.fire("session_start", { reason }, ctx);
		return { fake, ctx, modes, mode: () => modes.at(-1) };
	}

	it("resumes in the mode the branch last recorded, and records every switch", async () => {
		const first = await start([]);
		first.fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
		const resumed = await start(first.fake.branch);
		expect(resumed.mode()).toBe("acceptEdits");
	});

	it("keeps the mode across /clear, recorded on the new branch, but never a bypass", async () => {
		const first = await start([]);
		first.fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
		const cleared = await start([], {}, "new");
		expect(cleared.mode()).toBe("acceptEdits");
		expect(cleared.fake.branch.at(-1)?.data).toMatchObject({ key: "permission-mode", value: "acceptEdits" });
		// A fresh process does not inherit it: only /clear and /new in the same process carry it.
		expect((await start([])).mode()).not.toBe("acceptEdits");
		process.env[MODE_ENV] = "bypassPermissions";
		expect((await start([], {}, "new")).mode()).not.toBe("bypassPermissions");
	});

	it("never restores a stored bypassPermissions: it needs its flag again", async () => {
		const resumed = await start([stateEntry("permission-mode", "bypassPermissions")]);
		expect(resumed.mode()).not.toBe("bypassPermissions");
	});

	it("lets a launch flag win over the branch, and tells the model, which a request told the branch's mode", async () => {
		const reminders: ReminderPayload[] = [];
		// `pi --continue --permission-mode default`: the process's first runtime starts with reason "startup".
		const resumed = await start([stateEntry("permission-mode", "plan"), requestEntry], { "permission-mode": "default" }, "startup", reminders);
		expect(resumed.mode()).toBe("default");
		expect(reminders.find((r) => r.key === "permission-mode-change")?.text).toBe('The user\'s permission mode is now "default".');
	});

	it("says nothing to a branch whose model was never told a mode, or that keeps it", async () => {
		const reminders: ReminderPayload[] = [];
		await start([stateEntry("permission-mode", "plan")], { "permission-mode": "default" }, "startup", reminders);
		await start([stateEntry("permission-mode", "acceptEdits"), requestEntry], {}, "startup", reminders);
		expect(reminders.find((r) => r.key === "permission-mode-change")).toBeUndefined();
	});

	it("keeps the branch's mode over the launch flags after the launch (/reload, /resume, /fork)", async () => {
		for (const reason of ["reload", "resume", "fork"]) {
			const run = await start([stateEntry("permission-mode", "acceptEdits"), requestEntry], { "permission-mode": "plan" }, reason);
			expect(run.mode()).toBe("acceptEdits");
		}
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
		const ctx = createFakeCtx({ sessionManager: { getBranch: () => branch } });
		await fake.fire("session_start", {}, ctx);
		const standing = () => reminders.filter((r) => r.key === "ultracode-mode").at(-1);
		const offNotices = () => reminders.filter((r) => r.key === "ultracode-mode-change");
		return { fake, ctx, standing, offNotices };
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

	it("tells the model ultracode ended when the branch's model saw it on and a resume's level moved (R3-M21)", async () => {
		expect((await start([stateEntry("ultracode", { on: true, level: "xhigh" })], "high")).offNotices()).toHaveLength(1);
		expect((await start([stateEntry("ultracode", { on: false })])).offNotices()).toEqual([]);
		expect((await start([])).offNotices()).toEqual([]);
	});

	it("leaves the standing block out while workflows are turned off (R3-M21)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultracode-workflows-"));
		vi.stubEnv("ONECODE_STATE_DIR", dir);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ disableWorkflows: true }));
		try {
			expect((await start([stateEntry("ultracode", { on: true, level: "xhigh" })])).standing()).toMatchObject({ remove: true });
		} finally {
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("puts the branch's level back at a /tree switch, where pi restores none, and keeps ultracode on (R3-M21)", async () => {
		const { fake, ctx, standing, offNotices } = await start([], "medium");
		const branch = [stateEntry("ultracode", { on: true, level: "xhigh" })];
		await fake.fire("session_tree", {}, createFakeCtx({ ...ctx, sessionManager: { getBranch: () => branch } }));
		expect(standing()).toMatchObject({ placement: "sticky-append" });
		expect(fake.pi.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(offNotices()).toEqual([]);
	});
});

