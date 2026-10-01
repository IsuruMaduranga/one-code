import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer, StdioServer } from "../../extensions/mcp/config.ts";
import {
	approveMcpServers,
	CHOICE_ALL,
	CHOICE_NO,
	CHOICE_THESE,
	CHOICE_THIS,
	describeServers,
	hashServerConfig,
	isProjectScopedServer,
	persistApproval,
	promptTitle,
	readClaudeMcpjsonPolicy,
	readStoredApproval,
	resetMcpTrustSessionState,
} from "../../extensions/mcp/trust.ts";

let root: string;
let cwd: string;
let home: string;
let storePath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cc-mcp-trust-"));
	cwd = join(root, "project");
	home = join(root, "home");
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	mkdirSync(join(home, ".claude"), { recursive: true });
	storePath = join(root, "state", "mcp", "project-approvals.json");
	resetMcpTrustSessionState();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const stdio = (name: string, source: string, command = "npx", args = ["-y", `${name}-server`]): McpServer => ({
	kind: "stdio",
	name,
	command,
	args,
	source,
});
const projectServer = (name: string, command?: string) => stdio(name, join(cwd, ".mcp.json"), command);

function deps(opts: { choose?: string | undefined; hasUI?: boolean } = {}) {
	const notices: string[] = [];
	const disabled: string[] = [];
	const selections: string[] = [];
	const choose = "choose" in opts ? opts.choose : CHOICE_THIS;
	return {
		notices,
		disabled,
		selections,
		deps: {
			hasUI: opts.hasUI ?? true,
			select: async (title: string) => {
				selections.push(title);
				return choose;
			},
			notify: (m: string) => {
				notices.push(m);
			},
			disable: (s: McpServer) => {
				disabled.push(s.name);
			},
			storePath,
		},
	};
}

describe("isProjectScopedServer", () => {
	it("gates a project .mcp.json and a checked-in settings.local.json, but not a plugin or the user file", () => {
		const plugins = new Set([join(root, "plugin", ".mcp.json")]);
		expect(isProjectScopedServer(projectServer("a"), plugins)).toBe(true);
		// A repo can ship settings.local.json too, so it is consent-gated (review H1).
		expect(isProjectScopedServer(stdio("l", join(cwd, ".claude", "settings.local.json")), plugins)).toBe(true);
		expect(isProjectScopedServer(stdio("p", join(root, "plugin", ".mcp.json")), plugins)).toBe(false);
		expect(isProjectScopedServer(stdio("u", join(home, ".claude.json")), plugins)).toBe(false);
		// pi's files: the project's is gated like .mcp.json, the user's agent-dir file is not.
		expect(isProjectScopedServer({ ...stdio("pp", join(cwd, ".pi", "mcp.json")), piOrigin: "project" }, plugins)).toBe(true);
		expect(isProjectScopedServer({ ...stdio("pu", join(home, ".pi", "agent", "mcp.json")), piOrigin: "user" }, plugins)).toBe(false);
	});
});

describe("hashServerConfig", () => {
	it("changes with the command and ignores the source path", () => {
		expect(hashServerConfig(projectServer("a"))).toBe(hashServerConfig(stdio("a", "/elsewhere/.mcp.json")));
		expect(hashServerConfig(projectServer("a", "npx"))).not.toBe(hashServerConfig(projectServer("a", "curl")));
	});
});

describe("readClaudeMcpjsonPolicy", () => {
	it("reads approvals from the user scope, disables from local too, never the checked-in project settings.json", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
		expect((await readClaudeMcpjsonPolicy(cwd, home)).enableAll).toBe(false);
		writeFileSync(
			join(cwd, ".claude", "settings.local.json"),
			JSON.stringify({ enabledMcpjsonServers: ["local"], disabledMcpjsonServers: ["nope"] }),
		);
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: false, enabledMcpjsonServers: ["ok"] }));
		const policy = await readClaudeMcpjsonPolicy(cwd, home);
		expect([...policy.enabled]).toEqual(["ok"]);
		expect([...policy.disabled]).toEqual(["nope"]);
	});

	it("ignores an untracked settings.local.json in a directory that carries its own .git (a copied checkout)", async () => {
		// A tarball of someone's working copy: `.git`, a `.mcp.json`, and their
		// untracked settings.local.json approving everything.
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["s"] }));
		const policy = await readClaudeMcpjsonPolicy(cwd, home);
		expect(policy.enableAll).toBe(false);
		expect([...policy.enabled]).toEqual([]);
		const d = deps({ hasUI: false });
		const out = await approveMcpServers([projectServer("s")], new Set(), cwd, home, d.deps);
		expect(out.approved).toEqual([]);
		expect(out.withheld[0].reason).toBe("not-approved");
	});

	it("ignores a git-tracked settings.local.json (a repo cannot approve its own servers)", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd });
		execFileSync("git", ["config", "user.name", "t"], { cwd });
		const local = join(cwd, ".claude", "settings.local.json");
		writeFileSync(local, JSON.stringify({ enableAllProjectMcpServers: true }));
		// -f: a global gitignore may ignore settings.local.json; the point is that it is tracked.
		execFileSync("git", ["add", "-f", "--", local], { cwd });
		expect((await readClaudeMcpjsonPolicy(cwd, home)).enableAll).toBe(false);
	});
});

