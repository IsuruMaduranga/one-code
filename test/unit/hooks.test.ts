import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ccToolName, matcherApplies, toolMatchCandidates } from "../../extensions/hooks/matcher.ts";
import { loadPluginHooks } from "../../extensions/hooks/plugin-hooks.ts";
import { type FinishedRun, interpretHookResult, parseEnvelope } from "../../extensions/hooks/protocol.ts";
import { hookSettingsPaths, loadHookSettings, parseHooksBlock, resetHookSettingsCache } from "../../extensions/hooks/settings.ts";

const ok = (stdout: string): FinishedRun => ({ exitCode: 0, timedOut: false, stdout, stderr: "" });

describe("protocol: interpretHookResult", () => {
	it("exit 2 blocks with stderr as the reason", () => {
		const outcome = interpretHookResult("PreToolUse", {
			exitCode: 2,
			timedOut: false,
			stdout: "",
			stderr: "not on my watch\n",
		});
		expect(outcome.block).toEqual({ reason: "not on my watch" });
	});

	it("other non-zero exits fail open", () => {
		expect(interpretHookResult("PreToolUse", { exitCode: 1, timedOut: false, stdout: "", stderr: "boom" })).toEqual({});
	});

	it("timeout fails closed for PreToolUse and UserPromptSubmit, open elsewhere", () => {
		const timedOut: FinishedRun = { exitCode: null, timedOut: true, stdout: "", stderr: "" };
		expect(interpretHookResult("PreToolUse", timedOut).block).toBeDefined();
		expect(interpretHookResult("UserPromptSubmit", timedOut).block).toBeDefined();
		expect(interpretHookResult("PostToolUse", timedOut)).toEqual({});
		expect(interpretHookResult("Stop", timedOut)).toEqual({});
	});

	it("a spawn failure fails open everywhere", () => {
		const failed: FinishedRun = { exitCode: null, timedOut: false, spawnError: "ENOENT", stdout: "", stderr: "" };
		expect(interpretHookResult("PreToolUse", failed)).toEqual({});
	});

	it("permissionDecision deny and ask both block; allow does nothing", () => {
		const deny = ok(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" } }));
		expect(interpretHookResult("PreToolUse", deny).block).toEqual({ reason: "no" });
		const ask = ok(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } }));
		expect(interpretHookResult("PreToolUse", ask).block?.reason).toContain("confirmation");
		const allow = ok(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }));
		expect(interpretHookResult("PreToolUse", allow)).toEqual({});
	});

	it("supports the legacy decision field and continue:false", () => {
		expect(interpretHookResult("Stop", ok(JSON.stringify({ decision: "block", reason: "keep going" }))).block).toEqual({
			reason: "keep going",
		});
		expect(interpretHookResult("Stop", ok(JSON.stringify({ continue: false, stopReason: "halt" }))).block).toEqual({
			reason: "halt",
		});
	});

	it("passes through updatedInput, additionalContext, and systemMessage", () => {
		const outcome = interpretHookResult(
			"PreToolUse",
			ok(
				JSON.stringify({
					systemMessage: "heads up",
					hookSpecificOutput: { updatedInput: { command: "ls" }, additionalContext: "ctx" },
				}),
			),
		);
		expect(outcome.updatedInput).toEqual({ command: "ls" });
		expect(outcome.additionalContext).toBe("ctx");
		expect(outcome.systemMessage).toBe("heads up");
	});

	it("treats plain stdout as context only for UserPromptSubmit and SessionStart", () => {
		expect(interpretHookResult("UserPromptSubmit", ok("remember the milk")).additionalContext).toBe("remember the milk");
		expect(interpretHookResult("SessionStart", ok("branch notes")).additionalContext).toBe("branch notes");
		expect(interpretHookResult("PreToolUse", ok("chatter"))).toEqual({});
	});

	it("parseEnvelope tolerates non-JSON and non-object stdout", () => {
		expect(parseEnvelope("not json")).toBeUndefined();
		expect(parseEnvelope("[1,2]")).toBeUndefined();
		expect(parseEnvelope('{"continue":false}')).toEqual({ continue: false });
	});
});

