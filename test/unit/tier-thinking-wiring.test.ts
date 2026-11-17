/**
 * The profile's per-tier thinking level, wired through the effort feature on
 * pi's own runtime (ui/effort, lib/models/tier-thinking.ts): the first request
 * of a new session carries the tier's level, the user's choices win, a model
 * switch follows the tier, a resume keeps the branch's level, and the
 * default sets its level without the effort note. Only the provider is
 * replaced; the request's `reasoning` option is what the provider turns into
 * its effort field.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import effortExtension from "../../extensions/ui/effort/index.ts";
import { applyChildTierDefault } from "../../extensions/agents/subagents/runner.ts";
import { setModelTierOverridesForTest } from "../../extensions/lib/models/model-tier.ts";
import { TIER_THINKING_STATE } from "../../extensions/lib/models/tier-thinking.ts";
import { activeProfile, setActiveProfileForTest, setLaunchArgsForTest } from "../../extensions/lib/profile/profile.ts";
import type { ThinkingDefaults } from "../../extensions/lib/profile/thinking-defaults.ts";
import { readRecord, type EntryLike } from "../../extensions/lib/request/ledger/records.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const PROVIDER = "tier-provider";
const model = (id: string) =>
	({
		id, name: id, provider: PROVIDER, api: "openai-completions", baseUrl: "http://localhost.invalid",
		reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
	}) as const;
const CHEAP = model("cheap-model");
const WORKHORSE = model("workhorse-model");
const FRONTIER = model("frontier-model");
const DECLARED: ThinkingDefaults = { workhorse: "medium", cheap: "low", tiny: "low" };

const sessions: AgentSession[] = [];
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tier-thinking-wiring-"));
	stubHome(dir);
	setModelTierOverridesForTest({ [`${PROVIDER}/cheap-model`]: "cheap", [`${PROVIDER}/workhorse-model`]: "workhorse", [`${PROVIDER}/frontier-model`]: "frontier" });
	declare(DECLARED);
});
afterEach(async () => {
	for (const session of sessions.splice(0)) {
		await session.abort();
		session.dispose();
	}
	setModelTierOverridesForTest(undefined);
	setActiveProfileForTest(undefined);
	setLaunchArgsForTest([]);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

/** Run the session on a profile that declares `levels`, whichever profile the suite runs on. */
function declare(levels: ThinkingDefaults) {
	setActiveProfileForTest(undefined);
	setActiveProfileForTest({ ...activeProfile(), defaultThinkingLevels: levels });
}

interface Setup {
	model?: ReturnType<typeof model>;
	settings?: Record<string, unknown>;
	thinkingLevel?: "high";
	sessionManager?: SessionManager;
}

/** A session with the effort feature bound in print mode, as `pi -p` runs it; `reasoning` lists each request's level. */
async function start({ model: initial = CHEAP, settings = {}, thinkingLevel, sessionManager = SessionManager.inMemory(dir) }: Setup = {}) {
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, ...settings });
	const loader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [effortExtension],
	});
	await loader.reload();
	const runtime = await ModelRuntime.create({ credentials: {
		read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {},
	}, modelsPath: null, refreshOnCreate: false });
	vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
	// Any answer passes pi's model-switch check; the provider is never called.
	vi.spyOn(runtime, "checkAuth").mockResolvedValue({} as never);
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager,
		modelRuntime: runtime, model: initial as never, thinkingLevel, tools: [], sessionManager });
	sessions.push(session);
	const reasoning: Array<string | undefined> = [];
	session.agent.streamFunction = async (current, _context, options) => {
		reasoning.push(options?.reasoning);
		const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: current.api, provider: current.provider, model: current.id,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message } as never;
	};
	const errors: string[] = [];
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(`${error.event}: ${error.error}`) });
	return { session, reasoning, errors };
}

/** The sources the default recorded on the session's branch, in order. */
const recorded = (session: AgentSession) =>
	(session.sessionManager.getBranch() as EntryLike[]).flatMap((entry) => {
		const record = readRecord(entry);
		return record?.kind === "state" && record.data.key === TIER_THINKING_STATE ? [(record.data.value as { source: string }).source] : [];
	});

