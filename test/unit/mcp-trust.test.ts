import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "../../extensions/mcp/config.ts";
import {
	approveMcpServers,
	CHOICE_ALL,
	CHOICE_NO,
	CHOICE_THESE,
	CHOICE_THIS,
	hashServerConfig,
	isProjectMcpJson,
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

describe("isProjectMcpJson", () => {
	it("is true only for a non-plugin .mcp.json", () => {
		const plugins = new Set([join(root, "plugin", ".mcp.json")]);
		expect(isProjectMcpJson(projectServer("a"), plugins)).toBe(true);
		expect(isProjectMcpJson(stdio("p", join(root, "plugin", ".mcp.json")), plugins)).toBe(false);
		expect(isProjectMcpJson(stdio("u", join(home, ".claude.json")), plugins)).toBe(false);
		expect(isProjectMcpJson(stdio("l", join(cwd, ".claude", "settings.local.json")), plugins)).toBe(false);
	});
});

describe("hashServerConfig", () => {
	it("changes with the command and ignores the source path", () => {
		expect(hashServerConfig(projectServer("a"))).toBe(hashServerConfig(stdio("a", "/elsewhere/.mcp.json")));
		expect(hashServerConfig(projectServer("a", "npx"))).not.toBe(hashServerConfig(projectServer("a", "curl")));
	});
});

describe("readClaudeMcpjsonPolicy", () => {
	it("reads user and local scopes, never the checked-in project settings.json", () => {
		writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
		expect(readClaudeMcpjsonPolicy(cwd, home).enableAll).toBe(false);
		writeFileSync(
			join(cwd, ".claude", "settings.local.json"),
			JSON.stringify({ enabledMcpjsonServers: ["ok"], disabledMcpjsonServers: ["nope"] }),
		);
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: false }));
		const policy = readClaudeMcpjsonPolicy(cwd, home);
		expect([...policy.enabled]).toEqual(["ok"]);
		expect([...policy.disabled]).toEqual(["nope"]);
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
		expect(d.selections).toEqual([]);
	});

	it("honours Claude Code's own answers read-only", async () => {
		writeFileSync(
			join(cwd, ".claude", "settings.local.json"),
			JSON.stringify({ enabledMcpjsonServers: ["yes"], disabledMcpjsonServers: ["no"] }),
		);
		const d = deps();
		const out = await approveMcpServers([projectServer("yes"), projectServer("no")], new Set(), cwd, home, d.deps);
		expect(out.approved.map((s) => s.name)).toEqual(["yes"]);
		expect(out.withheld[0]).toMatchObject({ reason: "disabled-by-claude-settings" });
		expect(d.selections).toEqual([]);
	});

	it("uses Claude Code's dialog titles", () => {
		expect(promptTitle(["a"])).toBe("New MCP server found in .mcp.json: a");
		expect(promptTitle(["a", "b"])).toBe("2 new MCP servers found in .mcp.json");
	});
});
