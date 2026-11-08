/**
 * MCP project-server approval with One Code's source provider on: Claude
 * Code's settings files answer (`enabledMcpjsonServers`,
 * `disabledMcpjsonServers`, `enableAllProjectMcpServers`), and a
 * `.claude/settings.local.json` in the checkout only ever tightens, whatever
 * git says about it. The base's approval flow: test/unit/mcp-trust.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveMcpServers, readClaudeMcpjsonPolicy } from "../../extensions/mcp/trust.ts";
import { makeMcpTrustDirs, stdio, trustDeps } from "../../test/unit/helpers/mcp-trust.ts";

let root: string;
let cwd: string;
let home: string;
let storePath: string;

beforeEach(() => {
	({ root, cwd, home, storePath } = makeMcpTrustDirs());
	for (const dir of [cwd, home]) mkdirSync(join(dir, ".claude"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const projectServer = (name: string, command?: string) => stdio(name, join(cwd, ".mcp.json"), command);
const deps = (opts?: Parameters<typeof trustDeps>[1]) => trustDeps(storePath, opts);

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

describe("approveMcpServers with Claude Code's settings", () => {
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
});
