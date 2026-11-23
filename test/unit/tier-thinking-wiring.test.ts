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
import { type LevelSource, TIER_THINKING_STATE } from "../../extensions/lib/models/tier-thinking.ts";
import { activeProfile, setActiveProfileForTest, setLaunchArgsForTest } from "../../extensions/lib/profile/profile.ts";
import type { ThinkingDefaults } from "../../extensions/lib/profile/thinking-defaults.ts";
import { readRecord, type EntryLike } from "../../extensions/lib/request/ledger/records.ts";
import { stubHome } from "./helpers/home.ts";
import { plainTheme } from "./helpers/plain-theme.ts";

const PROVIDER = "tier-provider";
const model = (id: string) =>
	({
		id, name: id, provider: PROVIDER, api: "openai-completions", baseUrl: "http://localhost.invalid",
		reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
	}) as const;
const CHEAP = model("cheap-model");
const WORKHORSE = model("workhorse-model");
const FRONTIER = model("frontier-model");
const FRONTIER2 = model("frontier2-model");
const DECLARED: ThinkingDefaults = { workhorse: "medium", cheap: "low", tiny: "low" };

const sessions: AgentSession[] = [];
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tier-thinking-wiring-"));
	stubHome(dir);
	setModelTierOverridesForTest({ [`${PROVIDER}/cheap-model`]: "cheap", [`${PROVIDER}/workhorse-model`]: "workhorse", [`${PROVIDER}/frontier-model`]: "frontier", [`${PROVIDER}/frontier2-model`]: "frontier" });
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
	/** Bind in the TUI's mode with a UI that records the effort note. */
	ui?: boolean;
}

const UI_METHODS = "select confirm input notify onTerminalInput setStatus setWorkingMessage setWorkingVisible setWorkingIndicator setHiddenThinkingLabel setFooter setHeader setTitle custom pasteToEditor setEditorText getEditorText addAutocompleteProvider setEditorComponent getEditorComponent getAllThemes getTheme setTheme getToolsExpanded setToolsExpanded";

/**
 * A session with the effort feature bound, in print mode as `pi -p` runs it
 * or with a UI; `reasoning` lists each request's level, `notes()` counts the
 * effort notes shown.
 */
async function start({ model: initial = CHEAP, settings = {}, thinkingLevel, sessionManager = SessionManager.inMemory(dir), ui = false }: Setup = {}) {
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
	const widgets: Array<[string, unknown]> = [];
	const uiContext: Record<string, unknown> = Object.fromEntries(UI_METHODS.split(" ").map((name) => [name, () => undefined]));
	uiContext.setWidget = (key: string, widget: unknown) => widgets.push([key, widget]);
	uiContext.theme = plainTheme;
	await session.bindExtensions({ mode: ui ? "tui" : "print", ...(ui ? { uiContext: uiContext as never } : {}), onError: (error) => errors.push(`${error.event}: ${error.error}`) });
	const notes = () => widgets.filter(([key, widget]) => key === "effort-note" && widget !== undefined).length;
	return { session, reasoning, errors, notes };
}

