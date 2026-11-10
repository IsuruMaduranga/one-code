/**
 * Which settings file may answer for a project's MCP servers
 * (tools/mcp/trust.ts `readClaudeMcpjsonPolicy`): the approving keys count
 * only from the primary user file; a file in the checkout never approves,
 * checked in or local, tracked or not, and the local file's disable list
 * only tightens (SECURITY-REVIEW-2026-09-23 H4). The rule reads the ladder's
 * roles, so it runs over a test source provider with a whole borrowed family
 * (helpers/settings-files.ts) on any profile. The approval flow itself:
 * mcp-trust.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveMcpServers, readClaudeMcpjsonPolicy } from "../../extensions/tools/mcp/trust.ts";
import { makeMcpTrustDirs, stdio, trustDeps } from "./helpers/mcp-trust.ts";
import { borrowedLadderPaths, type LadderPaths, useBorrowedLadder } from "./helpers/settings-files.ts";

useBorrowedLadder();

let root: string;
let cwd: string;
let home: string;
let storePath: string;
let paths: LadderPaths;

beforeEach(() => {
	({ root, cwd, home, storePath } = makeMcpTrustDirs());
	paths = borrowedLadderPaths(cwd, home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(scope: keyof LadderPaths, settings: object): string {
	mkdirSync(dirname(paths[scope]), { recursive: true });
	writeFileSync(paths[scope], JSON.stringify(settings));
	return paths[scope];
}

const projectServer = (name: string) => stdio(name, join(cwd, ".mcp.json"));
const approveAll = { enableAllProjectMcpServers: true, enabledMcpjsonServers: ["s"] };
const nothing = { enableAll: false, enabled: [], disabled: [] };

async function policy() {
	const read = await readClaudeMcpjsonPolicy(cwd, home);
	return { enableAll: read.enableAll, enabled: [...read.enabled], disabled: [...read.disabled] };
}

/** Whether a headless session connects the project's server `s` without asking. */
async function connectsUnasked(server = projectServer("s")): Promise<boolean> {
	const out = await approveMcpServers([server], new Set(), cwd, home, trustDeps(storePath, { hasUI: false }).deps);
	return out.approved.length > 0;
}

describe("readClaudeMcpjsonPolicy: which file may approve", () => {
	it("reads the approving keys and the disable list from the primary user file", async () => {
		write("user", { enableAllProjectMcpServers: true, enabledMcpjsonServers: ["ok"], disabledMcpjsonServers: ["no"] });
		expect(await policy()).toEqual({ enableAll: true, enabled: ["ok"], disabled: ["no"] });
		expect(await connectsUnasked()).toBe(true);
	});

	it("never reads the repository's checked-in file, for approvals or disables", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		write("project", { ...approveAll, disabledMcpjsonServers: ["x"] });
		expect(await policy()).toEqual(nothing);
		expect(await connectsUnasked()).toBe(false);
	});

	it("takes only the disable list from the local file, beside the user file's approvals", async () => {
		write("user", { enableAllProjectMcpServers: false, enabledMcpjsonServers: ["ok"] });
		write("local", { enabledMcpjsonServers: ["local"], disabledMcpjsonServers: ["nope"] });
		expect(await policy()).toEqual({ enableAll: false, enabled: ["ok"], disabled: ["nope"] });
	});

	it("ignores an untracked local file in a directory that carries its own .git (a copied checkout)", async () => {
		// A tarball of someone's working copy: `.git`, a `.mcp.json`, and their
		// untracked local settings approving everything.
		execFileSync("git", ["init", "-q"], { cwd });
		write("local", approveAll);
		expect(await policy()).toEqual(nothing);
		expect(await connectsUnasked()).toBe(false);
	});

	it("ignores a git-tracked local file (a repository cannot approve its own servers)", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd });
		execFileSync("git", ["config", "user.name", "t"], { cwd });
		const local = write("local", approveAll);
		// -f: a global gitignore may ignore the file; the point is that it is tracked.
		execFileSync("git", ["add", "-f", "--", local], { cwd });
		expect(await policy()).toEqual(nothing);
		expect(await connectsUnasked()).toBe(false);
	});

	it("does not trust a local file outside any git repository, though its disable list still tightens", async () => {
		// An extracted archive or copied folder: no provenance.
		write("local", { ...approveAll, disabledMcpjsonServers: ["b"] });
		expect(await policy()).toEqual({ ...nothing, disabled: ["b"] });
		expect(await connectsUnasked()).toBe(false);
	});

	it("never lets the local file approve servers, its own or .mcp.json's", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		const local = write("local", { enableAllProjectMcpServers: true });
		const out = await approveMcpServers([stdio("own", local), projectServer("shipped")], new Set(), cwd, home, trustDeps(storePath, { hasUI: false }).deps);
		expect(out.approved).toEqual([]);
		expect(out.withheld).toMatchObject([
			{ server: { name: "own" }, reason: "not-approved" },
			{ server: { name: "shipped" }, reason: "not-approved" },
		]);
	});

	it("a local disable withholds a server the user file approved, without a prompt", async () => {
		write("user", { enabledMcpjsonServers: ["yes", "no"] });
		write("local", { disabledMcpjsonServers: ["no"] });
		const d = trustDeps(storePath);
		const out = await approveMcpServers([projectServer("yes"), projectServer("no")], new Set(), cwd, home, d.deps);
		expect(out.approved.map((server) => server.name)).toEqual(["yes"]);
		expect(out.withheld).toMatchObject([{ server: { name: "no" }, reason: "disabled-by-claude-settings" }]);
		expect(d.selections).toEqual([]);
	});

	it("managed policy supplies no approval", async () => {
		write("managed", approveAll);
		expect(await policy()).toEqual(nothing);
	});
});
