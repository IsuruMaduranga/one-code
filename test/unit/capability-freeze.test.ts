/**
 * Message 1's capability blocks are live state, rendered when a request opens
 * an epoch; inside an epoch message 1 is the ledger's record, so their owners
 * announce what changed on the request's tail at render time, from what the
 * epoch told (extensions/ledger, lib/reminders.ts RENDER_CHANNEL).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toolsInUse } from "../../extensions/lib/deferred.ts";
import type { ToldFact } from "../../extensions/lib/ledger/records.ts";
import { pluginRoot } from "../../extensions/lib/plugin-root.ts";
import { REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest } from "../../extensions/lib/reminders.ts";
import { setSkillState } from "../../extensions/lib/skill-overrides.ts";
import { listableSkillNames, SKILL_LISTING_HEADER } from "../../extensions/skill/announce.ts";
import skillExtension from "../../extensions/skill/index.ts";
import subagentsExtension from "../../extensions/subagents/index.ts";
import { createFakeCtx, createFakePi, type FakePi, renderRequest } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import type { Reminder } from "./helpers/tool-search-fake-pi.ts";

/** Render one request inside an epoch that told `facts`; the blocks owners add. */
const render = (fake: FakePi, facts: readonly ToldFact[], model?: RenderRequest["model"]) => renderRequest(fake.events, { facts, model });
/** The facts the live first-prepend blocks under `key` tell, as an epoch's message 1 would. */
const liveFacts = (reminders: Array<Reminder & { facts?: ToldFact[] }>, key: string) => reminders.filter((r) => r.key === key && r.facts).at(-1)?.facts ?? [];

describe("skill announce (pure)", () => {
	it("lists what the listing shows, per framing", () => {
		const skills = [
			{ name: "on", state: "on" as const, path: "/s/on/SKILL.md" },
			{ name: "named", state: "name-only" as const, path: "/s/named/SKILL.md" },
			{ name: "hidden", state: "user-only" as const, path: "/s/hidden/SKILL.md" },
			{ name: "off", state: "off" as const, path: "/s/off/SKILL.md" },
			{ name: "user-started", state: "on" as const, path: "/s/u/SKILL.md", disableModelInvocation: true },
			{ name: "plug:cmd", state: "on" as const, path: "/p/cmd.md", kind: "command" },
		];
		expect(listableSkillNames(skills, false)).toEqual(["on", "named", "plug:cmd"]);
		expect(listableSkillNames(skills, true)).toEqual(["on", "named"]);
	});
});

