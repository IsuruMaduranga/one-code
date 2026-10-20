/**
 * Message 1's capability blocks are frozen once a request has gone out and
 * rebuilt at a compaction (working-docs/features/capability-freeze/): the
 * skills listing and the subagent blocks change by one-shot notices after the
 * first request, and every capability block is relisted from live state over
 * CONTEXT_CAPABILITY_REFRESH_CHANNEL when the summary starts a new prefix.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listableSkillNames, SKILL_LISTING_HEADER, skillNamesFromListing } from "../../extensions/skill/announce.ts";
import skillExtension from "../../extensions/skill/index.ts";
import subagentsExtension from "../../extensions/subagents/index.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import {
	CONTEXT_BASELINE_CHANNEL,
	CONTEXT_CAPABILITY_REFRESH_CHANNEL,
	CONTEXT_RESTORE_CHANNEL,
	CONTEXT_STACK_ENTRY,
	CONTEXT_STATE_ENTRY,
	type ContextCapabilityRefresh,
	type ContextStackSnapshot,
} from "../../extensions/lib/context-stack.ts";
import { REMINDER_CHANNEL, ReminderQueue } from "../../extensions/lib/reminders.ts";
import { deferredAddendumText, toolsToRedefer } from "../../extensions/lib/deferred.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import { makeToolSearchFakePi, type Reminder } from "./helpers/tool-search-fake-pi.ts";

describe("skill announce (pure)", () => {
	const skills = [
		{ name: "on", state: "on" as const, path: "/s/on/SKILL.md" },
		{ name: "named", state: "name-only" as const, path: "/s/named/SKILL.md" },
		{ name: "hidden", state: "user-only" as const, path: "/s/hidden/SKILL.md" },
		{ name: "off", state: "off" as const, path: "/s/off/SKILL.md" },
		{ name: "user-started", state: "on" as const, path: "/s/u/SKILL.md", disableModelInvocation: true },
		{ name: "plug:cmd", state: "on" as const, path: "/p/cmd.md", kind: "command" },
	];

	it("lists what the listing shows, per framing", () => {
		expect(listableSkillNames(skills, false)).toEqual(["on", "named", "plug:cmd"]);
		expect(listableSkillNames(skills, true)).toEqual(["on", "named"]);
	});

	it("reads the names in a stored listing, plugin names included", () => {
		expect(skillNamesFromListing(`${SKILL_LISTING_HEADER}\n\n- demo: A demo skill\n- named\n- plug:cmd: Run it`)).toEqual(["demo", "named", "plug:cmd"]);
		expect(skillNamesFromListing("Read a skill's file:\n\n- demo: Demo (/s/demo/SKILL.md)\n- bare (/s/bare/SKILL.md)")).toEqual(["demo", "bare"]);
		expect(skillNamesFromListing(undefined)).toBeUndefined();
	});
});

describe("skills listing wiring", () => {
	const root = mkdtempSync(join(tmpdir(), "capability-freeze-skills-"));
	const cwd = join(root, "project");
	const skill = (name: string) => {
		const dir = join(cwd, ".claude", "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
		return { name, description: `The ${name} skill`, filePath: join(dir, "SKILL.md") };
	};
	let alpha: ReturnType<typeof skill>;
	let beta: ReturnType<typeof skill>;
	beforeAll(() => {
		alpha = skill("alpha");
		beta = skill("beta");
		mkdirSync(join(root, "agent"), { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		stubHome(root);
	});
	afterAll(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function mount(restored?: ContextStackSnapshot) {
		const fake = createFakePi();
		if (restored) fake.events.on(CONTEXT_RESTORE_CHANNEL, (request) => ((request as { restored?: unknown }).restored = restored));
		const reminders: Reminder[] = [];
		const refreshes: ContextCapabilityRefresh[] = [];
		const baselines: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (r) => reminders.push(r as Reminder));
		fake.events.on(CONTEXT_CAPABILITY_REFRESH_CHANNEL, (r) => refreshes.push(r as ContextCapabilityRefresh));
		fake.events.on(CONTEXT_BASELINE_CHANNEL, (b) => (b as { key: string }).key === "skills" && baselines.push((b as { value: unknown }).value));
		skillExtension(fake.pi as never);
		fake.setActiveTools(["skill"]);
		const ctx = createFakeCtx({ cwd, mode: "tui", hasUI: true });
		await fake.fire("session_start", { reason: restored ? "resume" : "startup" }, ctx);
		const turn = (skills: unknown[]) => fake.fire("before_agent_start", { systemPromptOptions: { skills } }, ctx);
		return { fake, reminders, refreshes, baselines, turn };
	}
	const standing = (reminders: Reminder[]) => reminders.filter((r) => r.key === "skills" && r.placement === "first-prepend");
	const notices = (reminders: Reminder[]) => reminders.filter((r) => r.group === "skills");

	it("writes the listing before the first request, then announces only a new skill", async () => {
		const { fake, reminders, baselines, turn } = await mount();
		await turn([alpha]);
		expect(standing(reminders)).toHaveLength(1);
		expect(standing(reminders)[0].text).toContain("- alpha: The alpha skill");
		await fake.fire("context", { messages: [] });

		reminders.length = 0;
		await turn([alpha]);
		expect(reminders).toEqual([]);

		await turn([alpha, beta]);
		expect(standing(reminders)).toHaveLength(0);
		expect(notices(reminders).map((r) => r.text)).toEqual([`${SKILL_LISTING_HEADER}\n\n- beta: The beta skill`]);
		expect(baselines.at(-1)).toEqual(["alpha", "beta"]);

		// A skill leaving the listing is not announced; the skill tool refuses it.
		reminders.length = 0;
		await turn([beta]);
		expect(reminders).toEqual([]);
	});

	it("relists every skill at a compaction", async () => {
		const { fake, refreshes, baselines, turn } = await mount();
		await turn([alpha]);
		await fake.fire("context", { messages: [] });
		await turn([alpha, beta]);
		await fake.fire("session_compact", {});
		expect(refreshes).toHaveLength(1);
		expect(refreshes[0].key).toBe("skills");
		expect(refreshes[0].text).toBe(`${SKILL_LISTING_HEADER}\n\n- alpha: The alpha skill\n- beta: The beta skill`);
		expect(baselines.at(-1)).toEqual(["alpha", "beta"]);
	});

	it("keeps a resumed listing and announces a skill added since, by baseline or by the stored text", async () => {
		const fromBaseline = await mount({ version: 1, stack: [], sticky: [], baselines: { skills: ["alpha"] } });
		await fromBaseline.turn([alpha, beta]);
		expect(standing(fromBaseline.reminders)).toHaveLength(0);
		expect(notices(fromBaseline.reminders).map((r) => r.text)).toEqual([`${SKILL_LISTING_HEADER}\n\n- beta: The beta skill`]);

		const fromText = await mount({
			version: 1, sticky: [], baselines: {},
			stack: [{ key: "skills", text: `${SKILL_LISTING_HEADER}\n\n- alpha: The alpha skill`, placement: "first-prepend", order: 0 }],
		});
		await fromText.turn([alpha]);
		expect(fromText.reminders).toEqual([]);
	});
});

describe("subagent blocks", () => {
	const main = { provider: "openai", id: "main", name: "main", input: ["text"], cost: { input: 2, output: 8 } };
	const other = { provider: "openai", id: "other", name: "other", input: ["text"], cost: { input: 1, output: 4 } };

	async function mount() {
		const fake = createFakePi();
		const reminders: Reminder[] = [];
		const refreshes: ContextCapabilityRefresh[] = [];
		fake.events.on(REMINDER_CHANNEL, (r) => reminders.push(r as Reminder));
		fake.events.on(CONTEXT_CAPABILITY_REFRESH_CHANNEL, (r) => refreshes.push(r as ContextCapabilityRefresh));
		subagentsExtension(fake.pi as never);
		const ctx = createFakeCtx({ model: main, modelRegistry: { getAvailable: () => [main, other] } });
		await fake.fire("session_start", {}, ctx);
		return { fake, reminders, refreshes, ctx };
	}

	it("rewrites the menu on a model switch before the first request, and sends a notice after it", async () => {
		const { fake, reminders, ctx } = await mount();
		const menus = () => reminders.filter((r) => r.key === "subagent-models" && r.placement === "first-prepend");
		expect(menus()).toHaveLength(1);
		await fake.fire("model_select", { model: other }, { ...ctx, model: other });
		expect(menus()).toHaveLength(2);

		await fake.fire("context", { messages: [] });
		reminders.length = 0;
		await fake.fire("model_select", { model: main }, { ...ctx, model: main });
		expect(menus()).toHaveLength(0);
		expect(reminders.filter((r) => r.group === "subagent-models" && r.text?.includes("main"))).toHaveLength(1);
	});

	it("rebuilds the models, agents and delegation blocks at a compaction", async () => {
		const { fake, refreshes, ctx } = await mount();
		await fake.fire("context", { messages: [] });
		await fake.fire("session_compact", {}, ctx);
		expect(refreshes.map((r) => r.key)).toEqual(["subagent-models", "subagent-agents", "subagent-delegation"]);
		expect(refreshes[0].text).toContain("main");
		expect(refreshes[1].text).toMatch(/^Available agent types for the Agent tool:/);
		expect(refreshes[2].text).toBeNull();
	});
});

describe("loaded tools at a compaction", () => {
	const call = (name: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: {} }] } });
	const load = (callId: string, added: string[]) => ({
		type: "message",
		message: { role: "toolResult", toolName: "tool_search", toolCallId: callId, content: [], details: { added } },
	});
	const announcedIn = (name: string) => ({
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text: `<system-reminder>\n${deferredAddendumText([name])}\n</system-reminder>` }] },
	});

	it("returns them to deferred unless the kept turns call, load or announce them", () => {
		const kept = [call("b"), announcedIn("c"), load("t2", ["d"])] as never[];
		expect(toolsToRedefer(["a", "b", "c", "d", "a"], kept)).toEqual(["a"]);
		expect(toolsToRedefer(["a"], [])).toEqual(["a"]);
	});

	const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } };
	const openrouter = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", api: "openai-completions" };
	/** A session whose `late_echo` arrived by tool_addition and `web_fetch` was loaded by tool_search, then compacted. */
	async function compactAfterLoads(model: Record<string, unknown>) {
		const fake = makeToolSearchFakePi(["read"]);
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("web_fetch");
		fake.addDeferred("notebook_edit");
		fake.pi.fire("session_start", {}, createFakeCtx({ model, sessionManager: { getBranch: () => [] } }));
		fake.pi.fire("context", { messages: [] }, { model });
		await fake.runTool("tool_search", { query: "select:web_fetch" });
		fake.addDeferred("late_echo");
		await vi.advanceTimersByTimeAsync(150);
		const payload = model.provider === "anthropic"
			? { model: "claude-sonnet-5-5", max_tokens: 100, messages: [], tools: [{ name: "tool_search", input_schema: { type: "object" } }] }
			: { model: "x", messages: [], tools: [] };
		fake.pi.fire("before_provider_request", { payload }, { model });
		const kept = { type: "message", id: "kept", message: { role: "assistant", content: [{ type: "text", text: "done" }] } };
		const branch = [kept, { type: "compaction", id: "cmp", firstKeptEntryId: "kept" }];
		fake.pi.fire("session_compact", {}, createFakeCtx({ sessionManager: { getBranch: () => branch } }));
		return fake.activeTools();
	}

	describe("on a session", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("re-defers them where the request keeps loaded tools out of the tools array", async () => {
			expect(await compactAfterLoads(sonnet)).toEqual(["read"]);
		});

		it("leaves them active where a loaded tool already sits in the tools array", async () => {
			expect(await compactAfterLoads(openrouter)).toEqual(expect.arrayContaining(["read", "web_fetch"]));
		});
	});
});

