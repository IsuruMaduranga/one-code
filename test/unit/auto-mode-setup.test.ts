import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadAutoModeConfig,
	persistAutoModeSetup,
	removeOneCodePermissionAllow,
} from "../../extensions/auto-mode/config.ts";
import {
	auditPermissionAllow,
	buildSetupPrompt,
	parseGitRemotes,
	parseSetupDraft,
	redactSecrets,
	renderProposal,
	SetupDraftError,
	type SetupFacts,
	settingsPatch,
} from "../../extensions/auto-mode/setup.ts";

const facts: SetupFacts = {
	cwd: "/home/u/proj",
	username: "u",
	usage: "Software development in this repo",
	gitRoot: "/home/u/proj",
	remotes: [{ name: "origin", url: "git@github.com:acme/proj.git" }],
	repoVisibility: "PUBLIC",
	permissionsAllow: [],
	gatherNotes: ["gh was not available"],
};

describe("parseGitRemotes", () => {
	it("collapses fetch/push pairs into unique remotes", () => {
		const output = [
			"origin\tgit@github.com:acme/proj.git (fetch)",
			"origin\tgit@github.com:acme/proj.git (push)",
			"mirror\thttps://example.com/proj.git (fetch)",
		].join("\n");
		expect(parseGitRemotes(output)).toEqual([
			{ name: "origin", url: "git@github.com:acme/proj.git" },
			{ name: "mirror", url: "https://example.com/proj.git" },
		]);
	});

	it("returns [] for empty or malformed output", () => {
		expect(parseGitRemotes("")).toEqual([]);
		expect(parseGitRemotes("not remote output")).toEqual([]);
	});
});

describe("redactSecrets", () => {
	it("masks assignments to secret-looking variables", () => {
		expect(redactSecrets("export OPENAI_API_KEY=sk-abc123")).not.toContain("abc123");
		expect(redactSecrets("mysql --password hunter2")).not.toContain("hunter2");
	});

	it("masks well-known token shapes even without an assignment", () => {
		expect(redactSecrets("curl -H 'Auth: ghp_16C7e42F292c6912E7710c838347Ae178B4a'")).not.toContain("ghp_16C");
	});

	it("leaves ordinary commands alone", () => {
		expect(redactSecrets("git commit -m 'fix keyboard handling'")).toBe("git commit -m 'fix keyboard handling'");
	});
});

describe("buildSetupPrompt", () => {
	it("carries the default slots and the facts, and demands strict JSON", () => {
		const { system, user } = buildSetupPrompt(facts, ["**Organization**: None configured"]);
		expect(system).toContain("ONLY a JSON object");
		expect(system).toContain("append-only");
		expect(user).toContain("- **Organization**: None configured");
		expect(user).toContain("acme/proj");
		expect(user).toContain("gh was not available");
	});
});

describe("parseSetupDraft", () => {
	const good = JSON.stringify({
		environment: ["### Org-wide", "**Organization**: None configured"],
		allow: ["$defaults", "Bash(make test:*) in /home/u/proj"],
		soft_deny: [],
		notes: ["shell history not scanned"],
	});

	it("parses a clean draft, stripping $defaults from rule lists", () => {
		const draft = parseSetupDraft(good);
		expect(draft.environment).toHaveLength(2);
		expect(draft.allow).toEqual(["Bash(make test:*) in /home/u/proj"]);
		expect(draft.hard_deny).toEqual([]);
		expect(draft.notes).toEqual(["shell history not scanned"]);
	});

	it("tolerates prose and fences around the JSON", () => {
		expect(parseSetupDraft("Here you go:\n```json\n" + good + "\n```").environment).toHaveLength(2);
	});

	it("unbullets environment entries a model insisted on bulleting", () => {
		const draft = parseSetupDraft(JSON.stringify({ environment: ["- **Organization**: Acme"] }));
		expect(draft.environment).toEqual(["**Organization**: Acme"]);
	});

	it("strips a hallucinated $defaults from the environment before it can splice later", () => {
		const draft = parseSetupDraft(JSON.stringify({ environment: ["$defaults", "**Organization**: Acme"] }));
		expect(draft.environment).toEqual(["**Organization**: Acme"]);
	});

	it("rejects a truncated draft that drops built-in environment slots", () => {
		const defaults = ["### Org-wide", "**Organization**: None configured", "**Secrets management**: None configured"];
		expect(() =>
			parseSetupDraft(JSON.stringify({ environment: ["**Organization**: Acme"] }), defaults),
		).toThrow(/missing built-in slot\(s\): Secrets management/);
		// A full restatement (edited or not) passes; extra slots are welcome.
		const full = parseSetupDraft(
			JSON.stringify({
				environment: ["**Organization**: Acme", "**Secrets management**: Vault", "**New slot**: extra"],
			}),
			defaults,
		);
		expect(full.environment).toHaveLength(3);
	});

	it("fails loud on missing JSON, malformed JSON, and wrong shapes", () => {
		expect(() => parseSetupDraft("no json here")).toThrow(SetupDraftError);
		expect(() => parseSetupDraft("{not json}")).toThrow(SetupDraftError);
		expect(() => parseSetupDraft(JSON.stringify({ environment: "not a list" }))).toThrow(SetupDraftError);
		expect(() => parseSetupDraft(JSON.stringify({ environment: [] }))).toThrow(SetupDraftError);
		expect(() => parseSetupDraft(JSON.stringify({ environment: ["ok"], allow: [42] }))).toThrow(SetupDraftError);
		expect(() => parseSetupDraft(JSON.stringify({ environment: ["two\nlines"] }))).toThrow(SetupDraftError);
	});
});