describe("a new session starts at its tier's level", () => {
	it.each([
		[CHEAP, "low", ["default"]],
		[WORKHORSE, "medium", ["default"]],
		// No frontier level: pi's own, and nothing recorded.
		[FRONTIER, "medium", []],
	] as const)("%s: the first request carries %s", async (initial, level, sources) => {
		const { session, reasoning, errors } = await start({ model: initial });
		expect(session.thinkingLevel).toBe(level);
		await session.prompt("hi");
		expect(reasoning).toEqual([level]);
		expect(recorded(session)).toEqual(sources);
		expect(errors).toEqual([]);
	});

	it("applies the declared level and lets pi fit it to the model", async () => {
		declare({ cheap: "xhigh" });
		const { session, reasoning } = await start();
		await session.prompt("hi");
		// The model has no xhigh: pi runs its highest level instead.
		expect(reasoning).toEqual(["high"]);
	});

	it.each([
		["a level saved for the model", { settings: { modelThinkingLevels: { [`${PROVIDER}/cheap-model`]: "high" } } }],
		["pi's global default", { settings: { defaultThinkingLevel: "high" } }],
	] as const)("keeps %s", async (_label, setup) => {
		const { session, reasoning } = await start(setup);
		await session.prompt("hi");
		expect(reasoning).toEqual(["high"]);
		expect(recorded(session)).toEqual([]);
	});

	it.each([
		[["--thinking", "high"], "high"],
		[["--model", `${PROVIDER}/cheap-model:high`], "high"],
		[["--models", `${PROVIDER}/cheap-model:high`], "high"],
	] as const)("keeps the level a launch flag set (%j)", async (args, level) => {
		setLaunchArgsForTest(args);
		const { session, reasoning } = await start({ thinkingLevel: level });
		await session.prompt("hi");
		expect(reasoning).toEqual([level]);
		expect(recorded(session)).toEqual([]);
	});
});

describe("a model switch follows the tier unless the user picked the level", () => {
	it("moves between tiers, and gives the level back to pi on a tier without one", async () => {
		const { session, reasoning } = await start();
		await session.prompt("one");
		await session.setModel(WORKHORSE as never);
		expect(session.thinkingLevel).toBe("medium");
		await session.setModel(CHEAP as never);
		expect(session.thinkingLevel).toBe("low");
		await session.prompt("two");
		await session.setModel(FRONTIER as never);
		expect(session.thinkingLevel).toBe("medium");
		await session.prompt("three");
		await session.setModel(CHEAP as never);
		await session.prompt("four");
		expect(reasoning).toEqual(["low", "low", "medium", "low"]);
		expect(recorded(session)).toEqual(["default", "default", "default", "pi", "default"]);
	});

	it("keeps a level the user picked (shift+tab or an RPC client) across switches", async () => {
		const { session, reasoning } = await start();
		session.setThinkingLevel("high");
		await session.setModel(WORKHORSE as never);
		expect(session.thinkingLevel).toBe("high");
		await session.setModel(FRONTIER as never);
		await session.setModel(CHEAP as never);
		await session.prompt("hi");
		expect(reasoning).toEqual(["high"]);
	});

	it("keeps a level picked with /effort, even the one already in force", async () => {
		const { session } = await start();
		const ctx = session.extensionRunner!.createCommandContext();
		await session.extensionRunner!.getCommand("effort")!.handler("low", ctx);
		await session.setModel(WORKHORSE as never);
		expect(session.thinkingLevel).toBe("low");
		// /effort auto hands the level back to the tier.
		await session.extensionRunner!.getCommand("effort")!.handler("auto", ctx);
		expect(session.thinkingLevel).toBe("medium");
		await session.setModel(CHEAP as never);
		expect(session.thinkingLevel).toBe("low");
	});

	it("starts from pi's level on a frontier session, then takes the cheap tier's", async () => {
		const { session } = await start({ model: FRONTIER });
		await session.setModel(CHEAP as never);
		expect(session.thinkingLevel).toBe("low");
	});
});

