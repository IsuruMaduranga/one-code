/**
 * The shell sandbox (lib/shell-run/sandbox.ts, sandbox-settings.ts,
 * safety/sandbox/section.ts): which settings a repository may set, which
 * calls run inside it, and how the gate treats a call that asks to leave it.
 * The runtime itself is not started here; the live checks are in
 * working-docs/features/sandbox/.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productSettingsPath } from "../../extensions/lib/profile/product-settings.ts";
import { isRepoFile, settingsSources } from "../../extensions/lib/profile/settings-files.ts";
import { Type } from "typebox";
import { decide, parseRules, ruleMatches } from "../../extensions/lib/rules/matcher.ts";
import { type ActiveSandbox, grantCommandHosts, reloadSandboxSettings, requestedHosts, runsSandboxed, sandboxedCommand, sandboxGateFacts, sandboxSettings, setSandboxForTest, unsandboxedRequest, useSandboxSettingsFor } from "../../extensions/lib/shell-run/sandbox.ts";
import { bareRepositoryFiles, checkoutProtectedFiles, DIRECTORY_STUB_CHILD, linkedWorktreeGitDirs, pathExists, readGitPointer } from "../../extensions/lib/shell-run/sandbox-settings.ts";
import { denialInputKey } from "../../extensions/safety/permissions/auto-mode/denials.ts";
import { commandHosts, denyRulePaths, expandDenyGlobs, isExcludedCommand, loadSandboxSettings, looksLikeBareRepository, mergeSandboxBlock, plantableCommondirs, resolvedSpelling, type RuleDenyPath, ruleDenyPaths, SANDBOX_OFF, type SandboxSettings, sandboxCommandFilesystem, sandboxFilesystem, sandboxRuntimeConfig, shadowedAllowRead } from "../../extensions/lib/shell-run/sandbox-settings.ts";
import { createEndChecks } from "../../extensions/lib/shell-run/sandbox-end-checks.ts";
import { registerShellTool } from "../../extensions/lib/shell-run/shell-tool.ts";
import { powerShellBashLine } from "../../extensions/lib/shell-run/shell-spawn.ts";
import { sandboxProbeFailure, usernsRestricted } from "../../extensions/lib/shell-run/sandbox-probe.ts";
import { checkDependencies } from "../../extensions/commands/doctor/dependencies.ts";
import { applySandboxPanelKey, applySandboxPick, openSandboxPanel, renderSandboxPanel, sandboxModeOf, sandboxPickOutcome } from "../../extensions/safety/sandbox/panel.ts";
import { GATE_PROMPT_REQUEST_CHANNEL, type GatePromptRequest, requestGatePrompt } from "../../extensions/lib/consent/gate-prompt.ts";
import { createHostGate, type HostAnswer } from "../../extensions/safety/sandbox/hosts.ts";
import { sandboxSectionText, sandboxStatusLines } from "../../extensions/safety/sandbox/section.ts";
import { renderTranscript, toolCallEntry } from "../../extensions/safety/permissions/auto-mode/transcript.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import backgroundExtension from "../../extensions/tools/background/index.ts";
import { backgroundWords } from "../../extensions/tools/background/text.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { DEFAULT_COALESCE_MS, escapeTaskText } from "../../extensions/lib/notify/notifications.ts";

const ON: SandboxSettings = { ...SANDBOX_OFF, enabled: true };
/** The user also turned auto-allow on. */
const AUTO: SandboxSettings = { ...ON, autoAllowBashIfSandboxed: true };
const text = {
	disableParam: "disable",
	allowedDomainsParam: "hosts",
	hostNotListed: "not listed",
	section: (p: object) => `section ${JSON.stringify(p)}`,
	turnedOff: "off",
	unavailable: (p: object) => `unavailable ${JSON.stringify(p)}`,
	refused: (p: object) => `refused ${JSON.stringify(p)}`,
};

/** A running sandbox that marks what it wraps and reports `violations` once per call. */
function fakeSandbox(settings: SandboxSettings, violations = ""): ActiveSandbox & { wrapped: Array<{ command: string; cwd: string; shell: string; id: string; text: string }>; hosts: Map<string, string[]>; open: { count: number } } {
	const wrapped: Array<{ command: string; cwd: string; shell: string; id: string; text: string }> = [];
	const hosts = new Map<string, string[]>();
	const open = { count: 0 };
	return {
		wrapped,
		hosts,
		open,
		ended: () => void open.count--,
		allowHosts: (id, list) => {
			if (list.some((host) => host.includes(" "))) throw new Error(`invalid host "${list.find((host) => host.includes(" "))}"`);
			hosts.set(id, [...list]);
		},
		release: (id) => void hosts.delete(id),
		wrap: async (command, call) => {
			wrapped.push({ command, ...call });
			open.count++;
			return `SANDBOX(${command})`;
		},
		annotate: () => violations,
		filesystem: (cwd) => sandboxFilesystem(settings, { cwd, writableDirs: ["/tmp/session"], protectedFiles: [`${cwd}/.claude/settings.json`] }),
	};
}

const request = { command: "npm test", original: "npm test", disable: false, cwd: "/work", bash: "/bin/bash", id: "call-1" };
const supported = process.platform === "darwin" || process.platform === "linux";

afterEach(() => setSandboxForTest(undefined));

describe("sandbox settings", () => {
	it("lets a repository's file tighten the sandbox and never widen it", () => {
		const block = {
			enabled: true,
			allowUnsandboxedCommands: false,
			failIfUnavailable: true,
			excludedCommands: ["docker *"],
			filesystem: { allowWrite: ["/etc"], denyWrite: ["secrets"], denyRead: ["~/.ssh"], allowRead: ["~/.ssh/config"] },
			network: { allowedDomains: ["evil.example"], deniedDomains: ["bad.example"], allowLocalBinding: true, allowUnixSockets: ["/var/run/docker.sock"] },
		};
		expect(mergeSandboxBlock(SANDBOX_OFF, block, true)).toEqual({
			...SANDBOX_OFF,
			enabled: true,
			allowUnsandboxedCommands: false,
			filesystem: { allowWrite: [], denyWrite: ["secrets"], denyRead: ["~/.ssh"], allowRead: [] },
			network: { ...SANDBOX_OFF.network, deniedDomains: ["bad.example"] },
		});
		// The user's own file takes all of it.
		expect(mergeSandboxBlock(SANDBOX_OFF, block, false)).toEqual({
			enabled: true,
			allowUnsandboxedCommands: false,
			failIfUnavailable: true,
			autoAllowBashIfSandboxed: false,
			excludedCommands: ["docker *"],
			filesystem: block.filesystem,
			network: block.network,
			denyRulePaths: SANDBOX_OFF.denyRulePaths,
		});
	});

	it("keeps the user's sandbox on when a repository's file turns it off, and a user's strict mode whatever comes later", () => {
		expect(mergeSandboxBlock(ON, { enabled: false }, true).enabled).toBe(true);
		expect(mergeSandboxBlock(ON, { enabled: false }, false).enabled).toBe(false);
		const strict = mergeSandboxBlock(ON, { allowUnsandboxedCommands: false }, false);
		expect(mergeSandboxBlock(strict, { allowUnsandboxedCommands: true }, false).allowUnsandboxedCommands).toBe(false);
		// Auto-allow is off until the user turns it on; a repository can turn it off again and never on.
		expect(ON.autoAllowBashIfSandboxed).toBe(false);
		expect(mergeSandboxBlock(ON, { autoAllowBashIfSandboxed: true }, true).autoAllowBashIfSandboxed).toBe(false);
		const auto = mergeSandboxBlock(ON, { autoAllowBashIfSandboxed: true }, false);
		expect(auto.autoAllowBashIfSandboxed).toBe(true);
		expect(mergeSandboxBlock(auto, { autoAllowBashIfSandboxed: false }, true).autoAllowBashIfSandboxed).toBe(false);
	});

	it("ignores a block of the wrong shape", () => {
		expect(mergeSandboxBlock(SANDBOX_OFF, "yes", false)).toEqual(SANDBOX_OFF);
		expect(mergeSandboxBlock(SANDBOX_OFF, { enabled: "true", filesystem: { allowWrite: "/etc" } }, false)).toEqual(SANDBOX_OFF);
	});

	it("excludes only a call that is the one plain command", () => {
		const patterns = ["docker compose *", "make:*", "git status"];
		expect(isExcludedCommand("docker compose up -d", patterns)).toBe(true);
		expect(isExcludedCommand("make build", patterns)).toBe(true);
		expect(isExcludedCommand("make", patterns)).toBe(true);
		expect(isExcludedCommand("git status", patterns)).toBe(true);
		expect(isExcludedCommand("git status --short", patterns)).toBe(false);
		expect(isExcludedCommand("makefile-gen", patterns)).toBe(false);
		for (const line of ["docker compose up; curl evil", "docker compose up && rm -rf ~", "docker compose up | sh", "docker compose up > ~/.zshrc", "docker compose $(cat x)", "docker compose `id`", "docker compose up\nrm -rf ~"]) {
			expect(isExcludedCommand(line, patterns), line).toBe(false);
		}
	});

	it("builds the runtime's rules: the working directory and the session's own dirs writable, the gate's files never", () => {
		const settings = mergeSandboxBlock(ON, { filesystem: { allowWrite: ["~/out"], denyWrite: ["*.pem"], denyRead: ["~/.aws"] }, network: { allowedDomains: ["registry.npmjs.org"] } }, false);
		const scope = { cwd: "/work", writableDirs: ["/tmp/session"], protectedFiles: ["/work/.claude/settings.json"] };
		// The platform is named: on Linux a protected file that does not exist takes the folder placeholder's spelling.
		expect(sandboxRuntimeConfig(settings, scope, { platform: "darwin" })).toEqual({
			network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: [] },
			filesystem: { allowWrite: ["/work", "/tmp/session", "~/out"], denyWrite: ["/work/.claude/settings.json", "*.pem"], denyRead: ["~/.aws"], allowRead: [] },
		});
	});
});