describe("skills listing", () => {
	const root = mkdtempSync(join(tmpdir(), "capability-skills-"));
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

	async function mount() {
		const fake = createFakePi();
		const reminders: Array<Reminder & { facts?: ToldFact[] }> = [];
		fake.events.on(REMINDER_CHANNEL, (r) => reminders.push(r as Reminder));
		skillExtension(fake.pi as never);
		fake.setActiveTools(["skill"]);
		const ctx = createFakeCtx({ cwd, mode: "tui", hasUI: true });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const turn = (skills: unknown[]) => fake.fire("before_agent_start", { systemPromptOptions: { skills } }, ctx);
		return { fake, reminders, turn, ctx };
	}

	it("keeps the listing as live state with the names it tells, and announces only a skill the epoch has not told", async () => {
		const { fake, reminders, turn } = await mount();
		await turn([alpha]);
		const listing = reminders.filter((r) => r.key === "skills" && r.placement === "first-prepend").at(-1);
		expect(listing?.text).toContain("- alpha: The alpha skill");
		const told = liveFacts(reminders, "skills");
		expect(told).toEqual([{ kind: "skills", names: ["alpha"] }]);
		expect(render(fake, told)).toEqual([]);

		await turn([alpha, beta]);
		expect(render(fake, told)).toEqual([{ text: `${SKILL_LISTING_HEADER}\n\n- beta: The beta skill`, facts: [{ kind: "skills", names: ["beta"] }] }]);
		// A skill leaving the listing is not announced; the skill tool refuses it.
		await turn([beta]);
		expect(render(fake, [{ kind: "skills", names: ["alpha", "beta"] }])).toEqual([]);
	});

	it("refuses the model a skill the user set to user-only, though the epoch's listing still names it", async () => {
		const { fake, turn, ctx } = await mount();
		await turn([alpha, beta]);
		setSkillState(pluginRoot(join(root, "agent")), "project:beta", "user-only");
		try {
			const result = (await fake.tools.get("skill")!.execute("call", { skill: "beta" }, undefined, undefined, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("only the user can run it, by typing /beta");
		} finally {
			setSkillState(pluginRoot(join(root, "agent")), "project:beta", "on");
		}
	});

	it("adds nothing to a request that opens an epoch", async () => {
		const { fake, turn } = await mount();
		await turn([alpha, beta]);
		expect(renderRequest(fake.events, { epoch: true })).toEqual([]);
	});
});

describe("subagent blocks", () => {
	const main = { provider: "openai", id: "main", name: "main", input: ["text"], cost: { input: 2, output: 8 } };
	const other = { provider: "openai", id: "other", name: "other", input: ["text"], cost: { input: 1, output: 4 } };

	async function mount() {
		const fake = createFakePi();
		const reminders: Array<Reminder & { facts?: ToldFact[] }> = [];
		fake.events.on(REMINDER_CHANNEL, (r) => reminders.push(r as Reminder));
		subagentsExtension(fake.pi as never);
		const ctx = createFakeCtx({ model: main, modelRegistry: { getAvailable: () => [main, other] }, sessionManager: { getSessionId: () => "s", getBranch: () => fake.branch } });
		await fake.fire("session_start", {}, ctx);
		return { fake, reminders, ctx };
	}

	it("announces a changed menu once, on the tail, after the epoch told the old one", async () => {
		const { fake, reminders, ctx } = await mount();
		const told = [...liveFacts(reminders, "subagent-models"), ...liveFacts(reminders, "subagent-agents")];
		expect(render(fake, told)).toEqual([]);
		await fake.fire("model_select", { model: other }, { ...ctx, model: other });
		const blocks = render(fake, told);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toContain("other");
		expect(render(fake, [...told, ...(blocks[0].facts ?? [])])).toEqual([]);
	});

	it("keeps the three blocks as live first-prepend state, the catalog by Claude Code's heading", async () => {
		const { reminders } = await mount();
		const live = (key: string) => reminders.filter((r) => r.key === key && r.placement === "first-prepend").at(-1);
		expect(live("subagent-models")?.text).toContain("main");
		expect(live("subagent-agents")?.text).toMatch(/^Available agent types for the Agent tool:/);
		expect(reminders.filter((r) => r.key === "subagent-delegation").at(-1)).toMatchObject({ remove: true });
	});
});

describe("agent catalog read at each run's start (R3-M28)", () => {
	const root = mkdtempSync(join(tmpdir(), "capability-agents-"));
	const cwd = join(root, "project");
	beforeAll(() => {
		mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
		mkdirSync(join(root, "agent"), { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		stubHome(root);
	});
	afterAll(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("announces an agent file added mid-session on the next run, live minus told", async () => {
		const main = { provider: "openai", id: "main", name: "main", input: ["text"], cost: { input: 2, output: 8 } };
		const fake = createFakePi();
		const reminders: Array<Reminder & { facts?: ToldFact[] }> = [];
		fake.events.on(REMINDER_CHANNEL, (r) => reminders.push(r as Reminder));
		subagentsExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd, model: main, modelRegistry: { getAvailable: () => [main] }, sessionManager: { getSessionId: () => "s", getBranch: () => fake.branch } });
		await fake.fire("session_start", {}, ctx);
		const told = [...liveFacts(reminders, "subagent-models"), ...liveFacts(reminders, "subagent-agents")];
		writeFileSync(join(cwd, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews a diff\n---\nReview it.\n");
		await fake.fire("before_agent_start", { prompt: "go", systemPromptOptions: {} }, ctx);
		const blocks = render(fake, told);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toContain("reviewer");
	});

	it("rebuilds the catalog when an agent file is edited or removed, and reuses it otherwise", async () => {
		const main = { provider: "openai", id: "main", name: "main", input: ["text"], cost: { input: 2, output: 8 } };
		const fake = createFakePi();
		const reminders: Array<Reminder & { facts?: ToldFact[] }> = [];
		fake.events.on(REMINDER_CHANNEL, (r) => reminders.push(r as Reminder));
		subagentsExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd, model: main, modelRegistry: { getAvailable: () => [main] }, sessionManager: { getSessionId: () => "s", getBranch: () => fake.branch } });
		const file = join(cwd, ".claude", "agents", "editor.md");
		writeFileSync(file, "---\nname: editor\ndescription: Edits prose\n---\nEdit it.\n");
		await fake.fire("session_start", {}, ctx);
		const catalog = () => reminders.filter((r) => r.key === "subagent-agents" && r.placement === "first-prepend").at(-1)?.text ?? "";
		expect(catalog()).toContain("- editor: Edits prose");
		const before = catalog();
		await fake.fire("before_agent_start", { prompt: "go", systemPromptOptions: {} }, ctx);
		expect(catalog()).toBe(before);
		writeFileSync(file, "---\nname: editor\ndescription: Edits code, at more length\n---\nEdit it.\n");
		await fake.fire("before_agent_start", { prompt: "go", systemPromptOptions: {} }, ctx);
		expect(catalog()).toContain("- editor: Edits code, at more length");
		rmSync(file);
		await fake.fire("before_agent_start", { prompt: "go", systemPromptOptions: {} }, ctx);
		expect(catalog()).not.toContain("editor");
	});
});

describe("tools in use", () => {
	const call = (name: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: {} }] } });
	const load = (callId: string, added: string[]) => ({
		type: "message",
		message: { role: "toolResult", toolName: "tool_search", toolCallId: callId, content: [], details: { added } },
	});

	it("are the tools the entries call or load", () => {
		expect(toolsInUse([call("b"), load("t2", ["d"])] as never[])).toEqual(new Set(["b", "d"]));
		expect(toolsInUse([])).toEqual(new Set());
	});

	it("leave out a call the dispatcher failed as not found", () => {
		const notFound = { type: "message", message: { role: "toolResult", toolName: "b", toolCallId: "c1", isError: true, content: [{ type: "text", text: "Tool b not found" }] } };
		expect(toolsInUse([call("b"), notFound] as never[])).toEqual(new Set());
		const failed = { type: "message", message: { role: "toolResult", toolName: "b", toolCallId: "c1", isError: true, content: [{ type: "text", text: "Timed out" }] } };
		expect(toolsInUse([call("b"), failed] as never[])).toEqual(new Set(["b"]));
	});
});
