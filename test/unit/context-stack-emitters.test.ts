import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import { dateChangeReminder } from "../../extensions/lib/claude-context.ts";
import { DATE_CHANGE_KEY } from "../../extensions/lib/context-facts.ts";
import {
	CONTEXT_BASELINE_CHANNEL,
	CONTEXT_STACK_ENTRY,
	CONTEXT_STATE_ENTRY,
	type ContextStackSnapshot,
} from "../../extensions/lib/context-stack.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import { PLAN_FILE_ENTRY } from "../../extensions/lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../../extensions/permissions/modes.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import { buildPlanModeReminder } from "../../extensions/plan-mode/reminder.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

/** A branch entry as pi exposes it to session_start. */
const saved = (snapshot: ContextStackSnapshot) => ({ type: "custom", customType: CONTEXT_STACK_ENTRY, data: snapshot });
const first = (key: string, text: string, order: number) => ({ key, text, placement: "first-prepend" as const, order });
const sticky = (key: string, text: string, since = 10, opener: number | null = 5) => ({
	key,
	text,
	placement: "sticky-append" as const,
	order: 0,
	since,
	opener,
	tailPin: { kind: "user" as const, timestamp: 5 },
});
const user = (timestamp: number) => ({ role: "user", content: [{ type: "text", text: `turn ${timestamp}` }], timestamp });

function snapshot(stack: ContextStackSnapshot["stack"] = [], stickyEntries: ContextStackSnapshot["sticky"] = [], baselines: Record<string, unknown> = {}): ContextStackSnapshot {
	return { version: 1, stack, sticky: stickyEntries, baselines };
}

function contextFor(root: string, branch: unknown[] = []) {
	return createFakeCtx({
		cwd: root,
		sessionManager: { getSessionId: () => "stack-test", getSessionDir: () => root, getBranch: () => branch },
		modelRegistry: { getAvailable: () => [] },
		ui: { setWidget: () => {}, setStatus: () => {}, notify: () => {} },
	});
}