describe("matcher", () => {
	it("maps native names to canonical CC names", () => {
		expect(ccToolName("find")).toBe("Glob");
		expect(ccToolName("subagent")).toBe("Task");
		expect(ccToolName("mcp__srv__do")).toBe("mcp__srv__do");
		expect(ccToolName("some_custom")).toBe("some_custom");
	});

	it("matches CC spellings against One Code tools", () => {
		expect(matcherApplies("Bash", toolMatchCandidates("bash"))).toBe(true);
		expect(matcherApplies("Edit|Write", toolMatchCandidates("write"))).toBe(true);
		expect(matcherApplies("Glob", toolMatchCandidates("find"))).toBe(true);
		expect(matcherApplies("Task", toolMatchCandidates("subagent"))).toBe(true);
		expect(matcherApplies("TaskCreate", toolMatchCandidates("task_create"))).toBe(true);
		expect(matcherApplies("Bash", toolMatchCandidates("write"))).toBe(false);
	});

	it("anchors the regex — a substring is not a match", () => {
		expect(matcherApplies("Bas", toolMatchCandidates("bash"))).toBe(false);
		expect(matcherApplies("mcp__srv__.*", toolMatchCandidates("mcp__srv__do"))).toBe(true);
	});

	it("wildcards and invalid regexes behave", () => {
		expect(matcherApplies(undefined, toolMatchCandidates("bash"))).toBe(true);
		expect(matcherApplies("*", toolMatchCandidates("bash"))).toBe(true);
		expect(matcherApplies("(unclosed", toolMatchCandidates("(unclosed"))).toBe(true);
		expect(matcherApplies("(unclosed", toolMatchCandidates("bash"))).toBe(false);
	});
});

describe("settings", () => {
	let root: string;
	let claudeDir: string;
	let cwd: string;

	beforeEach(() => {
		resetHookSettingsCache();
		root = mkdtempSync(join(tmpdir(), "cc-hooks-settings-"));
		claudeDir = join(root, "home", ".claude");
		cwd = join(root, "project");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(join(cwd, ".claude"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const hooksJson = (command: string) => ({
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
	});

	it("loads user, project, and local scopes in order", () => {
		writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(hooksJson("user-hook")));
		writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(hooksJson("project-hook")));
		writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify(hooksJson("local-hook")));
		const loaded = loadHookSettings(claudeDir, cwd);
		expect(loaded.sources.map((s) => s.scope)).toEqual(["user", "project", "local"]);
		expect(loaded.diagnostics).toEqual([]);
	});

	it("skips malformed files and unsupported hook types with diagnostics", () => {
		writeFileSync(join(claudeDir, "settings.json"), "{ broken");
		writeFileSync(
			join(cwd, ".claude", "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [{ matcher: "*", hooks: [{ type: "prompt", prompt: "judge this" }] }],
					Sparkle: [{ hooks: [{ type: "command", command: "x" }] }],
				},
			}),
		);
		const loaded = loadHookSettings(claudeDir, cwd);
		expect(loaded.sources).toEqual([]);
		expect(loaded.diagnostics.join("\n")).toContain("unreadable");
		expect(loaded.diagnostics.join("\n")).toContain('type "prompt"');
		expect(loaded.diagnostics.join("\n")).toContain('unsupported hook event "Sparkle"');
	});

	it("re-reads a file only when its mtime changes", () => {
		const path = join(claudeDir, "settings.json");
		writeFileSync(path, JSON.stringify(hooksJson("v1")));
		utimesSync(path, new Date(1000000), new Date(1000000));
		expect(loadHookSettings(claudeDir, cwd).sources[0]?.config.PreToolUse?.[0]?.hooks[0]?.command).toBe("v1");
		writeFileSync(path, JSON.stringify(hooksJson("v2")));
		utimesSync(path, new Date(2000000), new Date(2000000));
		expect(loadHookSettings(claudeDir, cwd).sources[0]?.config.PreToolUse?.[0]?.hooks[0]?.command).toBe("v2");
	});

	it("parseHooksBlock keeps timeout only when positive", () => {
		const diags: string[] = [];
		const config = parseHooksBlock(
			{ PreToolUse: [{ hooks: [{ type: "command", command: "x", timeout: -5 }] }] },
			"t",
			diags,
		);
		expect(config.PreToolUse?.[0]?.hooks[0]?.timeout).toBeUndefined();
	});

	it("names all four candidate paths", () => {
		const paths = hookSettingsPaths("/h/.claude", "/p");
		expect(paths.map((p) => p.scope)).toEqual(["user", "managed", "project", "local"]);
	});
});