describe("approveMcpServers", () => {
	it("lets non-project servers through without asking", async () => {
		const d = deps();
		const user = stdio("u", join(home, ".claude.json"));
		const out = await approveMcpServers([user], new Set(), cwd, home, d.deps);
		expect(out.approved).toEqual([user]);
		expect(d.selections).toEqual([]);
	});

	it("prompts once for all new project servers and persists 'use these'", async () => {
		const d = deps({ choose: CHOICE_THESE });
		const a = projectServer("a");
		const b = projectServer("b");
		const out = await approveMcpServers([a, b], new Set(), cwd, home, d.deps);
		expect(out.approved.map((s) => s.name)).toEqual(["a", "b"]);
		expect(d.selections).toHaveLength(1);
		expect(readStoredApproval(cwd, storePath)?.servers.a.configHash).toBe(hashServerConfig(a));
		// Next session: no prompt.
		resetMcpTrustSessionState();
		const again = await approveMcpServers([a, b], new Set(), cwd, home, d.deps);
		expect(again.approved).toHaveLength(2);
		expect(d.selections).toHaveLength(1);
	});

	it("asks for pi's project servers by their file, and Claude Code's answers do not approve them", async () => {
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
		const d = deps();
		const pi: McpServer = { ...stdio("pp", join(cwd, ".pi", "mcp.json")), piOrigin: "project" };
		const out = await approveMcpServers([pi, projectServer("a")], new Set(), cwd, home, d.deps);
		expect(out.approved.map((s) => s.name).sort()).toEqual(["a", "pp"]);
		expect(d.selections).toHaveLength(1);
		expect(d.selections[0].split("\n")[0]).toBe("New MCP server found in .pi/mcp.json: pp");
	});

	it("puts a stdio cwd into the approval hash and the dialog, and keeps hashes without one unchanged", () => {
		const plain = projectServer("a") as StdioServer;
		expect(hashServerConfig({ ...plain, cwd: "/elsewhere" })).not.toBe(hashServerConfig(plain));
		expect(hashServerConfig({ ...plain, cwd: undefined })).toBe(hashServerConfig(plain));
		expect(describeServers([{ ...plain, cwd: "/elsewhere" }])).toContain("cwd: /elsewhere");
	});

	it("re-prompts when an approved server's command changes", async () => {
		persistApproval(cwd, projectServer("a", "npx"), storePath);
		const d = deps();
		await approveMcpServers([projectServer("a", "curl")], new Set(), cwd, home, d.deps);
		expect(d.selections).toHaveLength(1);
	});

	it("'all future' approves servers added later without a prompt", async () => {
		const d = deps({ choose: CHOICE_ALL });
		await approveMcpServers([projectServer("a")], new Set(), cwd, home, d.deps);
		resetMcpTrustSessionState();
		const out = await approveMcpServers([projectServer("new")], new Set(), cwd, home, d.deps);
		expect(out.approved.map((s) => s.name)).toEqual(["new"]);
		expect(d.selections).toHaveLength(1);
	});

	it("'No' withholds, persists a disable, and is remembered for the session", async () => {
		const d = deps({ choose: CHOICE_NO });
		const a = projectServer("a");
		const out = await approveMcpServers([a], new Set(), cwd, home, d.deps);
		expect(out.approved).toEqual([]);
		expect(out.withheld[0]).toMatchObject({ server: a, reason: "declined" });
		expect(d.disabled).toEqual(["a"]);
		const again = await approveMcpServers([a], new Set(), cwd, home, d.deps);
		expect(again.withheld).toHaveLength(1);
		expect(d.selections).toHaveLength(1);
	});

	it("Escape declines for this session only (no disable persisted)", async () => {
		const d = deps({ choose: undefined });
		const out = await approveMcpServers([projectServer("a")], new Set(), cwd, home, d.deps);
		expect(out.withheld[0].reason).toBe("declined");
		expect(d.disabled).toEqual([]);
		expect(readStoredApproval(cwd, storePath)).toBeUndefined();
	});

	it("without a UI withholds unapproved project servers and says so", async () => {
		const d = deps({ hasUI: false });
		const out = await approveMcpServers([projectServer("a")], new Set(), cwd, home, d.deps);
		expect(out.withheld[0].reason).toBe("not-approved");
		expect(d.notices[0]).toMatch(/not yet approved and no UI/);
		expect(d.notices[0]).toMatch(/set enabledMcpjsonServers/);
		expect(d.selections).toEqual([]);
	});

	it("without a UI does not suggest enabledMcpjsonServers for a server defined in settings.local.json", async () => {
		const d = deps({ hasUI: false });
		const out = await approveMcpServers([stdio("l", join(cwd, ".claude", "settings.local.json"))], new Set(), cwd, home, d.deps);
		expect(out.withheld[0].reason).toBe("not-approved");
		expect(d.notices[0]).toMatch(/from \.claude\/settings\.local\.json \(l\)/);
		expect(d.notices[0]).not.toMatch(/enabledMcpjsonServers/);
	});

	it("honours Claude Code's own answers read-only", async () => {
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["yes"] }));
		writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ disabledMcpjsonServers: ["no"] }));
		const d = deps();
		const out = await approveMcpServers([projectServer("yes"), projectServer("no")], new Set(), cwd, home, d.deps);
		expect(out.approved.map((s) => s.name)).toEqual(["yes"]);
		expect(out.withheld[0]).toMatchObject({ reason: "disabled-by-claude-settings" });
		expect(d.selections).toEqual([]);
	});

	it("does not trust a settings.local.json outside any git repository (SECURITY-REVIEW-2026-09-23 H4)", async () => {
		// An extracted archive or copied folder: no provenance, so its approving
		// keys are ignored — but its disable list still tightens.
		writeFileSync(
			join(cwd, ".claude", "settings.local.json"),
			JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["b"] }),
		);
		const policy = await readClaudeMcpjsonPolicy(cwd, home);
		expect(policy.enableAll).toBe(false);
		expect([...policy.enabled]).toEqual([]);
		expect([...policy.disabled]).toEqual(["b"]);
		const d = deps();
		const out = await approveMcpServers([projectServer("a")], new Set(), cwd, home, { ...d.deps, hasUI: false });
		expect(out.approved).toEqual([]);
		expect(out.withheld[0].reason).toBe("not-approved");
	});

	it("never lets settings.local.json approve servers, its own or .mcp.json's (SECURITY-REVIEW-2026-09-23 H4)", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		const local = join(cwd, ".claude", "settings.local.json");
		writeFileSync(local, JSON.stringify({ enableAllProjectMcpServers: true }));
		const d = deps();
		const out = await approveMcpServers([stdio("own", local), projectServer("shipped")], new Set(), cwd, home, { ...d.deps, hasUI: false });
		expect(out.approved).toEqual([]);
		expect(out.withheld).toMatchObject([
			{ server: { name: "own" }, reason: "not-approved" },
			{ server: { name: "shipped" }, reason: "not-approved" },
		]);
	});

	it("still lets the user's own settings approve every .mcp.json server", async () => {
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
		const d = deps({ hasUI: false });
		const out = await approveMcpServers([projectServer("shipped")], new Set(), cwd, home, d.deps);
		expect(out.approved.map((s) => s.name)).toEqual(["shipped"]);
	});

	it("uses Claude Code's dialog titles", () => {
		expect(promptTitle(["a"])).toBe("New MCP server found in .mcp.json: a");
		expect(promptTitle(["a", "b"])).toBe("2 new MCP servers found in .mcp.json");
	});
});

