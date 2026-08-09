import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applicableSubagentDefault,
	loadSubagentDefault,
	persistSubagentModel,
} from "../../extensions/subagents/default-model.ts";
import {
	crossesProvider,
	expensiveModelGate,
	resolveSubagentModel,
	subagentModelMenu,
	subagentModelsReminder,
	subagentStatusModel,
} from "../../extensions/subagents/model-select.ts";

/** Minimal structural stand-in; only provider/id/cost are consulted. */
const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 } }) as any;

const anthropic = [
	model("anthropic", "claude-opus-4-8", 5),
	model("anthropic", "claude-sonnet-5", 3),
	model("anthropic", "claude-haiku-4-5", 1),
	model("anthropic", "claude-haiku-4-5-20251001", 1),
];
const openai = [model("openai", "gpt-5.1", 1.25), model("openai", "gpt-5-mini", 0.25)];

describe("resolveSubagentModel: aliases", () => {
	it("resolves Claude Code aliases within the session's provider, preferring undated ids", () => {
		const resolution = resolveSubagentModel({
			requested: "haiku",
			sessionModel: anthropic[0],
			available: [...anthropic, ...openai],
		});
		expect(resolution.model?.id).toBe("claude-haiku-4-5");
		expect(resolution.model?.provider).toBe("anthropic");
		expect(resolution.notices).toEqual([]);
	});

	it("never stretches an alias across providers — the session model serves instead", () => {
		// "sonnet" on an openai session names nothing there; picking Anthropic
		// would silently ship the task (or a fork's whole transcript) elsewhere.
		const resolution = resolveSubagentModel({
			requested: "sonnet",
			sessionModel: openai[0],
			available: [...anthropic, ...openai],
		});
		expect(resolution.model?.id).toBe("gpt-5.1");
		expect(resolution.source).toBe("session");
		expect(resolution.notices[0]).toContain('No "sonnet" model');
	});

	it("stays with the session's model-creator namespace on a gateway", () => {
		const catalog = [
			model("openrouter", "openai/gpt-5.1", 1.25),
			model("openrouter", "openai/gpt-5-mini", 0.25),
			model("openrouter", "anthropic/claude-haiku-4.5", 1),
		];
		const resolution = resolveSubagentModel({ requested: "haiku", sessionModel: catalog[0], available: catalog });
		// anthropic/claude-haiku-4.5 is same *pi provider* but another vendor.
		expect(resolution.model?.id).toBe("openai/gpt-5.1");
		expect(resolution.source).toBe("session");
	});

	it('treats "inherit" as the session model', () => {
		const resolution = resolveSubagentModel({
			requested: "inherit",
			agentModel: "haiku",
			sessionModel: anthropic[1],
			available: anthropic,
		});
		expect(resolution.model?.id).toBe("claude-sonnet-5");
	});
});

