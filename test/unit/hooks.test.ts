import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { ccToolName, matcherApplies, toolMatchCandidates, ccToolInput, nativeToolInput } from "../../extensions/lib/rules/hook-matcher.ts";
import { loadPluginHooks } from "../../extensions/safety/hooks/plugin-hooks.ts";
import { applyPostToolUseOutcome, type FinishedRun, interpretHookResult, parseEnvelope } from "../../extensions/lib/rules/hook-protocol.ts";
import { hookSettingsPaths, loadHookSettings, parseHooksBlock, resetHookSettingsCache } from "../../extensions/safety/hooks/settings.ts";

const ok = (stdout: string): FinishedRun => ({ exitCode: 0, timedOut: false, stdout, stderr: "" });

describe("protocol: applyPostToolUseOutcome", () => {
	const own = [{ type: "text", text: "tool output" }];
	const reminderTail = [
		{ type: "text", text: "tool output" },
		{ type: "text", text: "<system-reminder>\nPreToolUse hook additional context: note\n</system-reminder>" },
		{ type: "text", text: "<total_tokens>14000000 tokens left</total_tokens>" },
	];

	it("returns undefined when a hook changed nothing", () => {
		expect(applyPostToolUseOutcome(own, {}, "bash")).toBeUndefined();
	});

	it("a replacement preserves the appended reminder/countdown blocks (review M3)", () => {
		const result = applyPostToolUseOutcome(reminderTail, { updatedToolResult: "hi (formatted)" }, "bash");
		expect(result).toEqual([
			{ type: "text", text: "hi (formatted)" },
			{ type: "text", text: "<system-reminder>\nPreToolUse hook additional context: note\n</system-reminder>" },
			{ type: "text", text: "<total_tokens>14000000 tokens left</total_tokens>" },
		]);
	});

	it("a replacement with no reminder tail just replaces", () => {
		expect(applyPostToolUseOutcome(own, { updatedToolResult: "x" }, "bash")).toEqual([{ type: "text", text: "x" }]);
	});
});