describe("deferred tools at a compaction", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("lists a tool that arrived after the first request on the rebuilt listing", async () => {
		const fake = makeToolSearchFakePi(["read"]);
		toolSearchExtension(fake.pi as never);
		const refreshes: ContextCapabilityRefresh[] = [];
		const baselines: unknown[] = [];
		fake.pi.events.on(CONTEXT_CAPABILITY_REFRESH_CHANNEL, (r) => refreshes.push(r as ContextCapabilityRefresh));
		fake.pi.events.on(CONTEXT_BASELINE_CHANNEL, (b) => (b as { key: string }).key === "tool-search" && baselines.push((b as { value: unknown }).value));
		fake.addDeferred("web_fetch");
		fake.pi.fire("session_start", {});
		fake.pi.fire("context", { messages: [] });
		fake.addDeferred("late_echo");
		await vi.advanceTimersByTimeAsync(150);
		expect(fake.reminders.filter((r) => r.group === "deferred-tools" && r.text?.includes("late_echo"))).toHaveLength(1);

		fake.pi.fire("session_compact", {});
		expect(refreshes).toHaveLength(1);
		expect(refreshes[0].key).toBe("deferred-tools");
		expect(refreshes[0].text).toContain("\nlate_echo");
		expect(refreshes[0].text).toContain("\nweb_fetch");
		expect(baselines.at(-1)).toEqual(["web_fetch", "late_echo"]);

		// Nothing is announced twice afterwards.
		fake.reminders.length = 0;
		fake.addDeferred("later_tool");
		await vi.advanceTimersByTimeAsync(150);
		expect(fake.reminders.map((r) => r.text)).toEqual([expect.stringMatching(/\nlater_tool$/)]);
	});
});