describe("resolveSubagentModel: precedence and exact references", () => {
	it("prefers per-call over agent frontmatter over the configured default", () => {
		const input = { sessionModel: anthropic[0], available: [...anthropic, ...openai] };
		expect(
			resolveSubagentModel({ ...input, requested: "haiku", agentModel: "sonnet", configuredDefault: "opus" }).model?.id,
		).toBe("claude-haiku-4-5");
		expect(resolveSubagentModel({ ...input, agentModel: "sonnet", configuredDefault: "opus" }).model?.id).toBe(
			"claude-sonnet-5",
		);
		expect(resolveSubagentModel({ ...input, configuredDefault: "opus" }).model?.id).toBe("claude-opus-4-8");
	});

	it("honors an exact cross-provider reference, with a notice — naming it is choosing it", () => {
		const resolution = resolveSubagentModel({
			requested: "openai/gpt-5-mini",
			sessionModel: anthropic[0],
			available: [...anthropic, ...openai],
		});
		expect(resolution.model?.provider).toBe("openai");
		expect(resolution.notices[0]).toContain("different provider");
	});

	it("fails a bad per-call request so the model that wrote it can retry", () => {
		const resolution = resolveSubagentModel({
			requested: "gpt-9000-ultra",
			sessionModel: anthropic[0],
			available: anthropic,
		});
		expect(resolution.unresolved).toBe("gpt-9000-ultra");
		expect(resolution.model).toBeUndefined();
	});

	it("degrades a bad configured default to the session model with a notice", () => {
		// A default the user set months ago must not fail every subagent run.
		const resolution = resolveSubagentModel({
			configuredDefault: "some/withdrawn-model",
			sessionModel: anthropic[0],
			available: anthropic,
		});
		expect(resolution.model?.id).toBe("claude-opus-4-8");
		expect(resolution.source).toBe("session");
		expect(resolution.notices[0]).toContain("not available");
	});

	it("falls through a bad agent-frontmatter model to the configured default", () => {
		const resolution = resolveSubagentModel({
			agentModel: "some/withdrawn-model",
			configuredDefault: "haiku",
			sessionModel: anthropic[0],
			available: anthropic,
		});
		expect(resolution.model?.id).toBe("claude-haiku-4-5");
		expect(resolution.source).toBe("default");
	});

	it("automatically chooses a smaller role-profile model when nothing is requested", () => {
		const resolution = resolveSubagentModel({ sessionModel: anthropic[1], available: anthropic });
		expect(resolution.model?.id).toBe("claude-haiku-4-5");
		expect(resolution.source).toBe("automatic");
	});

	it("uses Luna automatically for a Sol session", () => {
		const catalog = [
			model("openai-codex", "gpt-5.6-sol", 5),
			model("openai-codex", "gpt-5.6-luna", 0.2),
			model("openai-codex", "gpt-5.4-mini", 0.75),
		];
		const resolution = resolveSubagentModel({ sessionModel: catalog[0], available: catalog });
		expect(resolution.model?.id).toBe("gpt-5.6-luna");
		expect(resolution.source).toBe("automatic");
	});

	it("never selects automatically without price evidence on both sides", () => {
		// An unpriced catalog gives no proof of saving, and the anthropic profile
		// starts at sonnet-class — trusting its order would silently *upgrade*
		// a haiku session. Automatic selection is a cost optimisation only.
		const unpriced = [model("anthropic", "claude-haiku-4-5"), model("anthropic", "claude-sonnet-5")];
		const fromHaiku = resolveSubagentModel({ sessionModel: unpriced[0], available: unpriced });
		expect(fromHaiku.model?.id).toBe("claude-haiku-4-5");
		expect(fromHaiku.source).toBe("session");

		const mixed = [model("anthropic", "claude-haiku-4-5", 1), model("anthropic", "claude-sonnet-5")];
		const unpricedCandidate = resolveSubagentModel({ sessionModel: mixed[0], available: mixed });
		expect(unpricedCandidate.source).toBe("session");
	});

	it("requires a small-model name in the price-ranked fallback and ranks tiers over price", () => {
		// Profile misses everything here (a stale-profile future family). Raw
		// cheapest would pick the unknown $0.05 model or the nano as the default
		// coding worker; the hint floor excludes the former and tier rank puts
		// mini-class ahead of the cheaper nano.
		const catalog = [
			model("openai", "gpt-6", 10),
			model("openai", "gpt-6-mini", 1),
			model("openai", "gpt-6-nano", 0.1),
			model("openai", "gpt-6-zz", 0.05),
		];
		const resolution = resolveSubagentModel({ sessionModel: catalog[0], available: catalog });
		expect(resolution.model?.id).toBe("gpt-6-mini");
		expect(resolution.source).toBe("automatic");
	});

	it("does not get creative after an explicit agent-frontmatter choice fails", () => {
		// The agent author asked for a specific model; substituting an automatic
		// cheaper pick is a model nobody described. The session model serves.
		const resolution = resolveSubagentModel({
			agentModel: "some/withdrawn-model",
			sessionModel: anthropic[0],
			available: anthropic,
		});
		expect(resolution.model?.id).toBe("claude-opus-4-8");
		expect(resolution.source).toBe("session");
		expect(resolution.notices[0]).toContain("falling back");
	});
});

