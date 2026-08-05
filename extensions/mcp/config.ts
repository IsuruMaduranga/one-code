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
	/** Config referenced these environment variables and they are not set. */
	missingEnv?: string[];
}

export interface HttpServer {
	kind: "http";
	name: string;
	url: string;
	headers?: Record<string, string>;
	source: string;
	/** Config referenced these environment variables and they are not set. */
	missingEnv?: string[];
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

function readJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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

/**
 * Variables a value references that are not set. Expanding them to "" produces
 * configuration that looks valid and fails confusingly at the server — a real
 * example being `Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"`
 * becoming `"Bearer "`, which the endpoint rejects as a badly formatted header.
 */
export function missingEnvVars(value: string, env: Record<string, string | undefined>): string[] {
	const missing: string[] = [];
	const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
	let match = pattern.exec(value);
	while (match) {
		const name = match[1] ?? match[2];
		if (!env[name]) missing.push(name);
		match = pattern.exec(value);
	}
	return [...new Set(missing)];
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
		const missing = [
			...missingEnvVars(raw.url, env),
			...Object.values(headers ?? {}).flatMap((value) => missingEnvVars(value, env)),
		];
		return {
			kind: "http",
			name,
			url: expandEnv(raw.url, env),
			headers: headers
				? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expandEnv(v, env)]))
				: undefined,
			source,
			missingEnv: missing.length > 0 ? [...new Set(missing)] : undefined,
		};
	}

	if (typeof raw.command === "string" && raw.command.trim()) {
		const args = Array.isArray(raw.args)
			? raw.args.filter((a): a is string => typeof a === "string").map((a) => expandEnv(a, env))
			: [];
		const rawEnv = asStringRecord(raw.env);
		const missing = [
			...missingEnvVars(raw.command, env),
			...(Array.isArray(raw.args) ? raw.args : [])
				.filter((a): a is string => typeof a === "string")
				.flatMap((a) => missingEnvVars(a, env)),
			...Object.values(rawEnv ?? {}).flatMap((value) => missingEnvVars(value, env)),
		];
		return {
			kind: "stdio",
			name,
			command: expandEnv(raw.command, env),
			args,
			env: rawEnv ? Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, expandEnv(v, env)])) : undefined,
			source,
			missingEnv: missing.length > 0 ? [...new Set(missing)] : undefined,
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

/**
 * A plugin's `.mcp.json` is a **bare** server map with no `mcpServers` wrapper,
 * unlike a project's. Accept either shape.
 */
function serverMapOf(file: Record<string, unknown> | undefined): Record<string, RawServer> | undefined {
	if (!file || typeof file !== "object") return undefined;
	const wrapped = (file as { mcpServers?: unknown }).mcpServers;
	if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
		return wrapped as Record<string, RawServer>;
	}
	const looksLikeServerMap = Object.values(file).every(
		(value) => value && typeof value === "object" && !Array.isArray(value),
	);
	return looksLikeServerMap ? (file as Record<string, RawServer>) : undefined;
}

export function loadServers(
	cwd: string,
	home: string,
	env: Record<string, string | undefined> = process.env,
	extraPaths: string[] = [],
): McpServer[] {
	const byName = new Map<string, McpServer>();
	// Plugin configs come first so project and user files can override them.
	for (const path of [...extraPaths, ...configPaths(cwd, home)]) {
		const file = readJson(path) as Record<string, unknown> | undefined;
		const servers = serverMapOf(file);
		if (!servers) continue;
		for (const [name, raw] of Object.entries(servers)) {
			const server = parseServer(name, raw ?? {}, path, env);
			if (server) byName.set(name, server);
			else byName.delete(name); // an explicit `disabled` entry removes an inherited one
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
