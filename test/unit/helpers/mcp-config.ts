/**
 * MCP config files for the loadServers tests (mcp and One Code's mcp-config):
 * a home and a project root under one temp folder, and writers for the
 * config files the base and a source provider read.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Makes a home and a project under a fresh temp root; a `.git` marks the project root, so the `.mcp.json` walk stops there. */
export function makeMcpConfigDirs(): { root: string; home: string; project: string } {
	const root = mkdtempSync(join(tmpdir(), "cc-mcp-"));
	const home = join(root, "home");
	const project = join(root, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(join(project, ".claude"), { recursive: true });
	mkdirSync(join(project, ".git"), { recursive: true });
	return { root, home, project };
}

/** Writes `servers` as the `mcpServers` of the config file at `path`. */
export function writeMcpServers(path: string, servers: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ mcpServers: servers }));
}

/** pi's own user and project `mcp.json` files for `home` and `project`. */
export function piMcpConfigs(home: string, project: string): { user: string; project: string } {
	return { user: join(home, ".pi", "agent", "mcp.json"), project: join(project, ".pi", "mcp.json") };
}