describe("expensiveModelGate", () => {
	const session = anthropic[2]; // haiku, $1/M
	const resolveCall = (requested: string) =>
		resolveSubagentModel({ requested, sessionModel: session, available: anthropic });

	it("gates a per-call model that outprices the session model", () => {
		const gate = expensiveModelGate(resolveCall("anthropic/claude-opus-4-8"), session, undefined);
		expect(gate).toContain("costs more per input token");
		expect(gate).toContain("claude-opus-4-8 ($5/M in)");
	});

	it("opens for allow_expensive, equal or cheaper prices, and unpriced models", () => {
		expect(expensiveModelGate(resolveCall("anthropic/claude-opus-4-8"), session, true)).toBeUndefined();
		expect(expensiveModelGate(resolveCall("anthropic/claude-haiku-4-5"), session, undefined)).toBeUndefined();
		const unpriced = [model("anthropic", "claude-haiku-4-5", 1), model("anthropic", "claude-mystery")];
		const resolution = resolveSubagentModel({
			requested: "anthropic/claude-mystery",
			sessionModel: unpriced[0],
			available: unpriced,
		});
		// A gate that fails closed on an unpriced catalog blocks the feature.
		expect(expensiveModelGate(resolution, unpriced[0], undefined)).toBeUndefined();
	});

	it("never gates user knobs — only the per-call field is model-chosen", () => {
		const configured = resolveSubagentModel({
			configuredDefault: "anthropic/claude-opus-4-8",
			sessionModel: session,
			available: anthropic,
		});
		expect(configured.source).toBe("default");
		expect(expensiveModelGate(configured, session, undefined)).toBeUndefined();
		const fromAgent = resolveSubagentModel({
			agentModel: "anthropic/claude-opus-4-8",
			sessionModel: session,
			available: anthropic,
		});
		expect(fromAgent.source).toBe("agent");
		expect(expensiveModelGate(fromAgent, session, undefined)).toBeUndefined();
	});
});

describe("crossesProvider", () => {
	it("catches provider changes and, on gateways, vendor changes", () => {
		expect(crossesProvider(openai[0], anthropic[0])).toBe(true);
		expect(crossesProvider(anthropic[2], anthropic[0])).toBe(false);
		const gwOpenai = model("openrouter", "openai/gpt-5-mini", 0.25);
		const gwAnthropic = model("openrouter", "anthropic/claude-haiku-4.5", 1);
		expect(crossesProvider(gwAnthropic, gwOpenai)).toBe(true);
		expect(crossesProvider(gwOpenai, gwOpenai)).toBe(false);
	});
});

