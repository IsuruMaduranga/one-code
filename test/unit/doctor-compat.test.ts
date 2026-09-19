import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectCompat, importedConfigSection, mcpSection } from "../../extensions/doctor/compat.ts";
import { checkDependencies, projectLanguages, providerHasNativeSearch, webSearchRoute } from "../../extensions/doctor/dependencies.ts";
import { whichOnPath } from "../../extensions/lib/which.ts";
import { invalidatePluginsCache } from "../../extensions/lib/plugins.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";

let home: string;
let cwd: string;
const write = (path: string, data: unknown) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "onecode-doctor-compat-home-"));
	cwd = mkdtempSync(join(tmpdir(), "onecode-doctor-compat-cwd-"));
	invalidatePluginsCache();
	resetHookSettingsCache();
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

const input = () => ({ cwd, home, agentDir: join(home, ".onecode", "agent"), env: { HOME: home, PATH: "" } as NodeJS.ProcessEnv });

describe("collectCompat: settings files", () => {
	it("reports what each Claude Code file contributes and which keys One Code leaves alone", () => {
		write(join(home, ".claude", "settings.json"), {
			permissions: { allow: ["Bash(git status)"], deny: ["Read(.env)"], defaultMode: "plan" },
			hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "npx prettier" }] }] },
			env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", FOO: "1" },
			enabledPlugins: { "a@b": true },
			model: "opus",
			statusLine: { type: "command", command: "echo" },
		});
		write(join(cwd, ".claude", "settings.json"), { permissions: { allow: ["Bash(npm test)"], defaultMode: "auto" }, autoMode: { allow: ["x"] } });
		const compat = collectCompat(input());
		const user = compat.files.find((f) => f.scope === "claude-user")!;
		expect(user.used).toEqual([
			"permissions: 1 allow, 1 deny, 0 ask; defaultMode plan",
			"hooks: PostToolUse ×1",
			"enabledPlugins: 1",
			'env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet"',
		]);
		expect(user.ignored).toEqual(["env (1 variable — One Code does not export settings env blocks)", "model", "statusLine"]);
		const project = compat.files.find((f) => f.scope === "claude-project")!;
		expect(project.used).toEqual(["permissions: 1 allow, 0 deny, 0 ask; allow rules apply after a once-per-config consent"]);
		expect(project.refused).toEqual([
			'permissions.defaultMode "auto" — a repository\'s files may not select it',
			"autoMode (allow) — never read from a repository's files",
		]);
		const texts = compat.findings.map((f) => f.text);
		expect(texts.some((t) => t.includes('sets permissions.defaultMode "auto"'))).toBe(true);
		expect(texts.some((t) => t.includes("has an autoMode block"))).toBe(true);
		const section = importedConfigSection(compat, home);
		expect(section.lines.some((l) => l.text.startsWith("Claude Code user settings ~/.claude/settings.json: permissions"))).toBe(true);
		expect(section.lines.some((l) => l.text === "not used by One Code: env (1 variable — One Code does not export settings env blocks), model, statusLine")).toBe(true);
	});

	it("flags invalid JSON as an error and One Code keys left in the Claude Code user file", () => {
		write(join(home, ".claude", "settings.json"), '{ "permissions": { "allow": [ ] }, }');
		write(join(home, ".onecode", "settings.json"), { permissions: { defaultMode: "plan" }, subagentModel: "inherit", webSearch: { apiKeys: { brave: "k" } } });
		const compat = collectCompat(input());
		expect(compat.files.find((f) => f.scope === "claude-user")).toMatchObject({ exists: true, valid: false });
		expect(compat.findings.find((f) => f.level === "error")?.text).toContain("is not valid JSON");
		const onecode = compat.files.find((f) => f.scope === "onecode-user")!;
		expect(onecode.refused[0]).toContain('permissions.defaultMode "plan" — never read from One Code\'s own files');
		expect(onecode.used).toEqual(['subagentModel "inherit"', "webSearch (keys/order for the search fallback)"]);
	});

	it("warns about stale One Code keys in ~/.claude/settings.json", () => {
		write(join(home, ".claude", "settings.json"), { subagentModel: "sonnet", autoMode: { classifierModel: "anthropic/claude-haiku-4-5", environment: ["x"] } });
		const compat = collectCompat(input());
		const user = compat.files.find((f) => f.scope === "claude-user")!;
		expect(user.refused).toEqual([
			"autoMode.classifierModel — One Code's own key, read from ~/.onecode/settings.json only",
			"subagentModel — One Code's own key, read from ~/.onecode/settings.json only",
		]);
		expect(user.used).toEqual(["autoMode: environment"]);
		expect(compat.findings.filter((f) => f.text.includes("now read only from ~/.onecode/settings.json"))).toHaveLength(2);
	});
});