describe("restored context-stack emitters", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "one-code-context-stack-"));
		stubHome(root);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, ".claude"));
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("restores the saved Claude context instead of rereading edited CLAUDE.md, MEMORY.md, or git facts", async () => {
		writeFileSync(join(root, "CLAUDE.md"), "EDITED CLAUDE RULES\n");
		const memory = projectMemoryDir(root, root);
		mkdirSync(memory, { recursive: true });
		writeFileSync(join(memory, "MEMORY.md"), "EDITED MEMORY FACTS\n");
		const oldInstructions = "saved CLAUDE rules\nsaved MEMORY facts";
		const oldGit = "# gitStatus\nSAVED_GIT_FACT";
		const restored = snapshot(
			[
				first("claude-context", oldInstructions, 10),
				first("claude-context-context", oldGit, 20),
				first("claude-context-date", "Today's date is 2026-10-01.", 30),
			],
			[],
			{ "claude-context": { startupShown: [join(root, "CLAUDE.md")], shownDate: "2026-10-01" } },
		);
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		claudeContextExtension(fake.pi as never);
		const ctx = contextFor(root, [saved(restored)]);

		await fake.fire("session_start", {}, ctx);
		await fake.fire("turn_start", {}, ctx);
		const shaped = await fake.fireOne<{ messages: unknown[] }>("context", { messages: [user(100)] }, ctx);
		const wire = JSON.stringify(shaped?.messages);
		expect(wire).toContain("saved CLAUDE rules");
		expect(wire).toContain("saved MEMORY facts");
		expect(wire).toContain("SAVED_GIT_FACT");
		expect(wire).not.toContain("EDITED CLAUDE RULES");
		expect(wire).not.toContain("EDITED MEMORY FACTS");
	});

	it("uses the stored shown date for a resumed date notice, not the original frozen date block", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 9, 4, 12));
		const restored = snapshot(
			[first("claude-context-date", "Today's date is 2026-10-01.", 30)],
			[],
			{ "claude-context": { startupShown: [], shownDate: "2026-10-04" } },
		);
		const fake = createFakePi();
		const notices: Array<{ text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => notices.push(data as { text?: string }));
		systemReminderExtension(fake.pi as never);
		claudeContextExtension(fake.pi as never);
		const ctx = contextFor(root, [saved(restored)]);
		await fake.fire("session_start", {}, ctx);

		await fake.fire("before_agent_start", {}, ctx);
		expect(notices).toEqual([]);
		vi.setSystemTime(new Date(2026, 9, 5, 12));
		await fake.fire("before_agent_start", {}, ctx);
		expect(notices).toEqual([{ key: DATE_CHANGE_KEY, text: dateChangeReminder("2026-10-05") }]);
	});

	it("records a new first-message stack at compaction without mutating the original snapshot",  async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 9, 1, 12));
		writeFileSync(join(root, "CLAUDE.md"), "initial rules\n");
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		claudeContextExtension(fake.pi as never);
		const ctx = contextFor(root, []);
		await fake.fire("session_start", {}, ctx);
		await fake.fire("context", { messages: [user(1)] }, ctx);
		const original = fake.appendedEntries.find((entry) => entry.customType === CONTEXT_STACK_ENTRY)!;

		vi.setSystemTime(new Date(2026, 9, 2, 12));
		await fake.fire("session_compact", {}, ctx);
		await fake.fire("context", { messages: [user(2)] }, ctx);
		const originalStack = (original.data as ContextStackSnapshot).stack;
		expect(originalStack.find((entry) => entry.key === "claude-context-date")?.text).toBe("Today's date is 2026-10-01.");
		const update = fake.appendedEntries.find((entry) => entry.customType === CONTEXT_STATE_ENTRY);
		expect((update?.data as ContextStackSnapshot).stack.find((entry) => entry.key === "claude-context-date")?.text).toBe("Today's date is 2026-10-02.");
	});

	/** Produce the exact auto block through permissions rather than duplicating its large prompt literal. */
	async function autoSnapshot(): Promise<ContextStackSnapshot> {
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		permissionsExtension(fake.pi as never);
		const ctx = contextFor(root, []);
		await fake.fire("session_start", {}, ctx);
		await fake.fire("context", { messages: [user(1)] }, ctx);
		return structuredClone(fake.appendedEntries.find((entry) => entry.customType === CONTEXT_STACK_ENTRY)!.data as ContextStackSnapshot);
	}

	it("keeps a same-auto session's stored sticky anchors", async () => {
		const restored = await autoSnapshot();
		const auto = restored.sticky.find((entry) => entry.key === "permission-mode" && entry.until === undefined)!;
		restored.sticky = [
			{ ...sticky("permission-mode", auto.text, 0, 1), until: 4, tailPin: undefined },
			sticky("permission-mode", auto.text),
		];
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		permissionsExtension(fake.pi as never);
		const ctx = contextFor(root, [saved(restored)]);
		await fake.fire("session_start", {}, ctx);
		// Force a state write so the serialized sticky entry is observable.
		fake.events.emit(CONTEXT_BASELINE_CHANNEL, { key: "test-probe", value: true });
		await fake.fire("context", { messages: [user(1), user(5), user(20)] }, ctx);
		const update = fake.appendedEntries.find((entry) => entry.customType === CONTEXT_STATE_ENTRY)!;
		const savedSticky = (update.data as { sticky: ContextStackSnapshot["sticky"] }).sticky;
		expect(savedSticky.filter((entry) => entry.key === "permission-mode")).toHaveLength(2);
		const savedAuto = savedSticky.find((entry) => entry.key === "permission-mode" && entry.until === undefined)!;
		expect(savedAuto).toMatchObject({ since: 10, opener: 5, tailPin: { kind: "user", timestamp: 5 } });
	});

	it("treats a stored mode as announcement history: a live different mode switches and wins", async () => {
		const restored = await autoSnapshot();
		const fake = createFakePi();
		const reminders: Array<{ key?: string; text?: string }> = [];
		const statuses: PermissionStatus[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { key?: string; text?: string }));
		fake.events.on(PERMISSION_STATUS_CHANNEL, (data) => statuses.push(data as PermissionStatus));
		systemReminderExtension(fake.pi as never);
		permissionsExtension(fake.pi as never);
		fake.flags.set("permission-mode", "default");
		await fake.fire("session_start", {}, contextFor(root, [saved(restored)]));

		expect(statuses.at(-1)?.mode).toBe("default");
		expect(reminders.find((reminder) => reminder.key === "permission-mode-change")?.text).toContain('now "default"');
	});

	it("preserves a plan entry baseline and sticky anchor when its recorded path now exists", async () => {
		const planPath = join(root, "plans", "saved-plan.md");
		mkdirSync(join(root, "plans"), { recursive: true });
		writeFileSync(planPath, "# created after the saved snapshot\n");
		const planText = buildPlanModeReminder(planPath, false);
		const restored = snapshot(
			[],
			[sticky("permission-mode", planText)],
			{ "permission-mode": "plan", "plan-mode": { path: planPath, existed: false } },
		);
		const branch = [{ type: "custom", customType: PLAN_FILE_ENTRY, data: { path: planPath } }, saved(restored)];
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		permissionsExtension(fake.pi as never);
		planModeExtension(fake.pi as never);
		fake.flags.set("permission-mode", "plan");
		const ctx = contextFor(root, branch);
		await fake.fire("session_start", {}, ctx);
		await fake.fire("before_agent_start", {}, ctx);
		fake.events.emit(CONTEXT_BASELINE_CHANNEL, { key: "test-probe", value: true });
		await fake.fire("context", { messages: [user(5), user(20)] }, ctx);

		const update = fake.appendedEntries.find((entry) => entry.customType === CONTEXT_STATE_ENTRY)!;
		const savedPlan = ((update.data as { sticky: ContextStackSnapshot["sticky"] }).sticky.find((entry) => entry.key === "permission-mode" && entry.until === undefined))!;
		expect(savedPlan.text).toContain("No plan file exists yet.");
		expect(savedPlan.text).not.toContain("A plan file already exists");
		expect(savedPlan).toMatchObject({ since: 10, opener: 5, tailPin: { kind: "user", timestamp: 5 } });
	});
});