/** Let pi's unawaited extension events settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

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

	it("keeps a level picked right after a switch that left the level alone", async () => {
		const { session } = await start({ model: FRONTIER });
		// Frontier to frontier: pi carries the level and records no level change.
		await session.setModel(FRONTIER2 as never);
		session.setThinkingLevel("high");
		await session.setModel(CHEAP as never);
		expect(session.thinkingLevel).toBe("high");
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
	it("shows no effort note for its level, at a start and at a switch", async () => {
		const { session, notes, errors } = await start({ ui: true });
		expect(session.thinkingLevel).toBe("low");
		await settle();
		expect(notes()).toBe(0);
		await session.setModel(WORKHORSE as never);
		await settle();
		expect(session.thinkingLevel).toBe("medium");
		expect(notes()).toBe(0);
		expect(errors).toEqual([]);
	});

	it("still shows the note for the user's change, back to the default's level too", async () => {
		const { session, notes } = await start({ ui: true });
		session.setThinkingLevel("high");
		await settle();
		expect(notes()).toBe(1);
		session.setThinkingLevel("low");
		await settle();
		expect(notes()).toBe(2);
	});
});

describe("a /tree move keeps the owner of the live level", () => {
	it("gives a default level back to pi on a later switch to a frontier model", async () => {
		const { session } = await start({ model: FRONTIER });
		await session.prompt("one");
		const early = session.sessionManager.getLeafId()!;
		await session.setModel(CHEAP as never);
		expect(session.thinkingLevel).toBe("low");
		await session.prompt("two");
		// Back to a node from before the cheap model: pi keeps the live level and records it at the next prompt.
		await session.navigateTree(early);
		await session.prompt("three");
		await session.setModel(FRONTIER as never);
		expect(session.thinkingLevel).toBe("medium");
	});

	it("keeps a level the user picked", async () => {
		const { session } = await start({ model: FRONTIER });
		await session.prompt("one");
		const early = session.sessionManager.getLeafId()!;
		session.setThinkingLevel("high");
		await session.prompt("two");
		await session.navigateTree(early);
		await session.prompt("three");
		await session.setModel(CHEAP as never);
		expect(session.thinkingLevel).toBe("high");
	});
});

describe("/effort auto releases a launch level", () => {
	it("hands later switches back to the tier", async () => {
		setLaunchArgsForTest(["--thinking", "high"]);
		const { session } = await start({ thinkingLevel: "high" });
		expect(session.thinkingLevel).toBe("high");
		await session.setModel(WORKHORSE as never);
		// The launch level holds until auto.
		expect(session.thinkingLevel).toBe("high");
		const ctx = session.extensionRunner!.createCommandContext();
		await session.extensionRunner!.getCommand("effort")!.handler("auto", ctx);
		expect(session.thinkingLevel).toBe("medium");
		await session.setModel(CHEAP as never);
		expect(session.thinkingLevel).toBe("low");
		await session.setModel(FRONTIER as never);
		expect(session.thinkingLevel).toBe("medium");
		await session.setModel(CHEAP as never);
		expect(session.thinkingLevel).toBe("low");
	});
});

describe("an active ultracode is never replaced by a tier default", () => {
	const effort = (session: AgentSession, arg: string) => session.extensionRunner!.getCommand("effort")!.handler(arg, session.extensionRunner!.createCommandContext());

	it("keeps ultracode's level on a switch", async () => {
		const { session } = await start();
		await effort(session, "ultracode");
		expect(session.thinkingLevel).toBe("high");
		await session.setModel(WORKHORSE as never);
		expect(session.thinkingLevel).toBe("high");
	});

	it("keeps ultracode user-owned after a /tree move from a default-owned branch at the same level", async () => {
		// The cheap tier declares the level ultracode fits to on this model.
		declare({ cheap: "high", workhorse: "medium" });
		const { session } = await start();
		await session.prompt("one");
		const fork = session.sessionManager.getLeafId()!;
		await effort(session, "ultracode");
		await session.prompt("two");
		const ultracodeLeaf = session.sessionManager.getLeafId()!;
		await session.navigateTree(fork);
		await effort(session, "auto");
		expect(session.thinkingLevel).toBe("high");
		await session.prompt("three");
		await session.navigateTree(ultracodeLeaf);
		await session.setModel(WORKHORSE as never);
		expect(session.thinkingLevel).toBe("high");
	});
});

describe("a subagent the call gave no thinking level", () => {
	const child = (childModel: ReturnType<typeof model> | undefined, settings: Record<string, unknown> = {}, parentSource: LevelSource = "pi", launchReleased = false) => {
		const session = { model: childModel, settingsManager: { getSettings: () => settings }, setThinkingLevel: vi.fn() };
		applyChildTierDefault(session as never, { source: parentSource, launchReleased });
		return session.setThinkingLevel.mock.calls.map(([level]) => level);
	};

	it("starts at its own model's tier level", () => {
		expect(child(CHEAP)).toEqual(["low"]);
		expect(child(WORKHORSE)).toEqual(["medium"]);
		expect(child(FRONTIER)).toEqual([]);
		expect(child(undefined)).toEqual([]);
		// The parent's level was the default's: the child still takes its own tier's.
		expect(child(CHEAP, {}, "default")).toEqual(["low"]);
	});

	it("keeps pi's level when the user picked the parent's level", () => {
		expect(child(CHEAP, {}, "user")).toEqual([]);
		expect(child(WORKHORSE, {}, "user")).toEqual([]);
	});

	it("keeps pi's level under a saved or global level, or a launch flag", () => {
		expect(child(CHEAP, { modelThinkingLevels: { [`${PROVIDER}/cheap-model`]: "high" } })).toEqual([]);
		expect(child(CHEAP, { defaultThinkingLevel: "high" })).toEqual([]);
		setLaunchArgsForTest(["--thinking", "high"]);
		expect(child(CHEAP)).toEqual([]);
		// The parent's /effort auto released the launch level.
		expect(child(CHEAP, {}, "default", true)).toEqual(["low"]);
	});
});