describe("plugin hooks", () => {
	let root: string;
	let claudeDir: string;
	let installPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cc-hooks-plugins-"));
		claudeDir = join(root, ".claude");
		installPath = join(claudeDir, "plugins", "cache", "market", "demo", "1.0.0");
		mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
		mkdirSync(join(installPath, "hooks"), { recursive: true });
		writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }));
		mkdirSync(join(claudeDir, "plugins"), { recursive: true });
		writeFileSync(
			join(claudeDir, "plugins", "installed_plugins.json"),
			JSON.stringify({ version: 2, plugins: { "demo@market": [{ scope: "user", installPath, version: "1.0.0" }] } }),
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const pluginRoots = () => ({
		claudePluginsDir: join(claudeDir, "plugins"),
		oneCodeRoot: join(root, "one-code-plugins"),
		cwd: root,
		home: root,
	});

	it("reads hooks.json and expands CLAUDE_PLUGIN_ROOT", () => {
		writeFileSync(
			join(installPath, "hooks", "hooks.json"),
			JSON.stringify({
				hooks: {
					PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/lint.sh" }] }],
				},
			}),
		);
		const diags: string[] = [];
		const sources = loadPluginHooks(pluginRoots(), diags);
		expect(sources).toHaveLength(1);
		expect(sources[0]).toMatchObject({ scope: "plugin", pluginName: "demo" });
		expect(sources[0].config.PostToolUse?.[0]?.hooks[0]?.command).toBe(`${installPath}/bin/lint.sh`);
		expect(diags).toEqual([]);
	});

	it("accepts a bare top-level events map too", () => {
		writeFileSync(
			join(installPath, "hooks", "hooks.json"),
			JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "check" }] }] }),
		);
		expect(loadPluginHooks(pluginRoots(), []).at(0)?.config.PreToolUse).toBeDefined();
	});

	it("caches by mtime: same mtime serves the cached parse, a bump re-reads", () => {
		const hooksPath = join(installPath, "hooks", "hooks.json");
		const config = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } });
		writeFileSync(hooksPath, config("first"));
		const t = new Date("2026-01-01T00:00:00Z");
		utimesSync(hooksPath, t, t);
		expect(loadPluginHooks(pluginRoots(), []).at(0)?.config.PreToolUse?.[0]?.hooks[0]?.command).toBe("first");

		// Rewrite with the mtime pinned back: the cache must still serve the old parse.
		writeFileSync(hooksPath, config("second"));
		utimesSync(hooksPath, t, t);
		expect(loadPluginHooks(pluginRoots(), []).at(0)?.config.PreToolUse?.[0]?.hooks[0]?.command).toBe("first");

		// A real mtime bump invalidates.
		const later = new Date("2026-01-01T00:00:01Z");
		utimesSync(hooksPath, later, later);
		expect(loadPluginHooks(pluginRoots(), []).at(0)?.config.PreToolUse?.[0]?.hooks[0]?.command).toBe("second");
	});
});
