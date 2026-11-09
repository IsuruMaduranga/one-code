/**
 * One Code's part of subagent model selection: Claude Code's
 * `CLAUDE_CODE_SUBAGENT_MODEL` knob, which its provider reads as an alias from
 * the environment and from `~/.claude/settings.json`, and the wording of the
 * notices the base hands it. The base's selection is in
 * test/unit/subagent-model-select.test.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applicableSubagentDefault, loadSubagentDefault } from "../../extensions/lib/models/subagent-default.ts";
import { productSettingsPath } from "../../extensions/lib/product-settings.ts";
import { subagentModelsText } from "../text/subagent-models/index.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";
import { tempHome } from "../../test/unit/helpers/temp-home.ts";

const words = subagentModelsText(ALL_LIVE);

/** Minimal structural stand-in; only provider/id/cost are consulted. */
const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 } }) as never;

describe("loadSubagentDefault: Claude Code's knob", () => {
	let home: string;

	beforeEach(() => {
		home = tempHome("cc-subagent-default-").home;
		mkdirSync(join(home, ".claude"), { recursive: true });
	});

	it("reads CLAUDE_CODE_SUBAGENT_MODEL from the settings env block, Claude Code style", () => {
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } }));
		expect(loadSubagentDefault(home, {})).toEqual({ spec: "sonnet", source: "env", envVar: "CLAUDE_CODE_SUBAGENT_MODEL", borrowed: true });
	});

	it("lets the real environment override the settings env block", () => {
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } }));
		expect(loadSubagentDefault(home, { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" })?.spec).toBe("haiku");
	});

	it("prefers the explicit subagentModel setting over the env var", () => {
		// subagentModel is One Code's key: written to and read from ~/.onecode, while
		// the CLAUDE_CODE_SUBAGENT_MODEL env block stays a borrowed ~/.claude read.
		const own = productSettingsPath(home);
		mkdirSync(join(own, ".."), { recursive: true });
		writeFileSync(own, JSON.stringify({ subagentModel: "anthropic/claude-haiku-4-5" }));
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } }));
		const result = loadSubagentDefault(home, {});
		expect(result?.spec).toBe("anthropic/claude-haiku-4-5");
		expect(result?.source).toBe("subagentModel setting");
	});

	it("ignores a stale subagentModel left in ~/.claude by an older build", () => {
		// One Code used to write here; that value must not keep choosing subagents.
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ subagentModel: "opencode/gemini-3.7-flash" }));
		expect(loadSubagentDefault(home, {})).toBeUndefined();
	});
});

describe("applicableSubagentDefault: Claude Code's knob", () => {
	const envVar = { spec: "sonnet", source: "env", envVar: "CLAUDE_CODE_SUBAGENT_MODEL", borrowed: true } as const;

	it("applies the Claude Code env var only to Claude-family sessions", () => {
		expect(applicableSubagentDefault(envVar, model("anthropic", "claude-opus-4-8", 5))).toBe(envVar);
		// A Claude model on another provider still speaks the alias vocabulary.
		expect(applicableSubagentDefault(envVar, model("opencode", "claude-sonnet-5", 3))).toBe(envVar);
		// Claude Code's knob must not move an openai session's subagents.
		expect(applicableSubagentDefault(envVar, model("openai", "gpt-5.1", 1.25))).toBeUndefined();
	});
});

describe("One Code's subagent-model wording", () => {
	it("blames the containment, not the model's existence", () => {
		// "No sonnet model exists" is false whenever Anthropic is also
		// authenticated, and a model relaying it tells the user Sonnet is
		// unavailable. What is true is that the alias cannot leave this session's
		// containment.
		expect(words.notice({ kind: "aliasAsTier", alias: "sonnet", session: "openai/gpt-5.1", resolved: "openai/gpt-5.1" })).toBe(
			'No "sonnet" model in this session\'s provider family (openai/gpt-5.1); read as its Claude Code tier, "sonnet" resolves to openai/gpt-5.1 here.',
		);
		expect(words.notice({ kind: "aliasMissing", alias: "sonnet", session: "openai/gpt-5.4-mini" })).toBe(
			'No "sonnet" model in this session\'s provider family (openai/gpt-5.4-mini).',
		);
	});

	it("names no provider family when there is no session model", () => {
		expect(words.notice({ kind: "aliasMissing", alias: "sonnet" })).toBe('No "sonnet" model in this session\'s provider family.');
	});

	it("says the menu is not a whitelist", () => {
		const reminder = words.menu({ lines: [words.menuLine({ model: "anthropic/claude-opus-4-8", price: 5, label: "session" })], notes: [] });
		expect(reminder).toContain("not a whitelist");
		expect(reminder).toContain("sonnet|opus|haiku|fable");
	});

	it("names a menu line's price and a pinned cross-provider default", () => {
		expect(words.menuLine({ model: "anthropic/claude-haiku-4-5", price: 1, label: "cheaper" })).toContain("claude-haiku-4-5 ($1/M in)");
		const pinned = words.settingPinned({ model: "anthropic/claude-haiku-4-5", otherProvider: "openai/gpt-5.1" });
		expect(pinned).toContain("pinned the subagent default to anthropic/claude-haiku-4-5");
		expect(pinned).toContain("different provider than this session");
		expect(words.settingPinned({ model: "openai/gpt-5-mini" })).not.toContain("different provider than this session");
		expect(words.costsMore({ model: "anthropic/claude-opus-4-8", price: 5, session: "anthropic/claude-haiku-4-5", sessionPrice: 1 })).toContain(
			"claude-opus-4-8 ($5/M in)",
		);
	});

	it("names the refused model and the default it leaves", () => {
		expect(words.refused({ model: "openai/gpt-5-chat-latest", newDefault: "openai/gpt-5.2" })).toBe(
			"Model openai/gpt-5-chat-latest is not usable on this account, so automatic selection skips it and the subagent/workflow `model` field should not name it. The subagent default is now openai/gpt-5.2.",
		);
		expect(words.refused({ model: "openai/gpt-5-chat-latest" })).toContain("The subagent default is now this session's model.");
	});
});