describe("a resumed session runs at the level its branch recorded", () => {
	it("is not given the tier's level again", async () => {
		const sessionDir = join(dir, "sessions");
		const first = await start({ sessionManager: SessionManager.create(dir, sessionDir) });
		await first.session.prompt("hi");
		const file = first.session.sessionManager.getSessionFile()!;
		// The profile now declares another level: the recorded one wins.
		declare({ cheap: "minimal" });
		const resumed = await start({ sessionManager: SessionManager.open(file, sessionDir) });
		expect(resumed.session.thinkingLevel).toBe("low");
		await resumed.session.prompt("again");
		expect(resumed.reasoning).toEqual(["low"]);
		// A switch in the resumed session still knows the level was the default's.
		await resumed.session.setModel(FRONTIER as never);
		expect(resumed.session.thinkingLevel).toBe("medium");
	});

	it("keeps a level the user picked before the resume", async () => {
		const sessionDir = join(dir, "sessions");
		const first = await start({ sessionManager: SessionManager.create(dir, sessionDir) });
		first.session.setThinkingLevel("high");
		await first.session.prompt("hi");
		const resumed = await start({ sessionManager: SessionManager.open(first.session.sessionManager.getSessionFile()!, sessionDir) });
		await resumed.session.setModel(WORKHORSE as never);
		expect(resumed.session.thinkingLevel).toBe("high");
	});
});

describe("the default is set quietly", () => {
	it("shows no effort note for its level, and does for the user's", async () => {
		const fake = createFakePi();
		let level = "medium";
		fake.pi.getThinkingLevel = vi.fn(() => level);
		const selects: Array<{ level: string }> = [];
		fake.pi.setThinkingLevel = vi.fn((wanted: string) => {
			if (wanted === level) return;
			level = wanted;
			fake.branch.push({ type: "thinking_level_change", id: `t${fake.branch.length}`, parentId: null, thinkingLevel: wanted } as never);
			selects.push({ level: wanted });
		});
		fake.pi.getSettings = () => ({});
		effortExtension(fake.pi as never);
		const ctx = createFakeCtx({ model: CHEAP, mode: "tui", hasUI: true, cwd: dir, sessionManager: { getBranch: () => fake.branch } });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		expect(level).toBe("low");
		for (const event of selects.splice(0)) await fake.fire("thinking_level_select", event, ctx);
		const ui = ctx.ui as { setWidget: ReturnType<typeof vi.fn> };
		const notes = () => ui.setWidget.mock.calls.filter(([key, widget]) => key === "effort-note" && widget !== undefined);
		expect(notes()).toEqual([]);
		// The user's own change still shows the note.
		level = "high";
		await fake.fire("thinking_level_select", { level: "high" }, ctx);
		expect(notes()).toHaveLength(1);
	});
});

describe("a subagent the call gave no thinking level", () => {
	const child = (childModel: ReturnType<typeof model> | undefined, settings: Record<string, unknown> = {}) => {
		const session = { model: childModel, settingsManager: { getSettings: () => settings }, setThinkingLevel: vi.fn() };
		applyChildTierDefault(session as never);
		return session.setThinkingLevel.mock.calls.map(([level]) => level);
	};

	it("starts at its own model's tier level", () => {
		expect(child(CHEAP)).toEqual(["low"]);
		expect(child(WORKHORSE)).toEqual(["medium"]);
		expect(child(FRONTIER)).toEqual([]);
		expect(child(undefined)).toEqual([]);
	});

	it("keeps pi's level under a saved or global level, or a launch flag", () => {
		expect(child(CHEAP, { modelThinkingLevels: { [`${PROVIDER}/cheap-model`]: "high" } })).toEqual([]);
		expect(child(CHEAP, { defaultThinkingLevel: "high" })).toEqual([]);
		setLaunchArgsForTest(["--thinking", "high"]);
		expect(child(CHEAP)).toEqual([]);
	});
});