describe("describeServers", () => {
	it("shows the command in full and names referenced env vars and header names (review M5)", () => {
		const server: McpServer = {
			kind: "http",
			name: "docs",
			url: "https://evil.example/mcp",
			headers: { Authorization: "Bearer secretvalue" },
			source: join(cwd, ".mcp.json"),
			referencedEnv: ["ANTHROPIC_API_KEY"],
		};
		const text = describeServers([server]);
		expect(text).toContain("https://evil.example/mcp");
		expect(text).toContain("$ANTHROPIC_API_KEY");
		expect(text).toContain("Authorization");
		// The secret value is never echoed.
		expect(text).not.toContain("secretvalue");
	});

	it("names every env key a stdio server sets, and shows the values that change what runs", () => {
		const server: McpServer = {
			kind: "stdio",
			name: "docs",
			command: "npx",
			args: ["-y", "some-mcp"],
			env: { NODE_OPTIONS: "--require ./.hidden/x.js", API_TOKEN: "tok-secret", dyld_insert_libraries: "/tmp/x.dylib", npm_config_registry: "https://evil.example" },
			source: join(cwd, ".mcp.json"),
		};
		const text = describeServers([server]);
		expect(text).toContain("docs: npx -y some-mcp");
		expect(text).toContain('NODE_OPTIONS="--require ./.hidden/x.js"');
		expect(text).toContain('dyld_insert_libraries="/tmp/x.dylib"');
		expect(text).toContain('npm_config_registry="https://evil.example"');
		expect(text).toContain("API_TOKEN");
		expect(text).not.toContain("tok-secret");
	});

	it("points a preview too long to show at the file the hidden servers come from", () => {
		const many = (source: string, extra: Partial<McpServer> = {}) =>
			Array.from({ length: 40 }, (_, i) => ({ ...stdio(`s${i}`, source, "npx", ["-y", "x".repeat(200)]), ...extra }) as McpServer);
		expect(describeServers(many(join(cwd, ".pi", "mcp.json"), { piOrigin: "project" }))).toMatch(/more not shown — review \.pi\/mcp\.json before approving$/);
		expect(describeServers(many(join(cwd, ".mcp.json")))).toMatch(/more not shown — review \.mcp\.json before approving$/);
	});
});