describe("collectCompat: content", () => {
	it("sizes the instruction files and warns over the 40k soft limit", () => {
		write(join(cwd, "CLAUDE.md"), "x".repeat(41_000));
		write(join(cwd, "sub", "AGENTS.md"), "agents");
		const compat = collectCompat({ ...input(), cwd: join(cwd, "sub") });
		expect(compat.contextFiles.map((f) => [f.path.endsWith("CLAUDE.md") ? "CLAUDE.md" : "AGENTS.md", f.overLimit])).toEqual([
			["CLAUDE.md", true],
			["AGENTS.md", false],
		]);
		expect(compat.findings.some((f) => f.text.includes("over the 40.0k-char limit"))).toBe(true);
	});

	it("counts agents, skills and command templates, and flags a skill without a description", () => {
		write(join(home, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\n---\nBody");
		write(join(cwd, ".claude", "agents", "empty.md"), "---\nname: empty\n---\n");
		write(join(cwd, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\nHow to deploy");
		write(join(cwd, ".claude", "skills", "ok", "SKILL.md"), "---\nname: ok\ndescription: fine\n---\nBody");
		write(join(cwd, ".claude", "commands", "ship.md"), "ship it");
		const compat = collectCompat(input());
		expect(compat.agents).toMatchObject({ user: 1, project: 0, plugin: 0 });
		expect(compat.agents.failed).toHaveLength(1);
		expect(compat.skills).toMatchObject({ project: 2, user: 0, plugin: 0 });
		expect(compat.skills.bundled).toBeGreaterThan(0);
		expect(compat.skills.noDescription[0]).toContain("deploy");
		expect(compat.commands).toBe(1);
		expect(compat.findings.some((f) => f.text.includes("has no description in its frontmatter"))).toBe(true);
		expect(compat.findings.some((f) => f.text.includes("has no body and is skipped"))).toBe(true);
	});

	it("loads MCP servers from .mcp.json and reports missing env vars and config errors", () => {
		write(join(cwd, ".mcp.json"), { mcpServers: { docs: { type: "http", url: "https://x/${DOCS_TOKEN}" }, local: { command: "my-mcp", args: [] } } });
		write(join(home, ".claude.json"), "not json");
		const compat = collectCompat(input());
		expect(compat.mcp.servers.map((s) => s.name)).toEqual(["docs", "local"]);
		expect(compat.findings.some((f) => f.text.includes("unset environment variable DOCS_TOKEN"))).toBe(true);
		expect(compat.mcp.configErrors[0]).toContain("~/.claude.json");
		const section = mcpSection(compat, undefined, home);
		expect(section.lines.some((l) => l.text.startsWith("docs — http: https://x/") && l.text.includes("missing DOCS_TOKEN"))).toBe(true);
		const liveSection = mcpSection(compat, { modelSource: "none", mcp: { settled: true, servers: [{ name: "local", status: "connected", toolCount: 4 }] } }, home);
		expect(liveSection.lines.some((l) => l.text.includes("local — stdio: my-mcp · connected · 4 tools"))).toBe(true);
	});
});

describe("dependencies", () => {
	it("finds executables on PATH and detects the project's languages by root markers", () => {
		const bin = join(home, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "gopls"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(bin, "notexec"), "");
		expect(whichOnPath("gopls", { PATH: bin }, "darwin")).toBe(join(bin, "gopls"));
		// Windows has no execute bit: a plain file is "executable" there, so the check is POSIX-only.
		if (process.platform !== "win32") expect(whichOnPath("notexec", { PATH: bin }, "darwin")).toBeUndefined();
		expect(whichOnPath("git", { PATH: bin }, "darwin")).toBeUndefined();
		writeFileSync(join(cwd, "go.mod"), "module x");
		writeFileSync(join(cwd, "pyproject.toml"), "");
		expect(projectLanguages(cwd).sort()).toEqual(["go", "python"]);

		const report = checkDependencies({ cwd, env: { PATH: bin }, platform: "darwin", mcpServers: [{ kind: "stdio", name: "srv", command: "my-mcp", args: [], source: "x" }], webSearchSettings: {} });
		const gopls = report.checks.find((c) => c.name === "gopls")!;
		expect(gopls).toMatchObject({ found: true, need: "project" });
		const pyright = report.checks.find((c) => c.name === "pyright-langserver")!;
		expect(pyright).toMatchObject({ found: false, need: "project" });
		expect(report.findings.some((f) => f.text.includes("pyright-langserver is not installed") && f.fix?.includes("npm install -g pyright"))).toBe(true);
		expect(report.findings.some((f) => f.text.includes('MCP server "srv" runs "my-mcp"'))).toBe(true);
		expect(report.findings.some((f) => f.text.startsWith("git is not on PATH"))).toBe(true);
		expect(report.checks.find((c) => c.name === "typescript-language-server")).toMatchObject({ need: "unused" });
	});

	it("names the web-search route", () => {
		const anthropic = { provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages" } as any;
		expect(providerHasNativeSearch(anthropic)).toBe(true);
		expect(webSearchRoute({ env: {}, sessionModel: anthropic, webSearchSettings: {} }).route).toBe("provider-native");
		const groq = { provider: "groq", id: "llama", api: "openai-completions" } as any;
		expect(webSearchRoute({ env: {}, sessionModel: groq, webSearchSettings: {} }).route).toBe("exa-free");
		expect(webSearchRoute({ env: { TAVILY_API_KEY: "t" }, sessionModel: groq, webSearchSettings: {} }).route).toBe("tavily");
		expect(webSearchRoute({ env: {}, sessionModel: groq, webSearchSettings: { apiKeys: { brave: "b" } } }).detail).toContain("key in ~/.onecode/settings.json");
	});
});

describe("checkDependencies: the shell tools (Shells entry, 2026-09-19)", () => {
	const base = { cwd: process.cwd(), env: { PATH: "" }, mcpServers: [], webSearchSettings: { apiKeys: {} } as any };
	it("Windows with PowerShell only: bash optional and missing with the Git hint, PowerShell primary", () => {
		const r = checkDependencies({ ...base, platform: "win32", shells: { powershell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", powershellActive: true, primary: "powershell", notices: [] } });
		const bash = r.checks.find((c) => c.name === "bash")!;
		const ps = r.checks.find((c) => c.name === "powershell")!;
		expect(bash.found).toBe(false);
		expect(bash.need).toBe("optional");
		expect(bash.hint).toContain("git-scm.com");
		expect(ps.found).toBe(true);
		expect(ps.reason).toBe("the primary shell tool");
		expect(r.findings.some((f) => /bash|shell/i.test(f.text))).toBe(false);
	});
	it("Windows with neither shell: the no-shell notice is an error finding", () => {
		const r = checkDependencies({ ...base, platform: "win32", shells: { powershellActive: false, primary: "none", notices: ["No shell available: install Git for Windows …"] } });
		expect(r.findings.some((f) => f.level === "error" && f.text.startsWith("No shell available"))).toBe(true);
	});
	it("macOS: bash required and primary, PowerShell unused unless switched on; an ignored override is a warning", () => {
		const r = checkDependencies({ ...base, platform: "darwin", shells: { bash: "/bin/bash", bashWarning: 'CLAUDE_CODE_GIT_BASH_PATH ignored: "/x" does not exist.', powershellActive: false, primary: "bash", notices: [] } });
		expect(r.checks.find((c) => c.name === "bash")!.need).toBe("required");
		expect(r.checks.find((c) => c.name === "powershell")!.need).toBe("unused");
		expect(r.findings.some((f) => f.level === "warn" && f.text.includes("CLAUDE_CODE_GIT_BASH_PATH ignored"))).toBe(true);
	});
	it("without a shells input the report is unchanged", () => {
		const r = checkDependencies({ ...base, platform: "darwin" });
		expect(r.checks.some((c) => c.name === "bash" || c.name === "powershell")).toBe(false);
	});
});