describe("system-reminder capability refresh", () => {
	it("drops a rebuilt block's undelivered notices and keeps every other one-shot", () => {
		const queue = new ReminderQueue();
		queue.enqueue("late tool notice", { group: "deferred-tools" });
		queue.enqueue("skill notice", { group: "skills" });
		queue.enqueue("unkeyed notice");
		queue.cancelPendingNotices("deferred-tools");
		expect(queue.takeOneShots("call").map((entry) => entry.text)).toEqual(["skill notice", "unkeyed notice"]);
	});

	it("replaces a resume-locked capability block and stores one snapshot after the rebuilds", async () => {
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const restored: ContextStackSnapshot = {
			version: 1, sticky: [], baselines: {},
			stack: [{ key: "deferred-tools", text: "old listing", placement: "first-prepend", order: 20 }],
		};
		const ctx = createFakeCtx({ sessionManager: { getBranch: () => [{ type: "custom", customType: CONTEXT_STACK_ENTRY, data: restored }] } });
		await fake.fire("session_start", { reason: "resume" }, ctx);
		const lastStored = () => fake.appendedEntries.filter((entry) => entry.customType === CONTEXT_STATE_ENTRY).at(-1)?.data as ContextStackSnapshot | undefined;

		// The owner's own enqueue cannot touch a restored block...
		fake.events.emit(REMINDER_CHANNEL, { text: "ignored", scope: "every-turn", key: "deferred-tools", placement: "first-prepend", order: 20 });
		// ...but a compaction rebuild can, stored once after every emitter's rebuild.
		const before = fake.appendedEntries.length;
		fake.events.emit(CONTEXT_CAPABILITY_REFRESH_CHANNEL, { key: "deferred-tools", text: "new listing", order: 20 });
		fake.events.emit(CONTEXT_CAPABILITY_REFRESH_CHANNEL, { key: "skills", text: "skills listing", order: 30 });
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.appendedEntries.length).toBe(before + 1);
		expect(lastStored()?.stack).toEqual([
			{ key: "deferred-tools", text: "new listing", placement: "first-prepend", order: 20 },
			{ key: "skills", text: "skills listing", placement: "first-prepend", order: 30 },
		]);

		fake.events.emit(CONTEXT_CAPABILITY_REFRESH_CHANNEL, { key: "deferred-tools", text: null, order: 20 });
		await new Promise((resolve) => setImmediate(resolve));
		expect(lastStored()?.stack).toEqual([{ key: "skills", text: "skills listing", placement: "first-prepend", order: 30 }]);
	});
});
