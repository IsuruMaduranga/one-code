/**
 * MCP server configuration in Claude Code's format (pure).
 *
 * Sources, lowest to highest precedence:
 *   ~/.claude.json                    (user, global)
 *   <cwd>/.mcp.json                   (project, checked in — walked up to the repo root)
 *   <cwd>/.claude/settings.local.json (project, personal)
 *
 * Every file holds an `mcpServers` object. A stdio server has `command` (plus
 * optional `args`, `env`); a remote one has `url` and optional `type`/`headers`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StdioServer {
	kind: "stdio";
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
	source: string;
}

export interface HttpServer {
	kind: "http";
	name: string;
	url: string;
	headers?: Record<string, string>;
	source: string;
}

export type McpServer = StdioServer | HttpServer;

interface RawServer {
	command?: unknown;
	args?: unknown;
	env?: unknown;
	url?: unknown;
	type?: unknown;
	headers?: unknown;
	disabled?: unknown;
}

function readJson(path: string): { mcpServers?: Record<string, RawServer> } | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, RawServer> };
	} catch {
		return undefined;
	}
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "string") out[key] = item;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Expands $VAR and ${VAR} in a config string, as Claude Code does. */
export function expandEnv(value: string, env: Record<string, string | undefined>): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
		return env[braced ?? bare] ?? "";
	});
}

export function parseServer(
	name: string,
	raw: RawServer,
	source: string,
	env: Record<string, string | undefined>,
): McpServer | undefined {
	if (raw.disabled === true) return undefined;

	if (typeof raw.url === "string" && raw.url.trim()) {
		const headers = asStringRecord(raw.headers);
		return {
			kind: "http",
			name,
			url: expandEnv(raw.url, env),
			headers: headers
				? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expandEnv(v, env)]))
				: undefined,
			source,
		};
	}

	if (typeof raw.command === "string" && raw.command.trim()) {
		const args = Array.isArray(raw.args)
			? raw.args.filter((a): a is string => typeof a === "string").map((a) => expandEnv(a, env))
			: [];
		const rawEnv = asStringRecord(raw.env);
		return {
			kind: "stdio",
			name,
			command: expandEnv(raw.command, env),
			args,
			env: rawEnv ? Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, expandEnv(v, env)])) : undefined,
			source,
		};
	}

	return undefined;
}

/** `.mcp.json` from cwd upward, so a repo-root config applies in subdirectories. */
export function findProjectConfigs(cwd: string): string[] {
	const found: string[] = [];
	let dir = cwd;
	while (true) {
		const candidate = join(dir, ".mcp.json");
		if (existsSync(candidate)) found.push(candidate);
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Nearest last, so it overrides ancestors.
	return found.reverse();
}

export function configPaths(cwd: string, home: string): string[] {
	return [join(home, ".claude.json"), ...findProjectConfigs(cwd), join(cwd, ".claude", "settings.local.json")];
}

export function loadServers(
	cwd: string,
	home: string,
	env: Record<string, string | undefined> = process.env,
): McpServer[] {
	const byName = new Map<string, McpServer>();
	for (const path of configPaths(cwd, home)) {
		const file = readJson(path);
		if (!file?.mcpServers || typeof file.mcpServers !== "object") continue;
		for (const [name, raw] of Object.entries(file.mcpServers)) {
			const server = parseServer(name, raw ?? {}, path, env);
			if (server) byName.set(name, server);
			else byName.delete(name); // an explicit `disabled` entry removes an inherited one
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