describe("settingsPatch / renderProposal", () => {
	const draft = parseSetupDraft(
		JSON.stringify({ environment: ["**Organization**: Acme"], allow: ["Bash(x:*)"], soft_deny: [], hard_deny: [] }),
	);

	it("prefixes populated rule lists with $defaults and omits empty ones", () => {
		const patch = settingsPatch(draft);
		expect(patch.environment).toEqual(["**Organization**: Acme"]);
		expect(patch.allow).toEqual(["$defaults", "Bash(x:*)"]);
		expect(patch.soft_deny).toBeUndefined();
		expect(patch.hard_deny).toBeUndefined();
	});

	it("renders every section, saying when nothing is suggested", () => {
		const text = renderProposal(draft);
		expect(text).toContain("**Organization**: Acme");
		expect(text).toContain("Allow carve-outs");
		expect(text).toContain("none suggested");
	});
});

describe("auditPermissionAllow", () => {
	it("flags every shape the gate's own isBroadExecutionRule suspends", () => {
		// Includes the quote-wrapped inline-code spellings real settings carry
		// (and CC's own setup audit flags): `python3 -c '*`, `node -e ' *`.
		const rules = [
			"Bash(python3 -c '*)",
			"Bash(node -e ' *)",
			"Bash(pnpm run *)",
			"Bash(npx *)",
			"Bash(python*)",
			"Bash(docker*)",
			"Bash(*)",
			"Task(*)",
		];
		expect(auditPermissionAllow(rules).map((entry) => entry.rule)).toEqual(rules);
	});

	it("leaves narrow rules alone, matching the gate's decision-time behavior", () => {
		expect(
			auditPermissionAllow([
				"Bash(git status)",
				"Bash(git log:*)",
				"Bash(npm run test:*)", // a named script is narrow
				"Bash(sh scripts/*)", // path-scoped, judged narrow by the gate
				"Read(~/notes/**)",
				"WebFetch(domain:example.com)",
			]),
		).toEqual([]);
	});
});

describe("persistAutoModeSetup / removeOneCodePermissionAllow", () => {
	let home: string;
	// Both writers persist to One Code's own file, never into ~/.claude.
	const settingsPath = () => join(home, ".onecode", "settings.json");

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cc-automode-setup-"));
		mkdirSync(join(home, ".onecode"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("writes wizard keys, preserves other settings and autoMode keys, drops stale lists", () => {
		writeFileSync(
			settingsPath(),
			JSON.stringify({
				model: "opus",
				autoMode: { classifierModel: "x/y", soft_deny: ["$defaults", "stale rule"] },
			}),
		);
		persistAutoModeSetup({ environment: ["**Organization**: Acme"], allow: ["$defaults", "Bash(x:*)"] }, home);
		const file = JSON.parse(readFileSync(settingsPath(), "utf-8"));
		expect(file.model).toBe("opus");
		expect(file.autoMode.classifierModel).toBe("x/y");
		expect(file.autoMode.environment).toEqual(["**Organization**: Acme"]);
		expect(file.autoMode.allow).toEqual(["$defaults", "Bash(x:*)"]);
		// A list the new draft does not propose is removed, not left stale.
		expect(file.autoMode.soft_deny).toBeUndefined();
		// And the loader round-trips it.
		const config = loadAutoModeConfig(home);
		expect(config.environment).toEqual(["**Organization**: Acme"]);
		expect(config.allow).toEqual(["Bash(x:*)"]);
	});

	it("throws on a malformed settings file rather than replacing it", () => {
		writeFileSync(settingsPath(), "{not json");
		expect(() => persistAutoModeSetup({ environment: ["x"] }, home)).toThrow();
		expect(readFileSync(settingsPath(), "utf-8")).toBe("{not json");
	});

	it("removes exactly the named allow entries and reports the count", () => {
		writeFileSync(
			settingsPath(),
			JSON.stringify({ permissions: { allow: ["Bash(git status)", "Bash(npx *)", "Bash(pnpm run *)"], deny: ["Bash(rm:*)"] } }),
		);
		expect(removeOneCodePermissionAllow(["Bash(npx *)", "Bash(pnpm run *)", "Bash(never there)"], home)).toBe(2);
		const file = JSON.parse(readFileSync(settingsPath(), "utf-8"));
		expect(file.permissions.allow).toEqual(["Bash(git status)"]);
		expect(file.permissions.deny).toEqual(["Bash(rm:*)"]);
	});

	it("is a no-op with nothing to remove", () => {
		expect(removeOneCodePermissionAllow(["Bash(x)"], home)).toBe(0);
	});
});