describe("protocol: interpretHookResult", () => {
	it("exit 2 blocks with stderr as the reason", () => {
		const outcome = interpretHookResult("PreToolUse", {
			exitCode: 2,
			timedOut: false,
			stdout: "",
			stderr: "not on my watch\n",
		});
		expect(outcome.block).toEqual({ kind: "stated", reason: "not on my watch" });
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

	it("a timeout that reports 128+SIGKILL is still a timeout", () => {
		// The executor normalizes a timed-out run's exit code to null, so this
		// shape should not arrive from it any more — but this is a pure function
		// with other callers (the child hook bridge, tests, a future executor), and
		// a timeout must never be detected by `exitCode === null` alone: 137 is
		// otherwise an ordinary non-zero exit, which fails OPEN. Kept as the
		// contract, not as a description of what the executor emits.
		const killedLate: FinishedRun = { exitCode: 137, timedOut: true, stdout: "", stderr: "" };
		expect(interpretHookResult("PreToolUse", killedLate).block).toBeDefined();
		expect(interpretHookResult("UserPromptSubmit", killedLate).block).toBeDefined();
		expect(interpretHookResult("PostToolUse", killedLate)).toEqual({});
	});

	it("a spawn failure fails open everywhere", () => {
		const failed: FinishedRun = { exitCode: null, timedOut: false, spawnError: "ENOENT", stdout: "", stderr: "" };
		expect(interpretHookResult("PreToolUse", failed)).toEqual({});
	});

	it("permissionDecision deny and ask both block; allow does nothing", () => {
		const deny = ok(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" } }));
		expect(interpretHookResult("PreToolUse", deny).block).toEqual({ kind: "stated", reason: "no" });
		const ask = ok(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } }));
		expect(interpretHookResult("PreToolUse", ask).block).toEqual({ kind: "askRequested" });
		const allow = ok(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }));
		expect(interpretHookResult("PreToolUse", allow)).toEqual({});
	});

	it("supports the legacy decision field and continue:false", () => {
		expect(interpretHookResult("Stop", ok(JSON.stringify({ decision: "block", reason: "keep going" }))).block).toEqual({
			kind: "stated",
			reason: "keep going",
		});
		expect(interpretHookResult("Stop", ok(JSON.stringify({ continue: false, stopReason: "halt" }))).block).toEqual({
			kind: "stated",
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

	it("treats plain stdout as context for UserPromptSubmit and SessionStart, not PreToolUse", () => {
		expect(interpretHookResult("UserPromptSubmit", ok("remember the milk")).additionalContext).toBe("remember the milk");
		expect(interpretHookResult("SessionStart", ok("branch notes")).additionalContext).toBe("branch notes");
		expect(interpretHookResult("PreToolUse", ok("chatter"))).toEqual({});
	});

	it("preserves successful PreCompact stdout as summarization instructions", () => {
		expect(interpretHookResult("PreCompact", ok("  Preserve the database migration rollback steps.\n"))).toEqual({
			additionalContext: "Preserve the database migration rollback steps.",
		});
		expect(interpretHookResult("PreCompact", { ...ok("do not use this failed output"), exitCode: 1 })).toEqual({});
		expect(interpretHookResult("PreCompact", { ...ok("do not use this blocked output"), exitCode: 2, stderr: "wait for the backup" })).toEqual({
			block: { kind: "stated", reason: "wait for the backup" },
		});
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
		vi.stubEnv(envName("STATE_DIR"), join(root, "state"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	/** The settings files hooks are read from for the profile in force, managed policy aside, in collection order. */
	const writable = () => hookSettingsPaths(cwd, join(claudeDir, "..")).filter((path) => path.scope !== "managed").map((path) => path.path);
	const write = (path: string, text: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};

	const hooksJson = (command: string) => ({
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
	});

	it("skips malformed files and unsupported hook types with diagnostics", () => {
		const [first, second] = writable();
		write(first, "{ broken");
		write(
			second,
			JSON.stringify({
				hooks: {
					PreToolUse: [{ matcher: "*", hooks: [{ type: "prompt", prompt: "judge this" }] }],
					Sparkle: [{ hooks: [{ type: "command", command: "x" }] }],
				},
			}),
		);
		const loaded = loadHookSettings(cwd, join(claudeDir, ".."));
		expect(loaded.sources).toEqual([]);
		expect(loaded.diagnostics.join("\n")).toContain("unreadable");
		expect(loaded.diagnostics.join("\n")).toContain('type "prompt"');
		expect(loaded.diagnostics.join("\n")).toContain('unsupported hook event "Sparkle"');
	});

	it("re-reads a file only when its mtime changes", () => {
		const [path] = writable();
		write(path, JSON.stringify(hooksJson("v1")));
		utimesSync(path, new Date(1000000), new Date(1000000));
		expect(loadHookSettings(cwd, join(claudeDir, "..")).sources[0]?.config.PreToolUse?.[0]?.hooks[0]?.command).toBe("v1");
		writeFileSync(path, JSON.stringify(hooksJson("v2")));
		utimesSync(path, new Date(2000000), new Date(2000000));
		expect(loadHookSettings(cwd, join(claudeDir, "..")).sources[0]?.config.PreToolUse?.[0]?.hooks[0]?.command).toBe("v2");
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
		productRoot: join(root, "one-code-plugins"),
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

describe("hook tool_input translation (T4)", () => {
	it("spells pi inputs with Claude Code's parameter names and round-trips updatedInput", () => {
		expect(ccToolInput("edit", { path: "a.ts", oldText: "x", newText: "y" })).toEqual({
			file_path: "a.ts",
			old_string: "x",
			new_string: "y",
		});
		expect(ccToolInput("read", { path: "a.ts", offset: 2, limit: 5 })).toEqual({ file_path: "a.ts", offset: 2, limit: 5 });
		expect(ccToolInput("grep", { pattern: "x", ignoreCase: true, limit: 3 })).toEqual({ pattern: "x", "-i": true, head_limit: 3 });
		expect(ccToolInput("bash", { command: "ls", timeout: 5 })).toEqual({ command: "ls", timeout: 5 });
		expect(nativeToolInput("edit", { file_path: "b.ts", new_string: "z" })).toEqual({ path: "b.ts", newText: "z" });
		expect(nativeToolInput("mcp__x__y", { q: 1 })).toEqual({ q: 1 });
	});
});

