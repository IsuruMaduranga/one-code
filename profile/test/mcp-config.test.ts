/**
 * The MCP config files One Code's source provider adds (Claude Code's
 * `~/.claude.json`, `.mcp.json` and `.claude/settings.local.json`), as the
 * base's loadServers merges them after pi's own `mcp.json` files. The base's
 * merge of pi's files and registered servers: test/unit/mcp.test.ts.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadServers } from "../../extensions/mcp/config.ts";
import { makeMcpConfigDirs, piMcpConfigs, writeMcpServers as write } from "../../test/unit/helpers/mcp-config.ts";

describe("loadServers with Claude Code's files", () => {
	let root: string;
	let home: string;
	let project: string;

	beforeEach(() => {
		({ root, home, project } = makeMcpConfigDirs());
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("merges user and project configs, project winning by name", () => {
		write(join(home, ".claude.json"), { a: { command: "user-a" }, shared: { command: "user-shared" } });
		write(join(project, ".mcp.json"), { b: { command: "proj-b" }, shared: { command: "proj-shared" } });
		const servers = loadServers(project, home, {});
		expect(servers.map((s) => s.name)).toEqual(["a", "b", "shared"]);
		expect(servers.find((s) => s.name === "shared")).toMatchObject({ command: "proj-shared" });
	});

	it("lets settings.local.json override the project config", () => {
		write(join(project, ".mcp.json"), { x: { command: "shared" } });
		write(join(project, ".claude", "settings.local.json"), { x: { command: "personal" } });
		expect(loadServers(project, home, {})[0]).toMatchObject({ command: "personal" });
	});

	describe("next to pi's own mcp.json files", () => {
		const piConfigs = () => piMcpConfigs(home, project);

		it("lets a Claude Code file win a name, with a note", () => {
			const { user } = piConfigs();
			write(user, { shared: { command: "from-pi" } });
			write(join(project, ".mcp.json"), { shared: { command: "from-claude" } });
			const notes: string[] = [];
			const servers = loadServers(project, home, {}, [], { piConfigs: piConfigs(), onNote: (m) => notes.push(m) });
			expect(servers).toEqual([expect.objectContaining({ name: "shared", command: "from-claude" })]);
			expect(servers[0]).not.toHaveProperty("piOrigin");
			expect(notes).toEqual([`MCP server "shared" in ${user} is overridden by the one in ${join(project, ".mcp.json")}.`]);
		});

		it("overrides an identical server without a note", () => {
			write(piConfigs().user, { shared: { command: "same", args: ["-y"] } });
			write(join(project, ".mcp.json"), { shared: { command: "same", args: ["-y"] } });
			const notes: string[] = [];
			const servers = loadServers(project, home, {}, [], { piConfigs: piConfigs(), onNote: (m) => notes.push(m) });
			expect(servers).toEqual([expect.objectContaining({ name: "shared", source: join(project, ".mcp.json") })]);
			expect(notes).toEqual([]);
		});

		it("ignores cwd and enabled outside pi's files", () => {
			write(join(project, ".mcp.json"), { plain: { command: "x", cwd: "elsewhere", enabled: false } });
			const servers = loadServers(project, home, {}, [], { piConfigs: piConfigs() });
			expect(servers).toEqual([expect.objectContaining({ name: "plain", command: "x" })]);
			expect(servers[0]).not.toHaveProperty("cwd");
		});
	});

	it("lets a disabled entry remove an inherited server", () => {
		write(join(home, ".claude.json"), { gone: { command: "user" } });
		write(join(project, ".mcp.json"), { gone: { command: "user", disabled: true } });
		expect(loadServers(project, home, {})).toEqual([]);
	});

	it("finds .mcp.json in an ancestor directory", () => {
		const nested = join(project, "packages", "app");
		mkdirSync(nested, { recursive: true });
		write(join(project, ".mcp.json"), { root: { command: "from-root" } });
		expect(loadServers(nested, home, {}).map((s) => s.name)).toEqual(["root"]);
	});

	it("tolerates missing and malformed files", () => {
		writeFileSync(join(project, ".mcp.json"), "{ not json");
		expect(loadServers(project, home, {})).toEqual([]);
	});
});
