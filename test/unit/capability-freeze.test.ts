/**
 * Message 1's capability blocks are live state, rendered when a request opens
 * an epoch; inside an epoch message 1 is the ledger's record, so their owners
 * announce what changed on the request's tail at render time, from what the
 * epoch told (extensions/request/ledger, lib/request/reminders.ts RENDER_CHANNEL).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toolsInUse } from "../../extensions/lib/request/deferred.ts";
import type { ToldFact } from "../../extensions/lib/request/ledger/records.ts";
import { pluginRoot } from "../../extensions/lib/plugins/plugin-root.ts";
import { REMINDER_CHANNEL, type RenderRequest, STACK_QUERY_CHANNEL, type StackQuery, toldBlockFact as toldFact } from "../../extensions/lib/request/reminders.ts";
import { recordUsage } from "../../extensions/lib/plugins/usage-tracker.ts";
import { projectConfigDir } from "../../extensions/lib/profile/sources.ts";
import { setSkillState } from "../../extensions/lib/plugins/skill-overrides.ts";
import { listableSkillNames } from "../../extensions/tools/skill/announce.ts";
import skillExtension from "../../extensions/tools/skill/index.ts";
import subagentsExtension from "../../extensions/agents/subagents/index.ts";
import { subagentWords } from "../../extensions/agents/subagents/words.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { activeProfile, launchToolFilter, PRODUCT_DIR, PROFILE_DIR, type ResolvedProfile, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { profile as shippedProfile } from "./helpers/default-profile.ts";
import { createFakeCtx, createFakePi, type FakePi, renderRequest } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import type { Reminder } from "./helpers/tool-search-fake-pi.ts";
import { skillResultText } from "../../extensions/tools/skill/text.ts";
import { subagentResultText } from "../../extensions/lib/agents/subagent-text.ts";

const SKILL_LISTING_HEADER = skillResultText.listingHeader;

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
			expect(result.content[0].text).toBe(skillResultText.userOnly("beta"));
		} finally {
			setSkillState(pluginRoot(join(root, "agent")), "project:beta", "on");
		}
	});

	it("lets /context's preview keep no usage snapshot: the first prompt ranks by the usage it finds", async () => {
		// A budget one description short of the first prompt's whole listing: alpha or beta keeps its description, the more-used one.
		const usageRoot = pluginRoot(join(root, "agent"));
		const listingOf = (reminders: Array<Reminder & { facts?: ToldFact[] }>) => reminders.filter((r) => r.key === "skills" && r.placement === "first-prepend").at(-1)?.text;
		const reference = await mount();
		await reference.turn([alpha, beta]);
		const full = listingOf(reference.reminders)?.split("\n\n").slice(1).join("\n\n") ?? "";
		vi.stubEnv("SLASH_COMMAND_TOOL_CHAR_BUDGET", String(full.length - ": The beta skill".length));
		try {
			const queried = await mount();
			const query: StackQuery = { ctx: queried.ctx, stack: [] };
			queried.fake.events.emit(STACK_QUERY_CHANNEL, query);
			expect(query.stack?.some((entry) => entry.key === "skills")).toBe(true);
			// Used between /context and the first prompt.
			recordUsage(usageRoot, "skill", "beta");
			await queried.turn([alpha, beta]);
			const plain = await mount();
			await plain.turn([alpha, beta]);
			expect(listingOf(queried.reminders)).toContain("- beta: The beta skill");
			expect(listingOf(queried.reminders)).not.toContain("- alpha: The alpha skill");
			expect(listingOf(queried.reminders)).toBe(listingOf(plain.reminders));
		} finally {
			rmSync(join(usageRoot, "usage.json"), { force: true });
			vi.unstubAllEnvs();
			vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
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

	// One profile without flags for the whole block: a test that spies on its words must find the same copy.
	let plain: ResolvedProfile;
	beforeAll(() => void (plain = activeProfile()));
	afterEach(() => setActiveProfileForTest(plain));
	afterAll(() => setActiveProfileForTest(undefined));

	/**
	 * `unregistered`: tools pi left out of its registry (its --exclude-tools),
	 * so getAllTools does not list them and the live tool set leaves them out;
	 * `workflow`: the workflow tool is registered too.
	 */
	async function mount({ unregistered = [], workflow = false }: { unregistered?: string[]; workflow?: boolean } = {}) {
		// The fake registers no workflow tool unless asked: the flags leave it out with the rest.
		const excluded = [...unregistered, ...(workflow ? [] : ["workflow"])];
		setActiveProfileForTest(unregistered.length > 0 ? resolveProfile(shippedProfile, process.env, PROFILE_DIR, PRODUCT_DIR, undefined, launchToolFilter(["--exclude-tools", excluded.join(",")])) : plain);
		const fake = createFakePi();
		const reminders: Array<Reminder & { facts?: ToldFact[] }> = [];
		fake.events.on(REMINDER_CHANNEL, (r) => reminders.push(r as Reminder));
		subagentsExtension(fake.pi as never);
		// pi drops such a tool from every registration, the Agent tool's re-registration by tier included.
		const listed = fake.pi.getAllTools as () => Array<{ name: string }>;
		fake.pi.getAllTools = () => listed().filter((tool) => !unregistered.includes(tool.name));
		if (workflow) fake.tools.set("workflow", { name: "workflow", execute: async () => undefined });
		const ctx = createFakeCtx({ model: main, modelRegistry: { getAvailable: () => [main, other] }, sessionManager: { getSessionId: () => "s", getBranch: () => fake.branch } });
		await fake.fire("session_start", {}, ctx);
		return { fake, reminders, ctx };
	}
	/** The block's live first-prepend text, or undefined when its last word was a removal. */
	const liveText = (reminders: Array<Reminder & { facts?: ToldFact[] }>, key: string) => {
		const last = reminders.filter((r) => r.key === key).at(-1) as (Reminder & { remove?: boolean }) | undefined;
		return last?.remove ? undefined : last?.text;
	};
	const told = (reminders: Array<Reminder & { facts?: ToldFact[] }>) => ["subagent-models", "subagent-agents", "subagent-delegation"].flatMap((key) => liveFacts(reminders, key));

	describe("follow the tools the session can have, under pi's tool flags", () => {
		beforeAll(() => vi.stubEnv(envName("PROMPT_TIER"), "tiny"));
		afterAll(() => vi.unstubAllEnvs());

		it("publish the catalog and the delegation steer only while Agent is registered", async () => {
			const on = await mount();
			expect(liveText(on.reminders, "subagent-agents")).toContain("Available agent types");
			expect(liveText(on.reminders, "subagent-delegation")).toBe(subagentWords().delegationSteer);
			const off = await mount({ unregistered: ["Agent"] });
			expect(liveText(off.reminders, "subagent-agents")).toBeUndefined();
			expect(liveText(off.reminders, "subagent-delegation")).toBeUndefined();
			// A run of the agent turn checks again, and still finds no Agent.
			await off.fake.fire("before_agent_start", { prompt: "go", systemPromptOptions: {} }, off.ctx);
			expect(liveText(off.reminders, "subagent-agents")).toBeUndefined();
		});

		it("keep the model menu while Agent or workflow is registered", async () => {
			expect(liveText((await mount({ unregistered: ["Agent"] })).reminders, "subagent-models")).toBeUndefined();
			expect(liveText((await mount({ unregistered: ["Agent"], workflow: true })).reminders, "subagent-models")).toContain("main");
			expect(liveText((await mount()).reminders, "subagent-models")).toContain("main");
		});

		it("withdraw on the tail what the epoch told when a resumed session has no Agent, and tell the catalog when it is back", async () => {
			const before = await mount({ workflow: true });
			const gone = await mount({ unregistered: ["Agent"], workflow: true });
			// The menu stays (workflow), the catalog and the steer are withdrawn.
			expect(render(gone.fake, told(before.reminders))).toEqual([
				{ text: subagentWords().catalogWithdrawn, facts: [toldFact("subagent-agents", "")] },
				{ text: subagentWords().delegationWithdrawn, facts: [toldFact("subagent-delegation", "")] },
			]);
			const back = await mount({ workflow: true });
			const catalog = liveText(back.reminders, "subagent-agents");
			expect(render(back.fake, told(gone.reminders))).toEqual([
				{ text: catalog, facts: liveFacts(back.reminders, "subagent-agents") },
				{ text: subagentWords().delegationSteer, facts: liveFacts(back.reminders, "subagent-delegation") },
			]);
		});

		it("withdraw each block with its own sentence when a resumed session has neither Agent nor workflow", async () => {
			const before = await mount({ workflow: true });
			const gone = await mount({ unregistered: ["Agent"] });
			const words = subagentWords();
			expect(render(gone.fake, told(before.reminders))).toEqual([
				{ text: words.modelsWithdrawn, facts: [toldFact("subagent-models", "")] },
				{ text: words.catalogWithdrawn, facts: [toldFact("subagent-agents", "")] },
				{ text: words.delegationWithdrawn, facts: [toldFact("subagent-delegation", "")] },
			]);
			expect(new Set([words.modelsWithdrawn, words.catalogWithdrawn, words.delegationWithdrawn]).size).toBe(3);
		});
	});

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

	it("keeps the three blocks as live first-prepend state, the catalog in the profile's block", async () => {
		const catalogBlock = vi.spyOn(subagentResultText(), "catalogBlock");
		const { reminders } = await mount();
		const live = (key: string) => reminders.filter((r) => r.key === key && r.placement === "first-prepend").at(-1);
		expect(live("subagent-models")?.text).toContain("main");
		expect(catalogBlock).toHaveBeenCalled();
		expect(live("subagent-agents")?.text).toBe(catalogBlock.mock.results.at(-1)?.value);
		catalogBlock.mockRestore();
		expect(reminders.filter((r) => r.key === "subagent-delegation").at(-1)).toMatchObject({ remove: true });
	});
});

