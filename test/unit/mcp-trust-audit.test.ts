import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServer } from "../../extensions/mcp/config.ts";
import { describeServers, reconnectRefusal } from "../../extensions/mcp/trust.ts";
import { decide, parseRule, parseRules, ruleCoversTool } from "../../extensions/permissions/matcher.ts";

describe("pi MCP working-directory variables", () => {
	it("withholds a server whose working-directory variable is unset", () => {
		const cwd = process.cwd();
		const server = parseServer("local", { command: "server", cwd: "${MCP_WORK_DIR}" }, join(cwd, ".pi", "mcp.json"), {}, { home: cwd, cwd });
		expect(server?.missingEnv).toEqual(["MCP_WORK_DIR"]);
		expect(reconnectRefusal(server!)).toContain("MCP_WORK_DIR");
	});

	it("names a working-directory variable in the consent preview after expansion", () => {
		const cwd = process.cwd();
		const server = parseServer("local", { command: "server", cwd: "${MCP_WORK_DIR}" }, join(cwd, ".pi", "mcp.json"), { MCP_WORK_DIR: "service" }, { home: cwd, cwd });
		expect(server?.missingEnv).toBeUndefined();
		expect(server?.referencedEnv).toEqual(["MCP_WORK_DIR"]);
		expect(describeServers([server!])).toContain("uses $MCP_WORK_DIR");
	});

	it("does not inspect cwd ignored outside pi-format configuration", () => {
		const server = parseServer("local", { command: "server", cwd: "${MCP_WORK_DIR}" }, ".mcp.json", {});
		expect(server?.missingEnv).toBeUndefined();
		expect(server?.referencedEnv).toBeUndefined();
	});
});

describe("MCP server wildcard permission rules", () => {
	it("parses Claude Code's server wildcard spelling", () => {
		expect(parseRule("mcp__github__*")).toEqual({ raw: "mcp__github__*", tool: "mcp__github__*", pattern: undefined });
	});

	it.each(["github", "github__enterprise"])("enforces a wildcard deny before an exact allow for %s", (server) => {
		expect(decide({
			toolName: `mcp__${server}__delete_repo`,
			subject: "",
			cwd: process.cwd(),
			mode: "default",
			deny: parseRules([`mcp__${server}__*`]),
			ask: [],
			allow: parseRules([`mcp__${server}__delete_repo`]),
		})).toMatchObject({ decision: "deny", cause: "rule" });
	});

	it("matches only tools on the named server", () => {
		expect(ruleCoversTool("mcp__github__*", "mcp__github__read_issue")).toBe(true);
		expect(ruleCoversTool("mcp__github__*", "mcp__github-other__read_issue")).toBe(false);
		expect(ruleCoversTool("mcp__github__*", "mcp__gitlab__read_issue")).toBe(false);
		expect(ruleCoversTool("mcp__github__*", "read")).toBe(false);
	});

	it("keeps exact tool rules exact and rejects wildcard spellings outside MCP", () => {
		expect(ruleCoversTool("mcp__github__read_issue", "mcp__github__read_issue_details")).toBe(false);
		for (const rule of ["Bash*", "Bash__*", "mcp__*", "mcp__github__read*", "mcp__github__**"]) {
			expect(parseRule(rule), rule).toBeUndefined();
		}
	});
});
