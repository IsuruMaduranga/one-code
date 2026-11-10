/**
 * MCP project-server approval with One Code's source provider on: Claude
 * Code's own settings files are the ones that answer (`enabledMcpjsonServers`,
 * `disabledMcpjsonServers`, `enableAllProjectMcpServers`). Which file of a
 * ladder may approve, and that a checkout's file never does:
 * test/unit/mcp-trust-settings.test.ts. The base's approval flow:
 * test/unit/mcp-trust.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveMcpServers, readClaudeMcpjsonPolicy } from "../../extensions/tools/mcp/trust.ts";
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

describe("MCP approval from Claude Code's settings files", () => {
	it("reads approvals from ~/.claude/settings.json, disables from .claude/settings.local.json too, never the checked-in .claude/settings.json", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
		expect((await readClaudeMcpjsonPolicy(cwd, home)).enableAll).toBe(false);
		writeFileSync(
			join(cwd, ".claude", "settings.local.json"),
			JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["local"], disabledMcpjsonServers: ["nope"] }),
		);
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: false, enabledMcpjsonServers: ["ok"] }));
		const policy = await readClaudeMcpjsonPolicy(cwd, home);
		expect(policy.enableAll).toBe(false);
		expect([...policy.enabled]).toEqual(["ok"]);
		expect([...policy.disabled]).toEqual(["nope"]);
	});

	it("honours Claude Code's own answers read-only", async () => {
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["yes"] }));
		writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ disabledMcpjsonServers: ["no"] }));
		const d = trustDeps(storePath);
		const out = await approveMcpServers([projectServer("yes"), projectServer("no")], new Set(), cwd, home, d.deps);
		expect(out.approved.map((s) => s.name)).toEqual(["yes"]);
		expect(out.withheld[0]).toMatchObject({ reason: "disabled-by-claude-settings" });
		expect(d.selections).toEqual([]);
	});
});