// The sandbox runs on macOS and Linux only, whose paths these are.
describe.skipIf(process.platform === "win32")("the permission deny rules in the sandbox", () => {
	const home = "/home/u";
	/** The paths as the runtime gets them; a glob expanded per command as `expand:<glob>`. */
	const shown = (paths: RuleDenyPath[]) => paths.map((path) => (path.kind === "path" ? path.path : path.kind === "literal" ? `literal:${path.path}` : `expand:${path.glob}`));
	const write = (pattern: string, platform: NodeJS.Platform = "darwin") => shown(ruleDenyPaths(pattern, "write", "/work", home, platform));
	const read = (pattern: string, platform: NodeJS.Platform = "darwin") => shown(ruleDenyPaths(pattern, "read", "/work", home, platform));

	it("takes the path patterns of the edit family's deny rules for writes and of Read's for reads", () => {
		const rules = parseRules(["Edit(a.txt)", "Write(b.txt)", "NotebookEdit(c.ipynb)", "Read(.env)", "Edit", "Bash(rm:*)", "Grep(secrets/**)", "Edit(a.txt)"]);
		expect(denyRulePaths(rules)).toEqual({ write: ["a.txt", "b.txt", "c.ipynb"], read: [".env"] });
	});

	it("makes every spelling of the rule syntax an absolute path", () => {
		expect(write("//etc/hosts")).toEqual(["/etc/hosts"]);
		expect(write("~/.zshrc")).toEqual([`${home}/.zshrc`]);
		expect(read("~")).toEqual([home]);
		expect(write("config/prod.yaml")).toEqual(["/work/config/prod.yaml"]);
		expect(write("./config/prod.yaml")).toEqual(["/work/config/prod.yaml"]);
		expect(write("../shared/env")).toEqual(["/shared/env"]);
		expect(write("config/")).toEqual(["/work/config"]);
		// The gate reads `/x` as the absolute path, Claude Code against the project: both are denied.
		expect(write("/config/prod.yaml")).toEqual(["/config/prod.yaml", "/work/config/prod.yaml"]);
	});

	it("keeps the spaces of a pattern, as the gate matches it", () => {
		const [trailing, leading] = parseRules(["Read(secret.txt )", "Edit( notes.md)"]);
		expect(denyRulePaths([trailing, leading])).toEqual({ write: [" notes.md"], read: ["secret.txt "] });
		expect(read("secret.txt ")).toEqual(["/work/secret.txt "]);
		expect(write(" notes.md")).toEqual(["/work/ notes.md"]);
		// The gate denies exactly the file with the space, which is what the sandbox gets.
		expect(ruleMatches(trailing, "read", "/work/secret.txt ", "/work")).toBe(true);
		expect(ruleMatches(trailing, "read", "/work/secret.txt", "/work")).toBe(false);
	});

	it("passes a glob where the runtime reads it as the gate does, and expands a Linux write glob per command", () => {
		expect(write("config/*.yaml")).toEqual(["/work/config/*.yaml"]);
		expect(read("~/.aws/**")).toEqual([`${home}/.aws/**`]);
		// Linux reads: the runtime expands the glob against the disk.
		expect(read("**/.env", "linux")).toEqual(["/work/**/.env"]);
		// Linux writes: bubblewrap binds real paths only and the runtime skips a write glob, so each command gets the matching files.
		expect(write("config/*.yaml", "linux")).toEqual(["expand:/work/config/*.yaml"]);
		expect(write("**/.env", "linux")).toEqual(["expand:/work/**/.env"]);
		// A trailing `/**` is the directory itself, which the runtime binds.
		expect(write("secrets/**", "linux")).toEqual(["/work/secrets/**"]);
	});

	describe("a glob expanded per command", () => {
		let root: string;
		const put = (...parts: string[]) => {
			mkdirSync(dirname(join(root, ...parts)), { recursive: true });
			writeFileSync(join(root, ...parts), "x");
		};
		afterEach(() => rmSync(root, { recursive: true, force: true }));
		const literal = (...parts: string[]) => ({ path: join(root, ...parts), literal: true });

		it("denies the files it matches when the command's rules are built, as the gate matches them, never the whole directory", () => {
			root = mkdtempSync(join(tmpdir(), "sandbox-glob-"));
			put(".env");
			put("app", "nested", ".env");
			put("app", "main.ts");
			put("[id]", "x.yaml");
			put("config", "a.yaml");
			put("config", "deep", "b.yaml");
			const found = expandDenyGlobs([join(root, "**", ".env"), join(root, "config", "*.yaml"), join(root, "*", "x.yaml")]);
			expect(found.get(join(root, "**", ".env"))).toEqual(expect.arrayContaining([literal(".env"), literal("app", "nested", ".env")]));
			expect(found.get(join(root, "**", ".env"))).toHaveLength(2);
			// `*` stays within one name: the walk does not go below the depth the glob reaches.
			expect(found.get(join(root, "config", "*.yaml"))).toEqual([literal("config", "a.yaml")]);
			// A matched name that holds glob syntax goes to the runtime as a literal path.
			expect(found.get(join(root, "*", "x.yaml"))).toEqual([literal("[id]", "x.yaml")]);
		});

		it("denies a directory that matches whole, and falls back to the directory the glob starts in when the walk runs out of budget", () => {
			root = mkdtempSync(join(tmpdir(), "sandbox-glob-"));
			put("a", "secrets", "key");
			put("b", "c", "d.txt");
			expect(expandDenyGlobs([join(root, "**", "secrets", "**")]).get(join(root, "**", "secrets", "**"))).toEqual([literal("a", "secrets")]);
			expect(expandDenyGlobs([join(root, "**", ".env")], 2).get(join(root, "**", ".env"))).toEqual([root]);
			expect(expandDenyGlobs([join(root, "missing", "**", ".env")]).get(join(root, "missing", "**", ".env"))).toEqual([]);
		});

		it("stays out of node_modules and .git, whose size alone would run past the budget, unless a glob names one", () => {
			root = mkdtempSync(join(tmpdir(), "sandbox-glob-"));
			put(".env");
			put("app", ".env");
			for (let index = 0; index < 30; index++) put("node_modules", `pkg${index}`, "index.js");
			for (let index = 0; index < 30; index++) put(".git", "objects", `o${index}`);
			put("node_modules", "pkg0", ".env");
			const glob = join(root, "**", ".env");
			// 4 entries outside the two folders, 2 for the folders themselves: well under a budget their contents would pass.
			expect(expandDenyGlobs([glob], 10).get(glob)).toEqual(expect.arrayContaining([literal(".env"), literal("app", ".env")]));
			expect(expandDenyGlobs([glob], 10).get(glob)).toHaveLength(2);
			const named = join(root, "node_modules", "**", ".env");
			expect(expandDenyGlobs([named]).get(named)).toEqual([literal("node_modules", "pkg0", ".env")]);
		});

		it("keeps the section's text the pattern while each command gets the files that exist as it starts", () => {
			root = mkdtempSync(join(tmpdir(), "sandbox-glob-"));
			put("app", ".env");
			const settings: SandboxSettings = { ...ON, denyRulePaths: { write: ["**/.env"], read: [] } };
			const scope = { cwd: root, writableDirs: [], protectedFiles: [] };
			const host = { home, platform: "linux" as const };
			const shownBefore = JSON.stringify(sandboxFilesystem(settings, scope, host));
			expect(sandboxFilesystem(settings, scope, host).denyWrite).toEqual([join(root, "**", ".env")]);
			expect(sandboxCommandFilesystem(settings, scope, host).denyWrite).toEqual([literal("app", ".env")]);
			expect(sandboxRuntimeConfig(settings, scope, host).filesystem.denyWrite).toEqual([literal("app", ".env")]);
			put("lib", ".env");
			expect(sandboxCommandFilesystem(settings, scope, host).denyWrite).toEqual(expect.arrayContaining([literal("app", ".env"), literal("lib", ".env")]));
			expect(JSON.stringify(sandboxFilesystem(settings, scope, host))).toBe(shownBefore);
			// The working directory itself stays writable.
			expect(sandboxCommandFilesystem(settings, scope, host).denyWrite).not.toContain(root);
		});

		it("hides the files a Linux read glob with a literal `?` matches as the gate reads it, not the working directory", () => {
			root = mkdtempSync(join(tmpdir(), "sandbox-glob-"));
			put("logs", "what?.txt");
			put("logs", "whatX.txt");
			const settings: SandboxSettings = { ...ON, denyRulePaths: { write: [], read: ["**/what?.txt"] } };
			const fs = sandboxCommandFilesystem(settings, { cwd: root, writableDirs: [], protectedFiles: [] }, { home, platform: "linux" });
			expect(fs.denyRead).toEqual([literal("logs", "what?.txt")]);
		});
	});

	it("marks an exact path literal where the runtime would read its characters as glob syntax, never widening it to its folder", () => {
		for (const platform of ["darwin", "linux"] as const) {
			expect(write("notes/a\\*b.txt", platform)).toEqual(["literal:/work/notes/a*b.txt"]);
			expect(write("app/[id]/page.tsx", platform)).toEqual(["literal:/work/app/[id]/page.tsx"]);
			expect(read("logs/what?.txt", platform)).toEqual(["literal:/work/logs/what?.txt"]);
			expect(read("secret[1].txt", platform)).toEqual(["literal:/work/secret[1].txt"]);
			expect(write("src/page.tsx", platform)).toEqual(["/work/src/page.tsx"]);
		}
		// The section shows the path itself; the runtime gets it marked literal.
		const settings: SandboxSettings = { ...ON, denyRulePaths: { write: ["app/[id]/page.tsx"], read: ["secret[1].txt"] } };
		const scope = { cwd: "/work", writableDirs: [], protectedFiles: [] };
		for (const platform of ["darwin", "linux"] as const) {
			expect(sandboxFilesystem(settings, scope, { home, platform })).toMatchObject({ denyWrite: ["/work/app/[id]/page.tsx"], denyRead: ["/work/secret[1].txt"] });
			expect(sandboxCommandFilesystem(settings, scope, { home, platform })).toMatchObject({ denyWrite: [{ path: "/work/app/[id]/page.tsx", literal: true }], denyRead: [{ path: "/work/secret[1].txt", literal: true }] });
		}
	});

	it("widens a glob that also holds such characters on macOS, and expands it on Linux, where a writable folder would be bound back over a hidden one", () => {
		expect(write("src/*/[id].tsx")).toEqual(["/work/src"]);
		expect(read("**/what?.txt")).toEqual(["/work"]);
		expect(write("src/*/[id].tsx", "linux")).toEqual(["expand:/work/src/*/[id].tsx"]);
		expect(read("**/what?.txt", "linux")).toEqual(["expand:/work/**/what?.txt"]);
	});

	it("leaves out an allowRead entry a Read deny rule's path covers, since the runtime would let it win, and keeps the others", () => {
		const allowRead = ["/work/secret.txt", "/work/keys/pub", "/work/a/secrets/x", "~/proj", "~/proj/*", "/work/docs", "/data/*", "/work/*"];
		const settings: SandboxSettings = { ...ON, filesystem: { ...ON.filesystem, allowRead }, denyRulePaths: { write: [], read: ["secret.txt", "keys/**", "**/secrets", "~/proj/.env"] } };
		for (const platform of ["darwin", "linux"] as const) {
			const host = { home, platform };
			expect(shadowedAllowRead(settings, "/work", host)).toEqual(["/work/secret.txt", "/work/keys/pub", "/work/a/secrets/x", "~/proj/*", "/work/*"]);
			const kept = ["~/proj", "/work/docs", "/data/*"];
			expect(sandboxFilesystem(settings, { cwd: "/work", writableDirs: [], protectedFiles: [] }, host).allowRead).toEqual(kept);
			expect(sandboxCommandFilesystem(settings, { cwd: "/work", writableDirs: [], protectedFiles: [] }, host).allowRead).toEqual(kept);
		}
		// Without Read deny rules every entry stays.
		expect(shadowedAllowRead({ ...settings, denyRulePaths: { write: ["secret.txt"], read: [] } }, "/work", { home })).toEqual([]);
	});

	it("leaves out an allowRead entry that names a denied file through a linked folder, as the runtime resolves it", () => {
		const root = mkdtempSync(join(tmpdir(), "sandbox-alias-"));
		try {
			mkdirSync(join(root, "data"));
			writeFileSync(join(root, "data", "notes.txt"), "n");
			writeFileSync(join(root, "other.txt"), "o");
			symlinkSync(join(root, "data"), join(root, "alias"));
			const allowRead = ["alias/notes.txt", "alias/*", "alias", "other.txt", "data/other.txt"];
			const ruled = (read: string[]): SandboxSettings => ({ ...ON, filesystem: { ...ON.filesystem, allowRead }, denyRulePaths: { write: [], read } });
			for (const platform of ["darwin", "linux"] as const) {
				const host = { home, platform };
				// The same file by either spelling; the folder allow only holds it and stays, as do unrelated files.
				expect(shadowedAllowRead(ruled(["data/notes.txt"]), root, host)).toEqual(["alias/notes.txt", "alias/*"]);
				expect(shadowedAllowRead(ruled(["alias/notes.txt"]), root, host)).toEqual(["alias/notes.txt", "alias/*"]);
				expect(shadowedAllowRead(ruled(["data/**"]), root, host)).toEqual(["alias/notes.txt", "alias/*", "data/other.txt"]);
			}
			expect(resolvedSpelling(join(root, "alias", "missing", "x"))).toBe(join(realpathSync(root), "data", "missing", "x"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("adds the rules' paths after the settings' own lists, once each, for the command's directory", () => {
		const settings: SandboxSettings = { ...ON, filesystem: { ...ON.filesystem, denyWrite: ["/work/config/prod.yaml"], denyRead: ["~/.aws"] }, denyRulePaths: { write: ["config/prod.yaml", "~/.zshrc"], read: ["~/.ssh/**"] } };
		const scope = { cwd: "/work", writableDirs: [], protectedFiles: ["/work/.claude/settings.json"] };
		expect(sandboxFilesystem(settings, scope, { home, platform: "darwin" })).toEqual({
			allowWrite: ["/work"],
			denyWrite: ["/work/.claude/settings.json", "/work/config/prod.yaml", `${home}/.zshrc`],
			denyRead: ["~/.aws", `${home}/.ssh/**`],
			allowRead: [],
		});
		// A command in a worktree has the relative rules under the worktree.
		expect(sandboxFilesystem(settings, { ...scope, cwd: "/wt" }, { home, platform: "darwin" }).denyWrite).toContain("/wt/config/prod.yaml");
	});

	it("reads the deny rules from every settings file, a repository's too, and never an allow or ask rule", () => {
		const root = mkdtempSync(join(tmpdir(), "sandbox-deny-"));
		const cwd = join(root, "project");
		const userHome = join(root, "home");
		const put = (path: string, settings: object) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(settings));
		};
		try {
			mkdirSync(cwd, { recursive: true });
			// The profile names the files: the product's user file always, and a repository's file where the profile reads one.
			const sources = settingsSources(cwd, userHome);
			put(productSettingsPath(userHome), { sandbox: { enabled: true }, permissions: { deny: ["Edit(~/.zshrc)"], allow: ["Edit(src/**)"], ask: ["Read(notes.md)"] } });
			const repo = sources.find(isRepoFile);
			if (repo) put(repo.path, { permissions: { deny: ["Write(config/prod.yaml)", "Read(.env)"], allow: ["Read(~/.ssh/**)"], ask: ["NotebookEdit(nb.ipynb)"] } });
			const settings = loadSandboxSettings(cwd, userHome);
			expect(settings.denyRulePaths).toEqual(repo ? { write: ["~/.zshrc", "config/prod.yaml"], read: [".env"] } : { write: ["~/.zshrc"], read: [] });
			const fs = sandboxFilesystem(settings, { cwd, writableDirs: [], protectedFiles: [] }, { home: userHome, platform: "darwin" });
			expect(fs.denyWrite).toEqual([join(userHome, ".zshrc"), ...(repo ? [join(cwd, "config", "prod.yaml")] : [])]);
			expect(fs.denyRead).toEqual(repo ? [join(cwd, ".env")] : []);
		} finally {
			// The product's user file sits in the test run's shared state folder, not under `root`.
			rmSync(productSettingsPath(userHome), { force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows the model the denied paths in the sandbox section", () => {
		const settings: SandboxSettings = { ...ON, denyRulePaths: { write: ["//etc/hosts"], read: ["//etc/shadow"] } };
		const section = sandboxSectionText(text, { settings, platform: "darwin", unavailable: undefined, cwd: "/work", active: fakeSandbox(settings) });
		expect(section).toContain(JSON.stringify({ read: { denyOnly: ["/etc/shadow"], allowWithinDeny: [] }, write: { allowOnly: ["/work", "/tmp/session"], denyWithinAllow: ["/work/.claude/settings.json", "/etc/hosts"] } }).replace(/"/g, '\\"'));
	});
});

describe.skipIf(!supported)("which calls run in the sandbox", () => {
	it("runs a command as written when the settings turn no sandbox on", async () => {
		setSandboxForTest(SANDBOX_OFF);
		expect(await sandboxedCommand({ ...request, disable: true })).toEqual({ command: "npm test" });
		expect(unsandboxedRequest({ dangerouslyDisableSandbox: true })).toBe(false);
	});

	it("wraps a command for its own directory and shell", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		expect(await sandboxedCommand(request)).toMatchObject({ command: "SANDBOX(npm test)", run: {} });
		expect(sandbox.wrapped).toMatchObject([{ command: "npm test", cwd: "/work", shell: "/bin/bash" }]);
		// The id the command presents to the proxy is random, never the tool call's.
		expect(sandbox.wrapped[0].id).toMatch(/^[\w-]{22}$/);
		expect(sandbox.wrapped[0].id).not.toBe("call-1");
	});

	it("gives a call the hosts the gate granted it, for its one run", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		grantCommandHosts("call-1", ["registry.npmjs.org"]);
		const first = await sandboxedCommand(request);
		const id = sandbox.wrapped[0].id;
		expect(sandbox.hosts.get(id)).toEqual(["registry.npmjs.org"]);
		if (!("run" in first) || !first.run) throw new Error("not sandboxed");
		first.run.finish();
		first.run.finish();
		expect(sandbox.hosts.size).toBe(0);
		// The grant was the one run's: the same call id again gets nothing.
		await sandboxedCommand(request);
		expect(sandbox.hosts.size).toBe(0);
	});

	it("ends every wrap exactly once, with or without hosts, so the runtime can clean up after it", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		const run = await sandboxedCommand(request);
		expect(sandbox.open.count).toBe(1);
		if (!("run" in run) || !run.run) throw new Error("not sandboxed");
		// Reading what was denied does not end the run; finishing does, once.
		run.run.withViolations("out");
		expect(sandbox.open.count).toBe(1);
		run.run.finish();
		run.run.finish();
		expect(sandbox.open.count).toBe(0);
	});

	it("never ends a wrap twice, even when ending it threw", async () => {
		const sandbox = fakeSandbox(ON);
		let ends = 0;
		sandbox.ended = () => {
			ends++;
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		};
		sandbox.release = () => {
			throw new Error("release failed");
		};
		setSandboxForTest(ON, sandbox);
		grantCommandHosts("call-1", ["registry.npmjs.org"]);
		const run = await sandboxedCommand(request);
		if (!("run" in run) || !run.run) throw new Error("not sandboxed");
		// Releasing the hosts failed, and the wrap is ended all the same.
		expect(() => run.run?.finish()).toThrow();
		expect(ends).toBe(1);
		run.run.finish();
		expect(ends).toBe(1);
	});

	it("runs every check after a command on its own, reporting a failure instead of throwing", () => {
		const removed: string[] = [];
		const renamed: string[] = [];
		const notices: string[] = [];
		const denied = () => {
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		};
		const checks = createEndChecks(
			{
				cleanup: denied,
				plantableCommondirs: () => [join("/repo", ".git", "commondir"), join("/other", ".git", "commondir")],
				looksLikeBareRepository: () => false,
				exists: () => true,
				remove: (path) => {
					if (path === join("/repo", ".git", "commondir")) denied();
					removed.push(path);
				},
				rename: (from) => void renamed.push(from),
			},
			(message) => void notices.push(message),
		);
		checks.started("run-1", "/work");
		let bareNow = false;
		const bare = createEndChecks({ cleanup: () => {}, plantableCommondirs: () => [], looksLikeBareRepository: () => bareNow, exists: () => false, remove: () => {}, rename: denied }, (message) => void notices.push(message));
		bare.started("run-1", "/work");
		// The directory became a bare repository while the command ran, and its HEAD cannot be moved.
		bareNow = true;
		expect(() => checks.ended("run-1")).not.toThrow();
		expect(() => bare.ended("run-1")).not.toThrow();
		expect(removed).toEqual([join("/other", ".git", "commondir")]);
		expect(notices).toHaveLength(3);
		expect(notices[0]).toMatch(/could not clean up/);
		expect(notices[1]).toContain(join("/repo", ".git", "commondir"));
		expect(notices[2]).toContain(join("/work", "HEAD"));
	});

	it("sets a planted HEAD aside without replacing one set aside earlier, and forgets a run whose wrap failed", () => {
		const present = new Set<string>([join("/work", "HEAD.set-aside-by-sandbox"), join("/work", "HEAD.set-aside-by-sandbox.2")]);
		const renamed: [string, string][] = [];
		let bare = false;
		const checks = createEndChecks(
			{
				cleanup: () => {},
				plantableCommondirs: () => [],
				looksLikeBareRepository: () => bare,
				exists: (path) => present.has(path),
				remove: () => {},
				rename: (from, to) => void renamed.push([from, to]),
			},
			() => {},
		);
		checks.started("a", "/work");
		bare = true;
		checks.ended("a");
		expect(renamed).toEqual([[join("/work", "HEAD"), join("/work", "HEAD.set-aside-by-sandbox.3")]]);
		// A wrap that failed never ends: its observation is dropped and nothing is undone for it later.
		bare = false;
		checks.started("b", "/work");
		checks.discard("b");
		bare = true;
		checks.ended("b");
		expect(renamed).toHaveLength(1);
	});

	it("undoes after a command only what appeared while that command ran, once, however runs overlap", () => {
		const commondir = join("/work", ".git", "commondir");
		const disk = { commondir: false, bare: false };
		const removed: string[] = [];
		const renamed: string[] = [];
		let cleanups = 0;
		const checks = createEndChecks(
			{
				cleanup: () => void cleanups++,
				plantableCommondirs: () => (disk.commondir ? [] : [commondir]),
				looksLikeBareRepository: () => disk.bare,
				exists: () => disk.commondir,
				remove: (path) => {
					removed.push(path);
					disk.commondir = false;
				},
				rename: (from) => {
					renamed.push(from);
					disk.bare = false;
				},
			},
			() => {},
		);
		// A run that found an ordinary directory ends; the user then makes a real bare repository there.
		checks.started("a", "/work");
		checks.ended("a");
		disk.bare = true;
		checks.started("b", "/work");
		checks.ended("b");
		expect(renamed).toEqual([]);
		// Two runs overlap and one of them plants both: the first to end undoes them, the other finds nothing left.
		disk.bare = false;
		checks.started("c", "/work");
		checks.started("d", "/work");
		disk.commondir = true;
		disk.bare = true;
		checks.ended("c");
		checks.ended("d");
		expect(removed).toEqual([commondir]);
		expect(renamed).toEqual([join("/work", "HEAD")]);
		// A name that was there when a run started is not that run's to undo; the earlier run's end does it.
		checks.started("e", "/work");
		disk.commondir = true;
		checks.started("f", "/work");
		checks.ended("f");
		expect(removed).toHaveLength(1);
		checks.ended("e");
		expect(removed).toHaveLength(2);
		// The runtime cleans up once per ended wrap, an unknown id included.
		checks.ended("never-started");
		expect(cleanups).toBe(7);
	});

	it("reads another directory's settings for a session that starts there", () => {
		setSandboxForTest({ ...ON, excludedCommands: ["docker *"] }, fakeSandbox(ON));
		useSandboxSettingsFor(process.cwd());
		expect(sandboxSettings().excludedCommands).toEqual(["docker *"]);
		const elsewhere = mkdtempSync(join(tmpdir(), "sandbox-other-"));
		try {
			useSandboxSettingsFor(elsewhere);
			// The first directory's exclusions are not carried into the second.
			expect(sandboxSettings().excludedCommands).not.toContain("docker *");
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("finds a linked worktree's git directories only when the git directory names the worktree back", () => {
		const files: Record<string, string> = {
			"/wt/.git": "gitdir: /repo/.git/worktrees/wt\n",
			"/repo/.git/worktrees/wt/gitdir": "/wt/.git\n",
			"/repo/.git/worktrees/wt/commondir": "../..\n",
			"/forged/.git": "gitdir: /repo/.git/worktrees/wt\n",
		};
		const read = (path: string) => {
			if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[path];
		};
		expect(linkedWorktreeGitDirs("/wt/src/deep", read)).toEqual(["/repo/.git/worktrees/wt", "/repo/.git/objects", "/repo/.git/refs", "/repo/.git/logs", "/repo/.git/packed-refs", "/repo/.git/packed-refs.lock"]);
		// A `.git` file a command wrote to point at someone else's git directory is not believed.
		expect(linkedWorktreeGitDirs("/forged", read)).toEqual([]);
		expect(linkedWorktreeGitDirs("/nowhere/at/all", read)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("protects what redirects git and what the runtime lists, for an ordinary checkout and a linked worktree", () => {
		const eisdir = () => {
			throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
		};
		const files: Record<string, string | (() => never)> = {
			"/repo/.git": eisdir,
			"/wt/.git": "gitdir: /repo/.git/worktrees/wt\n",
			"/repo/.git/worktrees/wt/commondir": "../..\n",
		};
		const reads: string[] = [];
		const read = (path: string) => {
			reads.push(path);
			const file = files[path];
			if (file === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return typeof file === "string" ? file : file();
		};
		const exists = (path: string) => path in files;
		const main = checkoutProtectedFiles("/repo/packages/app", read, "darwin");
		expect(main).toEqual(expect.arrayContaining(["/repo/.git/commondir", "/repo/.git/config.worktree", "/repo/.git/info/attributes", "/repo/.git/hooks", "/repo/.git/config", "/repo/.mcp.json", "/repo/packages/app/.mcp.json", "/repo/.pi", "/repo/.gitmodules"]));
		const linked = checkoutProtectedFiles("/wt", read, "darwin");
		expect(linked).toEqual(expect.arrayContaining(["/wt/.git", "/repo/.git/worktrees/wt/commondir", "/repo/.git/worktrees/wt/gitdir", "/repo/.git/worktrees/wt/config.worktree", "/repo/.git/hooks", "/repo/.git/config", "/repo/.git/commondir"]));
		expect(checkoutProtectedFiles("/nowhere", read, "darwin")).toEqual(expect.arrayContaining(["/nowhere/.mcp.json"]));
		files["/repo/.git/config"] = "[core]\n";
		files["/repo/.mcp.json"] = "{}";
		reads.length = 0;
		// Every name is listed on Linux too; what is there is asked per command, below.
		const onLinux = checkoutProtectedFiles("/repo/packages/app", read, "linux");
		// (A missing HEAD is the one exception, bareRepositoryFiles.)
		expect(onLinux).toEqual(expect.arrayContaining(main.filter((path) => basename(path) !== "HEAD")));
		// Only the `.git` entries whose contents name another directory are read,
		// never a protected file (a FIFO there would block, a large file be read whole).
		expect(reads.every((path) => basename(path) === ".git" || basename(path) === "commondir")).toBe(true);
		// A command's rules: what exists as it is, what is missing through a name
		// beneath it, so bubblewrap's stub there is an empty read-only directory that
		// git ignores (a stub file is listed as untracked and breaks `git add -A`).
		const scope = { cwd: "/repo/packages/app", writableDirs: [], protectedFiles: onLinux };
		const denied = sandboxCommandFilesystem(ON, scope, { platform: "linux", exists }).denyWrite;
		const stub = (path: string) => join(path, DIRECTORY_STUB_CHILD);
		expect(denied).toEqual(expect.arrayContaining(["/repo/.git/config", "/repo/.mcp.json", ...["/repo/.pi", "/repo/packages/app/.pi", "/repo/.gitmodules", "/repo/.vscode", "/repo/.bashrc", "/repo/.git/config.worktree", "/repo/.git/info/attributes", "/repo/.git/gitdir", "/repo/.git/hooks"].map(stub)]));
		expect(denied).not.toContain("/repo/.pi");
		// Where a directory would break git or help plant a repository, nothing: the end-of-command checks undo those.
		for (const kept of ["/repo/.git/commondir", "/repo/packages/app/objects", "/repo/packages/app/refs"]) {
			expect(denied).not.toContain(kept);
			expect(denied).not.toContain(stub(kept));
		}
		// macOS denies by rule, with nothing put at the path, and the prompt shows the names either way.
		expect(sandboxCommandFilesystem(ON, scope, { platform: "darwin", exists }).denyWrite).toEqual(expect.arrayContaining(["/repo/.pi", "/repo/.git/commondir"]));
		expect(sandboxFilesystem(ON, scope, { platform: "linux" }).denyWrite).toEqual(expect.arrayContaining(["/repo/.pi", "/repo/.git/commondir"]));
		// A name that appears later is denied as it is from the next command on.
		files["/repo/.pi"] = eisdir;
		expect(sandboxCommandFilesystem(ON, scope, { platform: "linux", exists }).denyWrite).toContain("/repo/.pi");
		// The one name that redirects the harness's own git is removed after a command if it appears.
		expect(plantableCommondirs("/repo/packages/app", read, "linux", exists)).toEqual(["/repo/.git/commondir"]);
		const linkedOnLinux = checkoutProtectedFiles("/wt", read, "linux");
		expect(linkedOnLinux).toEqual(expect.arrayContaining(["/wt/.git", "/repo/.git/worktrees/wt/commondir", "/repo/.git/config"]));
		expect(sandboxCommandFilesystem(ON, { ...scope, cwd: "/wt", protectedFiles: linkedOnLinux }, { platform: "linux", exists }).denyWrite).toEqual(expect.arrayContaining(["/wt/.git", "/repo/.git/worktrees/wt/commondir", stub("/repo/.git/worktrees/wt/gitdir")]));
		expect(plantableCommondirs("/wt", read, "linux", exists)).toEqual(["/repo/.git/commondir"]);
		expect(plantableCommondirs("/repo/packages/app", read, "darwin", exists)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("reads a git pointer without waiting on a FIFO, and tells what is there by its metadata", () => {
		const dir = mkdtempSync(join(tmpdir(), "sandbox-fifo-"));
		try {
			execFileSync("mkfifo", [join(dir, ".git"), join(dir, ".mcp.json")]);
			// A FIFO with no writer would hang an ordinary read; this one throws at once.
			expect(() => readGitPointer(join(dir, ".git"))).toThrow(/not a regular file/);
			expect(() => readGitPointer(dir)).toThrow(/EISDIR/);
			writeFileSync(join(dir, "pointer"), "gitdir: /x\n");
			expect(readGitPointer(join(dir, "pointer"))).toBe("gitdir: /x\n");
			expect(pathExists(join(dir, ".mcp.json"))).toBe(true);
			expect(pathExists(join(dir, "missing"))).toBe(false);
			expect(pathExists(join(dir, "pointer", "below"))).toBe(false);
			// A link to nothing is something at the name: the command could create its target.
			symlinkSync(join(dir, "nowhere"), join(dir, ".pi"));
			expect(pathExists(join(dir, ".pi"))).toBe(true);
			// Neither FIFO is opened on the way.
			expect(checkoutProtectedFiles(dir, undefined, "linux")).toEqual(expect.arrayContaining([join(dir, ".mcp.json"), join(dir, ".pi")]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tells a directory git would take for a repository: HEAD beside objects and refs", () => {
		const dir = mkdtempSync(join(tmpdir(), "sandbox-bare-"));
		try {
			expect(looksLikeBareRepository(dir)).toBe(false);
			mkdirSync(join(dir, "objects"));
			mkdirSync(join(dir, "refs"));
			expect(looksLikeBareRepository(dir)).toBe(false);
			writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
			expect(looksLikeBareRepository(dir)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe.skipIf(process.platform === "win32")("the names that make a directory a bare repository", () => {
		let dir: string;
		const made: string[] = [];
		const make = (...entries: Array<[string, "file" | "dir"]>) => {
			dir = mkdtempSync(join(tmpdir(), "sandbox-bare-"));
			made.push(dir);
			for (const [name, kind] of entries) {
				if (kind === "dir") mkdirSync(join(dir, name), { recursive: true });
				else {
					mkdirSync(dirname(join(dir, name)), { recursive: true });
					writeFileSync(join(dir, name), "x");
				}
			}
		};
		const at = (...names: string[]) => names.map((name) => join(dir, name));
		afterEach(() => {
			for (const each of made.splice(0)) rmSync(each, { recursive: true, force: true });
		});

		it("never lets objects and refs be written, and a missing HEAD only on macOS, where denying it plants no file", () => {
			make();
			expect(bareRepositoryFiles(dir, "darwin")).toEqual(at("objects", "refs", "HEAD"));
			expect(bareRepositoryFiles(dir, "linux")).toEqual(at("objects", "refs"));
			make(["HEAD", "file"], ["objects", "dir"], ["refs", "dir"]);
			expect(bareRepositoryFiles(dir, "linux")).toEqual(at("objects", "refs", "HEAD"));
		});

		it("leaves an ordinary project's config and hooks folders writable, denying only a .git inside one", () => {
			make(["config", "dir"], ["hooks", "dir"], ["config/.git", "dir"]);
			for (const platform of ["darwin", "linux"] as const) {
				const found = bareRepositoryFiles(dir, platform);
				expect(found).not.toContain(join(dir, "config"));
				expect(found).not.toContain(join(dir, "hooks"));
				expect(found).toContain(join(dir, "config", ".git"));
				expect(found).not.toContain(join(dir, "hooks", ".git"));
			}
		});

		it("denies config and hooks beside a HEAD, and a config file always, with the lock git writes it through", () => {
			make(["HEAD", "file"], ["config", "dir"], ["hooks", "dir"]);
			expect(bareRepositoryFiles(dir, "linux")).toEqual(at("objects", "refs", "HEAD", "hooks", "config"));
			make(["config", "file"]);
			expect(bareRepositoryFiles(dir, "linux")).toEqual(at("objects", "refs", "config", "config.lock"));
			// A folder named HEAD is no head: the project's hooks folder stays writable.
			make(["HEAD", "dir"], ["hooks", "dir"]);
			expect(bareRepositoryFiles(dir, "linux")).toEqual(at("objects", "refs", "HEAD"));
		});
	});

	it("believes a worktree's git directory that names it by its real path, and never through a `.git` symlink", () => {
		// macOS: the temp dir is reached as /var/folders/…, and git records /private/var/folders/….
		const files: Record<string, string> = {
			"/var/t/wt/.git": "gitdir: /repo/.git/worktrees/wt\n",
			"/repo/.git/worktrees/wt/gitdir": "/private/var/t/wt/.git\n",
			"/repo/.git/worktrees/wt/commondir": "../..\n",
			// A `.git` symlink in another directory reads as the worktree's own pointer.
			"/elsewhere/.git": "gitdir: /repo/.git/worktrees/wt\n",
		};
		const read = (path: string) => {
			if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[path];
		};
		const links: Record<string, string> = { "/var/t/wt": "/private/var/t/wt", "/private/var/t/wt": "/private/var/t/wt", "/elsewhere": "/elsewhere", "/elsewhere/.git": "/private/var/t/wt/.git" };
		const real = (path: string) => {
			if (!(path in links)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return links[path];
		};
		expect(linkedWorktreeGitDirs("/var/t/wt", read, real)).toEqual(["/repo/.git/worktrees/wt", "/repo/.git/objects", "/repo/.git/refs", "/repo/.git/logs", "/repo/.git/packed-refs", "/repo/.git/packed-refs.lock"]);
		expect(linkedWorktreeGitDirs("/elsewhere", read, real)).toEqual([]);
	});

	it("gives a call nothing without the gate's grant", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		grantCommandHosts("call-1", ["registry.npmjs.org"]);
		await sandboxedCommand({ ...request, id: "call-2" });
		expect(sandbox.hosts.size).toBe(0);
	});

	it("wraps the bash line of a tool whose own shell is not bash, and files denials under the model's command", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		const line = powerShellBashLine({ shell: "/usr/local/bin/pwsh", args: ["-NoProfile", "-Command"] }, "Write-Output hi");
		expect(line.startsWith("'/usr/local/bin/pwsh' '-NoProfile' '-Command' '")).toBe(true);
		expect(line.endsWith("Write-Output hi'")).toBe(true);
		await sandboxedCommand({ ...request, command: "Get-ChildItem", original: "Get-ChildItem", line: () => "'pwsh' '-Command' 'Get-ChildItem'" });
		expect(sandbox.wrapped[0]).toMatchObject({ command: "'pwsh' '-Command' 'Get-ChildItem'", shell: "/bin/bash", text: "Get-ChildItem" });
	});

	it("takes auto-allow and the fallback from the settings again without a restart, and nothing else", () => {
		const settings = { ...ON, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true };
		setSandboxForTest(settings, fakeSandbox(settings));
		const loaded = reloadSandboxSettings();
		expect(sandboxSettings()).toMatchObject({ enabled: true, allowUnsandboxedCommands: loaded.allowUnsandboxedCommands, autoAllowBashIfSandboxed: loaded.autoAllowBashIfSandboxed });
	});

	it("refuses a call whose granted host list the sandbox rejects, with the reason", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		grantCommandHosts("call-1", ["not a host"]);
		expect(await sandboxedCommand(request)).toEqual({ refused: { kind: "hosts", reason: 'invalid host "not a host"' } });
		expect(sandbox.wrapped).toEqual([]);
	});

	it("reads a call's own hosts only where a sandbox will hold the call", () => {
		expect(commandHosts({ allowed_domains: [" a.example ", "a.example", "", 3, "x".repeat(261)] })).toEqual(["a.example"]);
		expect(commandHosts({ allowed_domains: Array.from({ length: 150 }, (_, i) => `h${i}.example`) })).toHaveLength(100);
		setSandboxForTest(SANDBOX_OFF);
		expect(requestedHosts({ allowed_domains: ["a.example"] })).toEqual([]);
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(requestedHosts({ allowed_domains: ["a.example"] })).toEqual(["a.example"]);
		expect(requestedHosts({ allowed_domains: ["a.example"], dangerouslyDisableSandbox: true })).toEqual([]);
	});

	it("says which calls will run sandboxed, for the gate's manual modes", () => {
		setSandboxForTest(SANDBOX_OFF);
		expect(runsSandboxed({}, "npm test")).toBe(false);
		setSandboxForTest(AUTO, undefined, "no bwrap");
		expect(runsSandboxed({}, "npm test")).toBe(false);
		const settings = { ...AUTO, excludedCommands: ["docker *"] };
		setSandboxForTest(settings, fakeSandbox(settings));
		expect(runsSandboxed({}, "npm test")).toBe(true);
		expect(runsSandboxed({ dangerouslyDisableSandbox: true }, "npm test")).toBe(false);
		expect(runsSandboxed({}, "docker ps")).toBe(false);
		// Off by default: the sandbox alone changes no prompt.
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(runsSandboxed({}, "npm test")).toBe(false);
		// Strict mode ignores the flag, so the call stays sandboxed.
		const strict = { ...AUTO, allowUnsandboxedCommands: false };
		setSandboxForTest(strict, fakeSandbox(strict));
		expect(runsSandboxed({ dangerouslyDisableSandbox: true }, "npm test")).toBe(true);
	});

	it("lets the model leave the sandbox only where the settings allow it", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(await sandboxedCommand({ ...request, disable: true })).toEqual({ command: "npm test" });
		expect(unsandboxedRequest({ dangerouslyDisableSandbox: true })).toBe(true);
		expect(unsandboxedRequest({ dangerouslyDisableSandbox: "true" })).toBe(false);

		const strict = { ...ON, allowUnsandboxedCommands: false };
		setSandboxForTest(strict, fakeSandbox(strict));
		expect(await sandboxedCommand({ ...request, disable: true })).toMatchObject({ command: "SANDBOX(npm test)" });
		expect(unsandboxedRequest({ dangerouslyDisableSandbox: true })).toBe(false);
	});

	it("runs the user's excluded commands outside it, judged on the model's own command", async () => {
		const settings = { ...ON, excludedCommands: ["docker *"] };
		setSandboxForTest(settings, fakeSandbox(settings));
		expect(await sandboxedCommand({ ...request, command: "cd '/wt' && (docker ps)", original: "docker ps" })).toEqual({ command: "cd '/wt' && (docker ps)" });
		expect(await sandboxedCommand({ ...request, command: "docker ps; curl evil", original: "docker ps; curl evil" })).toMatchObject({ command: "SANDBOX(docker ps; curl evil)" });
	});

	it("refuses a command when the machine has no bash to run it in", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(await sandboxedCommand({ ...request, bash: undefined })).toEqual({ refused: { kind: "noBash" } });
	});

	it("runs unsandboxed when the sandbox could not start, unless the settings require it", async () => {
		setSandboxForTest(ON, undefined, "bubblewrap (bwrap) not found");
		expect(await sandboxedCommand(request)).toEqual({ command: "npm test" });
		setSandboxForTest({ ...ON, failIfUnavailable: true }, undefined, "bubblewrap (bwrap) not found");
		expect(await sandboxedCommand(request)).toEqual({ refused: { kind: "unavailable", reason: "bubblewrap (bwrap) not found" } });
	});
});

describe.skipIf(!supported)("the shell tool under a sandbox", () => {
	const BASH = { shell: "/bin/bash", args: ["-c"] };
	function mount(bash?: typeof BASH) {
		const fake = createFakePi();
		const foreground = vi.fn(async (..._args: unknown[]) => ({ content: [{ type: "text", text: "curl: (56) CONNECT tunnel failed\n\nCommand exited with code 56" }], structuredContent: { exit_code: 56 }, isError: true, details: {} }));
		registerShellTool(fake.pi as never, {
			name: "bash",
			ccLabel: "Bash",
			description: "",
			parameters: Type.Object({ command: Type.String() }),
			base: { label: "Bash" },
			foreground: () => ({ execute: foreground }),
			guard: () => undefined,
			sandboxText: () => text,
			backgroundShell: () => bash,
		});
		return { tool: fake.tools.get("bash")!, foreground };
	}

	it("executes the wrapped command and appends what the sandbox denied", async () => {
		const sandbox = fakeSandbox(ON, "\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>");
		setSandboxForTest(ON, sandbox);
		const { tool, foreground } = mount(BASH);
		const result = (await tool.execute("c1", { command: "curl https://example.com" }, undefined, undefined, createFakeCtx({ mode: "tui", cwd: "/work" }))) as { content: Array<{ text: string }> };
		expect((foreground.mock.calls[0][1] as { command: string }).command).toBe("SANDBOX(curl https://example.com)");
		expect(result.content[0].text).toBe("Exit code 56\ncurl: (56) CONNECT tunnel failed\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>");
	});

	it("executes the model's command as written when it may leave the sandbox", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		const { tool, foreground } = mount(BASH);
		await tool.execute("c1", { command: "curl https://example.com", dangerouslyDisableSandbox: true }, undefined, undefined, createFakeCtx({ mode: "tui" }));
		expect((foreground.mock.calls[0][1] as { command: string }).command).toBe("curl https://example.com");
	});

	it("runs a non-bash tool's sandboxed command through its bash executor, and an unsandboxed one through its own", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		const fake = createFakePi();
		const result = { content: [{ type: "text", text: "ok" }], details: {} };
		const own = vi.fn(async (..._args: unknown[]) => result);
		const viaBash = vi.fn(async (..._args: unknown[]) => result);
		registerShellTool(fake.pi as never, {
			name: "powershell",
			ccLabel: "PowerShell",
			description: "",
			parameters: Type.Object({ command: Type.String() }),
			base: { label: "PowerShell" },
			foreground: () => ({ execute: own }),
			guard: () => undefined,
			sandboxText: () => text,
			sandboxed: { bash: () => BASH, line: (command: string) => `pwsh -Command ${command}`, foreground: () => ({ execute: viaBash }) },
			backgroundShell: () => undefined,
		} as never);
		const tool = fake.tools.get("powershell")!;
		await tool.execute("c1", { command: "Get-Date" }, undefined, undefined, createFakeCtx({ mode: "tui", cwd: "/work" }));
		expect(sandbox.wrapped[0]).toMatchObject({ command: "pwsh -Command Get-Date", text: "Get-Date" });
		expect((viaBash.mock.calls[0][1] as { command: string }).command).toBe("SANDBOX(pwsh -Command Get-Date)");
		expect(own).not.toHaveBeenCalled();
		await tool.execute("c2", { command: "Get-Date", dangerouslyDisableSandbox: true }, undefined, undefined, createFakeCtx({ mode: "tui", cwd: "/work" }));
		expect((own.mock.calls[0][1] as { command: string }).command).toBe("Get-Date");
	});

	it("refuses a call the sandbox cannot run, loudly, and runs nothing", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		const { tool, foreground } = mount();
		const result = await tool.execute("c1", { command: "Get-ChildItem" }, undefined, undefined, createFakeCtx({ mode: "tui" }));
		expect(result).toMatchObject({ isError: true, content: [{ text: 'refused {"kind":"noBash"}' }] });
		expect(foreground).not.toHaveBeenCalled();
	});
});

describe.skipIf(process.platform === "win32")("a monitor under the sandbox", () => {
	const DENIED = "<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>";
	/** The fake sandbox, except that a wrapped command runs as written, so the monitor's command really runs. */
	function passThrough(violations: string) {
		const sandbox = fakeSandbox(ON, violations);
		const wrap = sandbox.wrap;
		sandbox.wrap = async (command, call) => {
			await wrap(command, call);
			return command;
		};
		return sandbox;
	}
	function mountMonitor() {
		const fake = createFakePi();
		backgroundExtension(fake.pi as never);
		void fake.fire("before_agent_start", {}, createFakeCtx({}));
		return { fake, monitor: fake.tools.get("monitor")! };
	}

	it("returns what the sandbox denied after the events in a one-shot run, and ends the run", async () => {
		const sandbox = passThrough(`\n${DENIED}`);
		setSandboxForTest(ON, sandbox);
		const { monitor } = mountMonitor();
		const result = (await monitor.execute("c1", { command: "echo ev1", description: "d" }, undefined, undefined, createFakeCtx({ mode: "print" }))) as { content: Array<{ text: string }> };
		expect(sandbox.wrapped[0]).toMatchObject({ command: "echo ev1", text: "echo ev1" });
		expect(result.content[0].text).toMatch(/\n\nev1\n<sandbox_violations>\ndeny network-outbound example\.com:443\n<\/sandbox_violations>$/);
		expect(sandbox.open.count).toBe(0);
	});

	it("carries what the sandbox denied on a detached monitor's completion notification", async () => {
		const sandbox = passThrough(`\n${DENIED}`);
		setSandboxForTest(ON, sandbox);
		const { fake, monitor } = mountMonitor();
		await monitor.execute("c1", { command: "echo ev1", description: "d" }, undefined, undefined, createFakeCtx({ hasUI: true, mode: "tui" }));
		const ended = () => fake.sentMessages.find((m) => ((m.message.content as Array<{ text?: string }>)[0]?.text ?? "").includes("<status>completed</status>"));
		for (let waited = 0; !ended() && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_COALESCE_MS + 50));
		const text = (ended()!.message.content as Array<{ text: string }>)[0].text;
		// The end's recent tail, then the block, inside the completion's <event>.
		expect(text.slice(text.indexOf("<status>completed</status>"))).toContain(`ev1\n${escapeTaskText(DENIED)}</event>`);
		expect(sandbox.open.count).toBe(0);
	});

	it("carries what the sandbox denied on the last batch of a monitor that expired", async () => {
		setSandboxForTest(ON, passThrough(`\n${DENIED}`));
		const expiry = vi.spyOn(backgroundWords(requireText("background")).monitor, "expired").mockReturnValue("EXPIRY");
		const { fake, monitor } = mountMonitor();
		await monitor.execute("c1", { command: "echo ev1; sleep 30", description: "d", timeout_ms: 1000 }, undefined, undefined, createFakeCtx({ hasUI: true, mode: "tui" }));
		const expiredBatch = () => fake.sentMessages.find((m) => ((m.message.content as Array<{ text?: string }>)[0]?.text ?? "").includes("EXPIRY"));
		for (let waited = 0; !expiredBatch() && waited < 8000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
		expect(expiry).toHaveBeenCalledOnce();
		const text = (expiredBatch()!.message.content as Array<{ text: string }>)[0].text;
		// The event may have gone out in a batch of its own first; the block follows the expiry line.
		expect(text).toContain(`EXPIRY\n${escapeTaskText(DENIED)}</event>`);
		expiry.mockRestore();
	}, 15_000);

	it("adds nothing when the sandbox denied nothing", async () => {
		setSandboxForTest(ON, passThrough(""));
		const { monitor } = mountMonitor();
		const result = (await monitor.execute("c1", { command: "echo ev1", description: "d" }, undefined, undefined, createFakeCtx({ mode: "print" }))) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toMatch(/\n\nev1$/);
	});
});

describe("the gate and a call that asks to leave the sandbox", () => {
	const base = { toolName: "bash", cwd: "/work", deny: [], ask: [], allow: [], claudeCodeFastPaths: true };

	it("takes no shell fast path: a read-only command is asked about, or classified in auto mode", () => {
		expect(decide({ ...base, mode: "default", subject: "ls" })).toMatchObject({ decision: "allow", cause: "read-only" });
		expect(decide({ ...base, mode: "default", subject: "ls", unsandboxed: true }).decision).toBe("ask");
		expect(decide({ ...base, mode: "acceptEdits", subject: "mkdir out", unsandboxed: true }).decision).toBe("ask");
		expect(decide({ ...base, mode: "auto", subject: "ls", unsandboxed: true }).decision).toBe("classify");
		expect(decide({ ...base, mode: "dontAsk", subject: "ls", unsandboxed: true }).decision).toBe("deny");
	});
});

describe("the gate and a command the sandbox will hold", () => {
	const base = { toolName: "bash", cwd: "/work", deny: [], ask: [], allow: [], claudeCodeFastPaths: true, sandboxed: true };

	it("runs without a prompt in default and acceptEdits modes only", () => {
		expect(decide({ ...base, mode: "default", subject: "npm test", sandboxed: false }).decision).toBe("ask");
		expect(decide({ ...base, mode: "default", subject: "npm test" })).toMatchObject({ decision: "allow", cause: "sandboxed" });
		expect(decide({ ...base, mode: "acceptEdits", subject: "npm test" })).toMatchObject({ decision: "allow", cause: "sandboxed" });
		expect(decide({ ...base, toolName: "monitor", mode: "default", subject: "tail -f log" }).decision).toBe("ask");
		expect(decide({ ...base, mode: "auto", subject: "npm test" }).decision).toBe("classify");
		expect(decide({ ...base, mode: "dontAsk", subject: "npm test" }).decision).toBe("deny");
	});

	it("keeps deny rules, ask rules and the prompt for a write it can see on a protected path", () => {
		const rule = (raw: string) => ({ tool: "bash", pattern: raw, raw: `Bash(${raw})` });
		expect(decide({ ...base, mode: "default", subject: "npm publish", deny: [rule("npm publish:*")] } as never).decision).toBe("deny");
		expect(decide({ ...base, mode: "default", subject: "npm publish", ask: [rule("npm publish:*")] } as never).decision).toBe("ask");
		expect(decide({ ...base, mode: "default", subject: "echo x > .git/hooks/pre-commit" }).decision).toBe("ask");
		expect(decide({ ...base, mode: "default", subject: "echo x > out.txt" })).toMatchObject({ decision: "allow" });
	});
});

describe("the gate and a call that names hosts for itself", () => {
	const base = { toolName: "bash", cwd: "/work", deny: [], ask: [], allow: [], claudeCodeFastPaths: true, mode: "auto" as const };

	it("is classified in auto mode whatever fast path or allow rule would clear the command", () => {
		const allow = [{ tool: "bash", pattern: "curl:*", raw: "Bash(curl:*)" }];
		expect(decide({ ...base, subject: "ls" })).toMatchObject({ decision: "allow", cause: "read-only" });
		expect(decide({ ...base, subject: "ls", commandHosts: true }).decision).toBe("classify");
		expect(decide({ ...base, subject: "curl https://a.example", allow } as never)).toMatchObject({ decision: "allow", cause: "rule" });
		expect(decide({ ...base, subject: "curl https://a.example", allow, commandHosts: true } as never).decision).toBe("classify");
	});

	it("shows the classifier the hosts with the command, and a plain command as before", () => {
		const line = (input: object, asWritten?: string) => renderTranscript([toolCallEntry("bash", input, asWritten)]);
		expect(line({ command: "ls", description: "list" })).toContain('{"Bash":"ls"}');
		expect(line({ command: "curl https://a.example", allowed_domains: ["a.example"] })).toContain('{"Bash":{"command":"curl https://a.example","allowed_domains":["a.example"]}}');
		expect(line({ command: "cd /wt && (curl x)", allowed_domains: ["a.example"] }, "curl x")).toContain('{"Bash":{"command":"curl x","allowed_domains":["a.example"]}}');
		expect(line({ command: "ls", allowed_domains: [] })).toContain('{"Bash":"ls"}');
		// The flag that asks to leave the sandbox is not part of the entry, as in Claude Code.
		expect(line({ command: "ls", dangerouslyDisableSandbox: true })).toContain('{"Bash":"ls"}');
	});
});

describe("the gate and a monitor that names hosts for itself", () => {
	it("is not cleared by an allow rule for its command", () => {
		const base = { toolName: "monitor", cwd: "/work", deny: [], ask: [], allow: [{ tool: "monitor", pattern: "tail:*", raw: "Monitor(tail:*)" }], claudeCodeFastPaths: true, mode: "auto" as const, subject: "tail -f log" };
		expect(decide(base as never)).toMatchObject({ decision: "allow", cause: "rule" });
		expect(decide({ ...base, commandHosts: true } as never).decision).toBe("classify");
	});
});

describe("the classifier's view and a user's approval of a call under the sandbox", () => {
	it("shows the classifier the hosts the allow would grant, whatever shape the model wrote them in", () => {
		// The model wrote a bare string; argument validation made it a one-entry list, which is what the gate grants.
		const entry = toolCallEntry("bash", { command: "npm install", allowed_domains: "evil.example" }, undefined, ["evil.example"]);
		expect(renderTranscript([entry])).toContain('{"Bash":{"command":"npm install","allowed_domains":["evil.example"]}}');
		expect(renderTranscript([toolCallEntry("bash", { command: "ls", allowed_domains: ["a.example"] }, undefined, [])])).toContain('{"Bash":"ls"}');
		expect(toolCallEntry("monitor", { command: "tail -f log", description: "d" }, undefined, ["a.example"])).toMatchObject({ input: { command: "tail -f log", allowed_domains: ["a.example"] } });
	});

	it.skipIf(!supported)("does not let an approval of a command cover the same command leaving the sandbox or being granted hosts", () => {
		// The key reads what the gate's facts say the call asks of the running sandbox.
		const key = (input: Record<string, unknown>) => {
			const { unsandboxed, hosts } = sandboxGateFacts("bash", input, String(input.command), "auto");
			return denialInputKey("bash", input, "/work", true, { unsandboxed, hosts });
		};
		const plain = { command: "curl https://a.example" };
		const leaving = { ...plain, dangerouslyDisableSandbox: true };
		const naming = { ...plain, allowed_domains: ["a.example"] };
		try {
			const settings = { ...SANDBOX_OFF, enabled: true, allowUnsandboxedCommands: true };
			setSandboxForTest(settings, fakeSandbox(settings));
			expect(key({ ...plain, description: "x", dangerouslyDisableSandbox: false })).toBe(key(plain));
			expect(key(leaving)).not.toBe(key(plain));
			expect(key(naming)).not.toBe(key(plain));
			const running = key(naming);
			// No sandbox runs: the fields ask nothing of it, and an approval made then does not hold once one runs.
			setSandboxForTest(undefined);
			expect(key(leaving)).toBe(key(plain));
			expect(key(naming)).toBe(key(plain));
			expect(key(naming)).not.toBe(running);
		} finally {
			setSandboxForTest(undefined);
		}
	});
});

describe("a host the settings do not list", () => {
	function gate(mode: string, answers: HostAnswer[] = []) {
		const asked: string[] = [];
		const hosts = createHostGate({
			mode: () => mode,
			notListed: "not listed",
			prompt: async (host) => {
				asked.push(host);
				return answers.shift();
			},
		});
		return { hosts, asked };
	}

	it("follows the permission mode without asking where no prompt belongs", async () => {
		expect(await gate("bypassPermissions").hosts.ask({ host: "a.example" })).toBe(true);
		expect(await gate("auto").hosts.ask({ host: "a.example" })).toEqual({ allow: false, reason: "not listed" });
		expect(await gate("dontAsk").hosts.ask({ host: "a.example" })).toBe(false);
	});

	it("asks the user once per host and run, and keeps a session grant", async () => {
		const { hosts, asked } = gate("default", ["once", "no", "session", "no"]);
		expect(await Promise.all([hosts.ask({ host: "a.example" }), hosts.ask({ host: "A.example", port: 443 })])).toEqual([true, true]);
		expect(await hosts.ask({ host: "b.example" })).toBe(false);
		expect(await hosts.ask({ host: "b.example" })).toBe(false);
		expect(await hosts.ask({ host: "c.example" })).toBe(true);
		expect(asked).toEqual(["a.example", "b.example", "c.example"]);
		hosts.endRun();
		expect(await hosts.ask({ host: "c.example" })).toBe(true);
		expect(await hosts.ask({ host: "a.example" })).toBe(false);
		expect(asked).toEqual(["a.example", "b.example", "c.example", "a.example"]);
		expect(hosts.sessionHosts()).toEqual(["c.example"]);
	});

	it("refuses when there is no one to ask, and asks again next time", async () => {
		const { hosts, asked } = gate("default", [undefined, "once"]);
		expect(await hosts.ask({ host: "a.example" })).toBe(false);
		expect(await hosts.ask({ host: "a.example" })).toBe(true);
		expect(asked).toEqual(["a.example", "a.example"]);
	});
});

describe("a prompt raised outside the permission gate", () => {
	const bus = () => {
		const handlers = new Map<string, Array<(data: unknown) => void>>();
		return {
			on: (channel: string, handler: (data: unknown) => void) => void handlers.set(channel, [...(handlers.get(channel) ?? []), handler]),
			emit: (channel: string, data: unknown) => void (handlers.get(channel) ?? []).forEach((handler) => handler(data)),
		};
	};

	it("runs in the gate's queue when a gate is on the bus, and opens directly when none is", async () => {
		const events = bus();
		const order: string[] = [];
		// The gate: it takes the request and answers it later, in its own turn.
		events.on(GATE_PROMPT_REQUEST_CHANNEL, (data) => {
			const request = data as GatePromptRequest;
			request.taken = true;
			order.push("queued");
			void Promise.resolve().then(async () => request.settle(await request.open()));
		});
		const answer = requestGatePrompt(events, { hasUI: true }, undefined, undefined, async () => {
			order.push("opened");
			return "Yes";
		});
		expect(order).toEqual(["queued"]);
		expect(await answer).toBe("Yes");
		expect(order).toEqual(["queued", "opened"]);

		const alone = bus();
		expect(await requestGatePrompt(alone, { hasUI: true }, undefined, undefined, async () => "No")).toBe("No");
		// With no one to ask, nothing opens.
		const open = vi.fn(async () => "Yes");
		expect(await requestGatePrompt(alone, { hasUI: false }, undefined, undefined, open)).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
	});
});

describe("the sandbox section and /sandbox", () => {
	const facts = { settings: ON, platform: "darwin" as const, unavailable: undefined, cwd: "/work" };

	it("prints the session's rules for the command's directory", () => {
		const section = sandboxSectionText(text, { ...facts, active: fakeSandbox(ON) });
		expect(section).toBe(
			`section ${JSON.stringify({
				platform: "darwin",
				filesystem: JSON.stringify({ read: { denyOnly: [], allowWithinDeny: [] }, write: { allowOnly: ["/work", "/tmp/session"], denyWithinAllow: ["/work/.claude/settings.json"] } }),
				unsandboxedAllowed: true,
			})}`,
		);
	});

	it("says so when the sandbox could not start", () => {
		expect(sandboxSectionText(text, { ...facts, settings: { ...ON, failIfUnavailable: true }, active: undefined, unavailable: "no bwrap" })).toBe('unavailable {"reason":"no bwrap","required":true}');
	});

	it("tells the user the state in each case", () => {
		expect(sandboxStatusLines({ ...facts, platform: undefined, active: undefined })[0]).toContain("not available on this platform");
		expect(sandboxStatusLines({ ...facts, settings: SANDBOX_OFF, active: undefined })[0]).toBe("Command sandbox: off.");
		expect(sandboxStatusLines({ ...facts, active: undefined, unavailable: "no bwrap" })).toEqual(["Command sandbox: on in settings, not running (no bwrap).", "Shell commands run without it."]);
		expect(sandboxStatusLines({ ...facts, active: fakeSandbox(ON) })).toContain("Writable: /work, /tmp/session");
	});
});

describe("the /sandbox panel", () => {
	const plain = (_color: string, value: string) => value;
	const bold = (value: string) => value;

	it("opens on the current mode and lists the three modes", () => {
		const state = openSandboxPanel(AUTO);
		expect(state).toMatchObject({ tab: "mode", row: 0 });
		const lines = renderSandboxPanel({ state, mode: "auto-allow", override: "fallback", config: [], width: 100, height: 30 }, plain, bold);
		expect(lines.filter((line) => /Sandbox commands|No sandbox/.test(line))).toEqual(["  ❯ ✔ Sandbox commands, with auto-allow", "      Sandbox commands, with regular permissions", "      No sandbox"]);
		expect(lines.at(-1)).toContain("Enter to select");
		expect(lines.at(-1)).toContain("Esc to close");
	});

	it("moves between rows and tabs, picks with Enter and scrolls the config", () => {
		const current = { mode: sandboxModeOf(ON), override: "strict" as const };
		const state = openSandboxPanel(ON);
		expect(state.row).toBe(1);
		applySandboxPanelKey(state, "down", current, 10);
		expect(applySandboxPanelKey(state, "select", current, 10)).toEqual({ kind: "pick", pick: { tab: "mode", value: "off" } });
		applySandboxPanelKey(state, "right", current, 10);
		expect(state).toMatchObject({ tab: "overrides", row: 1 });
		applySandboxPanelKey(state, "up", current, 10);
		expect(applySandboxPanelKey(state, "select", current, 10)).toEqual({ kind: "pick", pick: { tab: "overrides", value: "fallback" } });
		applySandboxPanelKey(state, "right", current, 10);
		const config = Array.from({ length: 40 }, (_, index) => `line ${index}`);
		const shown = renderSandboxPanel({ state, mode: "regular", override: "strict", config, width: 80, height: 15 }, plain, bold);
		expect(shown).toHaveLength(15);
		// A path longer than the panel is cut across rows, never off the edge.
		const long = renderSandboxPanel({ state: { tab: "config", row: 0, offset: 0 }, mode: "regular", override: "strict", config: [`Writable: /${"a".repeat(120)}`], width: 60, height: 15 }, plain, bold);
		expect(long.join("")).toContain("a".repeat(56));
		expect(long.filter((line) => line.includes("aaa")).length).toBe(3);
		applySandboxPanelKey(state, "down", current, 10);
		expect(state.offset).toBe(1);
		expect(applySandboxPanelKey(state, "select", current, 10)).toBeUndefined();
		expect(applySandboxPanelKey(state, "close", current, 10)).toEqual({ kind: "close" });
		applySandboxPanelKey(state, "right", current, 10);
		expect(state.tab).toBe("mode");
	});

	it("writes a pick into the sandbox block and keeps every other key", () => {
		const file = { model: "x", sandbox: { network: { allowedDomains: ["a.example"] }, enabled: false } };
		expect(applySandboxPick(file, { tab: "mode", value: "auto-allow" })).toEqual({ model: "x", sandbox: { network: { allowedDomains: ["a.example"] }, enabled: true, autoAllowBashIfSandboxed: true } });
		expect(applySandboxPick(file, { tab: "mode", value: "regular" }).sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: false });
		// "No sandbox" withdraws auto-allow, so a project that turns the sandbox on does not inherit it.
		expect(applySandboxPick({ sandbox: { autoAllowBashIfSandboxed: true } }, { tab: "mode", value: "off" }).sandbox).toEqual({ autoAllowBashIfSandboxed: false, enabled: false });
		expect(applySandboxPick({}, { tab: "overrides", value: "strict" })).toEqual({ sandbox: { allowUnsandboxedCommands: false } });
		expect(applySandboxPick({}, { tab: "overrides", value: "fallback" })).toEqual({ sandbox: { allowUnsandboxedCommands: true } });
	});

	it("says what holds now, what waits for a restart and what another file overrides", () => {
		expect(sandboxPickOutcome({ tab: "mode", value: "auto-allow" }, true, AUTO)).toMatch(/^Sandbox with auto-allow.*modes[.]$/);
		expect(sandboxPickOutcome({ tab: "mode", value: "auto-allow" }, false, AUTO)).toContain("turns on at the next start");
		expect(sandboxPickOutcome({ tab: "mode", value: "auto-allow" }, true, ON)).toContain("another settings file turns auto-allow off");
		expect(sandboxPickOutcome({ tab: "mode", value: "regular" }, true, ON)).toBe("Sandbox with regular permissions: every prompt stays.");
		expect(sandboxPickOutcome({ tab: "mode", value: "regular" }, true, AUTO)).toContain("another settings file turns auto-allow on");
		expect(sandboxPickOutcome({ tab: "mode", value: "off" }, true, SANDBOX_OFF)).toBe("No sandbox. The sandbox turns off at the next start.");
		expect(sandboxPickOutcome({ tab: "mode", value: "off" }, true, ON)).toContain("another settings file turns the sandbox on");
		expect(sandboxPickOutcome({ tab: "overrides", value: "fallback" }, true, { ...ON, allowUnsandboxedCommands: false })).toContain("strict sandbox mode stays");
		expect(sandboxPickOutcome({ tab: "overrides", value: "strict" }, true, { ...ON, allowUnsandboxedCommands: false })).toContain("Strict sandbox mode");
	});
});

describe("/doctor and the Linux sandbox's programs", () => {
	const input = { cwd: "/nowhere", env: { PATH: "" }, mcpServers: [], webSearchSettings: {} };

	it("asks for bubblewrap and socat on Linux when the sandbox is on, as an error where it is required", () => {
		const on = checkDependencies({ ...input, platform: "linux", sandbox: { enabled: true, required: false } });
		expect(on.checks.filter((check) => ["bwrap", "socat"].includes(check.name))).toEqual([expect.objectContaining({ found: false, need: "required" }), expect.objectContaining({ found: false, need: "required" })]);
		expect(on.findings.find((finding) => finding.text.includes("command sandbox"))).toMatchObject({ level: "warn", fix: expect.stringContaining("apt install bubblewrap") });
		const required = checkDependencies({ ...input, platform: "linux", sandbox: { enabled: true, required: true } });
		expect(required.findings.find((finding) => finding.text.includes("command sandbox"))).toMatchObject({ level: "error" });
	});

	it("names the kernel's user-namespace restriction when both programs are there and bubblewrap still cannot start", () => {
		const bin = mkdtempSync(join(tmpdir(), "sandbox-doctor-"));
		try {
			for (const name of ["bwrap", "socat"]) writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
			const sandbox = { enabled: true, required: true, usernsRestricted: true };
			const restricted = checkDependencies({ ...input, env: { PATH: bin }, platform: "linux", sandbox });
			expect(restricted.findings.find((entry) => entry.text.includes("user namespaces"))).toMatchObject({ level: "error", fix: expect.stringContaining("apparmor_restrict_unprivileged_userns=0") });
			// A machine without the programs gets the install finding, not this one.
			const missing = checkDependencies({ ...input, platform: "linux", sandbox });
			expect(missing.findings.some((entry) => entry.text.includes("user namespaces"))).toBe(false);
			expect(checkDependencies({ ...input, env: { PATH: bin }, platform: "linux", sandbox: { ...sandbox, usernsRestricted: false } }).findings.some((entry) => entry.text.includes("command sandbox"))).toBe(false);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
		expect(usernsRestricted(() => "1\n")).toBe(true);
		expect(usernsRestricted(() => "0\n")).toBe(false);
		expect(usernsRestricted(() => {
			throw new Error("ENOENT");
		})).toBe(false);
		expect(sandboxProbeFailure("\nbwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n", true)).toMatch(/^bubblewrap could not run a command \(bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\)\. This kernel restricts.*sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
		expect(sandboxProbeFailure("", false)).toBe("bubblewrap could not run a command (no error output)");
	});

	it("says nothing where the sandbox is off, and lists nothing on macOS", () => {
		const off = checkDependencies({ ...input, platform: "linux", sandbox: { enabled: false, required: false } });
		expect(off.findings.some((finding) => finding.text.includes("command sandbox"))).toBe(false);
		expect(off.checks.find((check) => check.name === "bwrap")).toMatchObject({ need: "unused" });
		const mac = checkDependencies({ ...input, platform: "darwin", sandbox: { enabled: true, required: true } });
		expect(mac.checks.some((check) => check.name === "bwrap")).toBe(false);
	});
});

describe("a sandbox turned on where the platform has none", () => {
	const call = { command: "npm test", original: "npm test", disable: false, cwd: "/work", bash: "/bin/bash", id: "call-1" };

	it("refuses the command when the settings require the sandbox, and runs it plainly otherwise", async () => {
		setSandboxForTest({ ...ON, failIfUnavailable: true });
		expect(await sandboxedCommand(call, "win32")).toEqual({ refused: { kind: "unavailable", reason: "this platform has no command sandbox" } });
		setSandboxForTest(ON);
		expect(await sandboxedCommand(call, "win32")).toEqual({ command: "npm test" });
		setSandboxForTest({ ...SANDBOX_OFF, failIfUnavailable: true });
		expect(await sandboxedCommand(call, "win32")).toEqual({ command: "npm test" });
	});
});