describe("agent catalog read at each run's start (R3-M28)", () => {
	const root = mkdtempSync(join(tmpdir(), "capability-agents-"));
	const cwd = join(root, "project");
	/** The project's agent folder in the profile's config layout. */
	const agentsDir = () => join(projectConfigDir(cwd), "agents");
	beforeAll(() => {
		mkdirSync(join(root, "agent"), { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		stubHome(root);
		mkdirSync(agentsDir(), { recursive: true });
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
		writeFileSync(join(agentsDir(), "reviewer.md"), "---\nname: reviewer\ndescription: Reviews a diff\n---\nReview it.\n");
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
		const file = join(agentsDir(), "editor.md");
		writeFileSync(file, "---\nname: editor\ndescription: Edits prose\n---\nEdit it.\n");
		const catalogBlock = vi.spyOn(subagentResultText(), "catalogBlock");
		await fake.fire("session_start", {}, ctx);
		const catalog = () => reminders.filter((r) => r.key === "subagent-agents" && r.placement === "first-prepend").at(-1)?.text ?? "";
		/** The rows of the block the catalog text was rendered from. */
		const rows = () => {
			expect(catalog()).toBe(catalogBlock.mock.results.at(-1)?.value);
			return catalogBlock.mock.calls.at(-1)?.[0].rows ?? [];
		};
		const editor = (description: string) => subagentResultText().catalogRow({ name: "editor", description, tools: { kind: "all", builtIn: false } });
		expect(rows()).toContain(editor("Edits prose"));
		const before = catalog();
		await fake.fire("before_agent_start", { prompt: "go", systemPromptOptions: {} }, ctx);
		expect(catalog()).toBe(before);
		writeFileSync(file, "---\nname: editor\ndescription: Edits code, at more length\n---\nEdit it.\n");
		await fake.fire("before_agent_start", { prompt: "go", systemPromptOptions: {} }, ctx);
		expect(rows()).toContain(editor("Edits code, at more length"));
		rmSync(file);
		await fake.fire("before_agent_start", { prompt: "go", systemPromptOptions: {} }, ctx);
		expect(rows().some((row) => row.includes("editor"))).toBe(false);
		catalogBlock.mockRestore();
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