describe("subagentModelMenu", () => {
	it("lists the default, the session model, and cheaper same-provider options with prices", () => {
		const menu = subagentModelMenu({
			available: [...anthropic, ...openai],
			sessionModel: anthropic[0],
			defaultModel: anthropic[0],
		});
		const text = menu.join("\n");
		expect(menu[0]).toContain("anthropic/claude-opus-4-8");
		expect(menu[0]).toContain("default");
		expect(text).toContain("claude-haiku-4-5 ($1/M in)");
		// Contained: no cross-provider entries, and the dated haiku duplicate is collapsed.
		expect(text).not.toContain("openai/");
		expect(text).not.toContain("20251001");
	});

	it("stays small on a gateway catalog and keeps to the session's vendor", () => {
		const catalog = [
			model("openrouter", "z-ai/glm-4.6", 0.5),
			model("openrouter", "z-ai/glm-4.5-air", 0.1),
			model("openrouter", "z-ai/glm-4.6:free", 0),
			model("openrouter", "z-ai/glm-4.6:batch", 0.25),
			model("openrouter", "openrouter/auto"),
			...Array.from({ length: 50 }, (_v, i) => model("openrouter", `openai/model-${i}`, 0.2)),
		];
		const menu = subagentModelMenu({ available: catalog, sessionModel: catalog[0], defaultModel: catalog[0] });
		expect(menu.length).toBeLessThanOrEqual(5);
		const text = menu.join("\n");
		expect(text).toContain("z-ai/glm-4.5-air");
		expect(text).not.toContain(":free");
		expect(text).not.toContain(":batch");
		expect(text).not.toContain("openai/model-");
	});

	it("says the menu is not a whitelist in the reminder", () => {
		const reminder = subagentModelsReminder({ available: anthropic, sessionModel: anthropic[0] });
		expect(reminder).toContain("not a whitelist");
		expect(reminder).toContain("sonnet|opus|haiku|fable");
	});

	it("warns when the configured default costs more than the session model", () => {
		// haiku session, opus default — a deliberate cheap-driver/strong-worker
		// setup, so the line informs; it does not tell the model to override.
		const reminder = subagentModelsReminder({
			available: anthropic,
			sessionModel: anthropic[2],
			defaultModel: anthropic[0],
			defaultSource: "default",
		});
		expect(reminder).toContain("costs more per input token");
		expect(reminder).toContain("($5/M in)");
	});

	it("does not warn when the default is cheaper, equal, or unpriced", () => {
		const cheaper = subagentModelsReminder({
			available: anthropic,
			sessionModel: anthropic[0],
			defaultModel: anthropic[2],
			defaultSource: "default",
		});
		expect(cheaper).not.toContain("costs more");
		const unpriced = subagentModelsReminder({
			available: anthropic,
			sessionModel: anthropic[0],
			defaultModel: model("anthropic", "claude-mystery"),
			defaultSource: "default",
		});
		expect(unpriced).not.toContain("costs more");
	});
});

describe("loadSubagentDefault", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cc-subagent-default-"));
		mkdirSync(join(home, ".claude"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("reads CLAUDE_CODE_SUBAGENT_MODEL from the settings env block, Claude Code style", () => {
		writeFileSync(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } }),
		);
		expect(loadSubagentDefault(home, {})).toEqual({ spec: "sonnet", source: "CLAUDE_CODE_SUBAGENT_MODEL" });
	});

	it("lets the real environment override the settings env block", () => {
		writeFileSync(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } }),
		);
		expect(loadSubagentDefault(home, { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" })?.spec).toBe("haiku");
	});

	it("prefers the explicit subagentModel setting over the env var", () => {
		writeFileSync(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ subagentModel: "anthropic/claude-haiku-4-5", env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } }),
		);
		const result = loadSubagentDefault(home, {});
		expect(result?.spec).toBe("anthropic/claude-haiku-4-5");
		expect(result?.source).toBe("subagentModel setting");
	});

	it("returns undefined when nothing is configured", () => {
		expect(loadSubagentDefault(home, {})).toBeUndefined();
	});
});

describe("applicableSubagentDefault", () => {
	const setting = { spec: "openai/gpt-5-mini", source: "subagentModel setting" } as const;
	const envVar = { spec: "sonnet", source: "CLAUDE_CODE_SUBAGENT_MODEL" } as const;

	it("applies One Code's own setting on any provider", () => {
		expect(applicableSubagentDefault(setting, openai[0])).toBe(setting);
		expect(applicableSubagentDefault(setting, anthropic[0])).toBe(setting);
	});

	it("applies the Claude Code env var only to Claude-family sessions", () => {
		expect(applicableSubagentDefault(envVar, anthropic[0])).toBe(envVar);
		// A Claude model on another provider still speaks the alias vocabulary.
		expect(applicableSubagentDefault(envVar, model("opencode", "claude-sonnet-5", 3))).toBe(envVar);
		// Claude Code's knob must not move an openai session's subagents.
		expect(applicableSubagentDefault(envVar, openai[0])).toBeUndefined();
	});

	it("passes through when nothing is configured or there is no session model", () => {
		expect(applicableSubagentDefault(undefined, openai[0])).toBeUndefined();
		expect(applicableSubagentDefault(envVar, undefined)).toBe(envVar);
	});
});

