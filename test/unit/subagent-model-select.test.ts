import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSubagentDefault } from "../../extensions/subagents/default-model.ts";
import {
	crossesProvider,
	resolveSubagentModel,
	subagentModelMenu,
	subagentModelsReminder,
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

	it("stays with the session's upstream vendor on a gateway", () => {
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

	it("uses the session model when nothing is requested", () => {
		const resolution = resolveSubagentModel({ sessionModel: anthropic[1], available: anthropic });
		expect(resolution.model?.id).toBe("claude-sonnet-5");
		expect(resolution.source).toBe("session");
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