describe("subagentStatusModel", () => {
	const setting = { source: "subagentModel setting" } as const;
	const envVar = { source: "CLAUDE_CODE_SUBAGENT_MODEL" } as const;

	it("shows a configured default with its knob, even when it equals the session model", () => {
		// A user who just ran /subagent must see their choice land in the banner;
		// hiding it because it happens to match the session reads as "not saved".
		expect(subagentStatusModel(setting, { model: anthropic[1], source: "default" })).toEqual({
			model: "anthropic/claude-sonnet-5",
			via: "setting",
		});
		expect(subagentStatusModel(envVar, { model: anthropic[2], source: "default" })).toEqual({
			model: "anthropic/claude-haiku-4-5",
			via: "env",
		});
	});

	it("shows the session model as such for unset, inherit, and degraded defaults", () => {
		// After /subagent clear the slot going blank read as breakage; and the
		// tag follows the resolution, so a default that could not resolve reads
		// "session" — what actually runs — not the knob that failed.
		expect(subagentStatusModel(undefined, { model: openai[0], source: "session" })).toEqual({
			model: "openai/gpt-5.1",
			via: "session",
		});
		expect(subagentStatusModel(setting, { model: openai[0], source: "session" })).toEqual({
			model: "openai/gpt-5.1",
			via: "session",
		});
	});

	it("labels an automatic role-profile default distinctly", () => {
		expect(subagentStatusModel(undefined, { model: openai[1], source: "automatic" })).toEqual({
			model: "openai/gpt-5-mini",
			via: "auto",
		});
	});

	it("shows nothing only when nothing resolves at all", () => {
		expect(subagentStatusModel(setting, { model: undefined, source: "session" })).toEqual({});
	});
});

describe("persistSubagentModel", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cc-subagent-persist-"));
		mkdirSync(join(home, ".claude"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	const settingsPath = () => join(home, ".claude", "settings.json");
	const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf-8"));

	it("creates the settings file when there is none", () => {
		rmSync(join(home, ".claude"), { recursive: true, force: true });
		persistSubagentModel("openai/gpt-5-mini", home);
		expect(readSettings()).toEqual({ subagentModel: "openai/gpt-5-mini" });
	});

	it("preserves unrelated keys", () => {
		writeFileSync(
			settingsPath(),
			JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" }, permissions: { allow: ["Bash(npm test:*)"] } }),
		);
		persistSubagentModel("anthropic/claude-haiku-4-5", home);
		expect(readSettings()).toEqual({
			env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
			permissions: { allow: ["Bash(npm test:*)"] },
			subagentModel: "anthropic/claude-haiku-4-5",
		});
	});

	it("wins over the env var once saved, and round-trips through the loader", () => {
		writeFileSync(settingsPath(), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } }));
		persistSubagentModel("inherit", home);
		expect(loadSubagentDefault(home, {})).toEqual({ spec: "inherit", source: "subagentModel setting" });
	});

	it("removes the setting on clear", () => {
		writeFileSync(settingsPath(), JSON.stringify({ subagentModel: "openai/gpt-5-mini" }));
		persistSubagentModel(undefined, home);
		expect(readSettings()).toEqual({});
	});

	it("refuses to clobber a malformed settings file", () => {
		// A lenient read merely skips a setting; a lenient write would replace
		// the user's whole settings file with only ours.
		writeFileSync(settingsPath(), "{not json");
		expect(() => persistSubagentModel("openai/gpt-5-mini", home)).toThrow();
		expect(readFileSync(settingsPath(), "utf-8")).toBe("{not json");
	});
});
