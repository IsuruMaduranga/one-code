/**
 * MCP server configuration in Claude Code's format (pure).
 *
 * Sources, lowest to highest precedence:
 *   plugins' .mcp.json                (bare server maps)
 *   pi.registerMcpServer()            (servers other pi extensions register, pi 0.99+)
 *   <agentDir>/mcp.json               (pi's own user file, ~/.pi/agent/mcp.json)
 *   <cwd>/.pi/mcp.json                (pi's own project file)
 *   ~/.claude.json                    (user, global)
 *   <cwd>/.mcp.json                   (project, checked in — walked up to the repo root)
 *   <cwd>/.claude/settings.local.json (project, personal)
 *
 * Independent mode (lib/config-mode.ts) reads none of the three Claude Code
 * files: plugins, registered servers and pi's two files only.
 *
 * Every file holds an `mcpServers` object. A stdio server has `command` (plus
 * optional `args`, `env`); a remote one has `url` and optional `type`/`headers`.
 *
 * pi's two files are read because One Code's `/mcp` replaces pi 0.99's
 * built-in MCP, which would otherwise have read them (decisions/mcp.md). Their
 * format is pi's: `enabled: false` turns a server off, a stdio server may set
 * `cwd` (relative to the session directory), and a leading `~/` in `command`,
 * an argument or `cwd` names the home directory. A server with a `!command`
 * value in `env` or `headers` is skipped with a note: running a shell command
 * from a config file to build a credential is not supported. pi's
 * `oauth`/`auth` settings, `exposure`, `timeout` and `description` are
 * ignored. A Claude Code file's server of the same name wins, with a note.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { claudeSourcesOn } from "../lib/config-mode.ts";
import { claudeJsonPath, expandTilde } from "../lib/paths.ts";
import { hashServerConfig } from "./trust.ts";

export interface StdioServer {
	kind: "stdio";
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
	/** Working directory (pi's `mcp.json` only); the session's directory when absent. */
	cwd?: string;
	source: string;
	/** Set for a server read in pi's format: which of pi's sources defined it. */
	piOrigin?: PiOrigin;
	/** Config referenced these environment variables and they are not set. */
	missingEnv?: string[];
	/** Every env var the config references (set or not), for the consent dialog — values are expanded away by parse time. */
	referencedEnv?: string[];
}

export interface HttpServer {
	kind: "http";
	name: string;
	url: string;
	headers?: Record<string, string>;
	source: string;
	piOrigin?: PiOrigin;
	/** Config referenced these environment variables and they are not set. */
	missingEnv?: string[];
	/** Every env var the config references (set or not), for the consent dialog — values are expanded away by parse time. */
	referencedEnv?: string[];
}

export type McpServer = StdioServer | HttpServer;

/** pi's user `mcp.json`, its project `mcp.json`, or an extension's `pi.registerMcpServer()`. */
export type PiOrigin = "user" | "project" | "extension";

interface RawServer {
	command?: unknown;
	args?: unknown;
	env?: unknown;
	url?: unknown;
	type?: unknown;
	headers?: unknown;
	disabled?: unknown;
	/** pi's `mcp.json`: `false` keeps the entry without connecting. */
	enabled?: unknown;
	/** pi's `mcp.json`: a stdio server's working directory. */
	cwd?: unknown;
}

/** How to read a server from one of pi's own `mcp.json` files. */
export interface PiFormat {
	home: string;
	/** The session directory a relative `cwd` resolves against. */
	cwd: string;
}

/**
 * Why a pi-format server cannot be loaded, or undefined: a `!command` value
 * in `env` or `headers` (pi runs it in a shell to build the value).
 */
export function piFormatProblem(raw: RawServer): string | undefined {
	const values = [...Object.values(asStringRecord(raw.env) ?? {}), ...Object.values(asStringRecord(raw.headers) ?? {})];
	return values.some((value) => value.startsWith("!")) ? "a `!command` value in env or headers is not supported" : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "string") out[key] = item;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** `$VAR` and `${VAR}` references. A string source (not a shared object) so each use gets a fresh, unshared lastIndex. */
const ENV_VAR_SOURCE = "\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}|\\$([A-Za-z_][A-Za-z0-9_]*)";

/** Every env var name a value references, in order (with duplicates). The one scanner the others build on. */
function envVarNames(value: string): string[] {
	const names: string[] = [];
	const pattern = new RegExp(ENV_VAR_SOURCE, "g");
	let match = pattern.exec(value);
	while (match) {
		names.push(match[1] ?? match[2]);
		match = pattern.exec(value);
	}
	return names;
}

/** Expands $VAR and ${VAR} in a config string, as Claude Code does. */
export function expandEnv(value: string, env: Record<string, string | undefined>): string {
	return value.replace(new RegExp(ENV_VAR_SOURCE, "g"), (_match, braced, bare) => env[braced ?? bare] ?? "");
}

/**
 * Variables a value references that are not set. Expanding them to "" produces
 * configuration that looks valid and fails confusingly at the server — a real
 * example being `Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"`
 * becoming `"Bearer "`, which the endpoint rejects as a badly formatted header.
 */
export function missingEnvVars(value: string, env: Record<string, string | undefined>): string[] {
	return [...new Set(envVarNames(value).filter((name) => !env[name]))];
}

/** Every env var a value references, set or not — for the consent dialog (values are gone after expandEnv). */
export function referencedEnvVars(...values: string[]): string[] {
	return [...new Set(values.flatMap(envVarNames))];
}

export function parseServer(
	name: string,
	raw: RawServer,
	source: string,
	env: Record<string, string | undefined>,
	pi?: PiFormat,
): McpServer | undefined {
	if (raw.disabled === true) return undefined;
	if (pi && raw.enabled === false) return undefined;
	const home = (value: string) => (pi ? expandTilde(value, pi.home) : value);

	if (typeof raw.url === "string" && raw.url.trim()) {
		const headers = asStringRecord(raw.headers);
		const missing = [
			...missingEnvVars(raw.url, env),
			...Object.values(headers ?? {}).flatMap((value) => missingEnvVars(value, env)),
		];
		const referenced = referencedEnvVars(raw.url, ...Object.values(headers ?? {}));
		return {
			kind: "http",
			name,
			url: expandEnv(raw.url, env),
			headers: headers
				? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expandEnv(v, env)]))
				: undefined,
			source,
			missingEnv: missing.length > 0 ? [...new Set(missing)] : undefined,
			referencedEnv: referenced.length > 0 ? referenced : undefined,
		};
	}

	if (typeof raw.command === "string" && raw.command.trim()) {
		const args = Array.isArray(raw.args)
			? raw.args.filter((a): a is string => typeof a === "string").map((a) => home(expandEnv(a, env)))
			: [];
		const cwd = pi && typeof raw.cwd === "string" && raw.cwd.trim() ? resolve(pi.cwd, home(expandEnv(raw.cwd, env))) : undefined;
		const rawEnv = asStringRecord(raw.env);
		const missing = [
			...missingEnvVars(raw.command, env),
			...(Array.isArray(raw.args) ? raw.args : [])
				.filter((a): a is string => typeof a === "string")
				.flatMap((a) => missingEnvVars(a, env)),
			...Object.values(rawEnv ?? {}).flatMap((value) => missingEnvVars(value, env)),
		];
		const referenced = referencedEnvVars(
			raw.command,
			...(Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : []),
			...Object.values(rawEnv ?? {}),
		);
		return {
			kind: "stdio",
			name,
			command: home(expandEnv(raw.command, env)),
			args,
			env: rawEnv ? Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, expandEnv(v, env)])) : undefined,
			...(cwd ? { cwd } : {}),
			source,
			missingEnv: missing.length > 0 ? [...new Set(missing)] : undefined,
			referencedEnv: referenced.length > 0 ? referenced : undefined,
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

/**
 * pi's own `mcp.json` files: the agent dir's and the project's. `configDirName`
 * is pi's `CONFIG_DIR_NAME` (`.pi` unless pi itself is rebranded); callers
 * that import pi pass it.
 */
export function piMcpConfigPaths(agentDir: string, cwd: string, configDirName = ".pi"): { user: string; project: string } {
	return { user: join(agentDir, "mcp.json"), project: join(cwd, configDirName, "mcp.json") };
}

/** Claude Code's MCP files; none in independent mode (lib/config-mode.ts), where pi's two `mcp.json` files remain. */
export function configPaths(cwd: string, home: string): string[] {
	if (!claudeSourcesOn()) return [];
	return [claudeJsonPath(home), ...findProjectConfigs(cwd), join(cwd, ".claude", "settings.local.json")];
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

export interface LoadServersOptions {
	/** Plugin `.mcp.json` paths → plugin name; their servers are named `plugin:<plugin>:<server>` (CC's shape). */
	pluginNames?: ReadonlyMap<string, string>;
	/** Called for a config file that exists but is not valid JSON (review M11: a silent drop read as "no servers configured"). */
	onError?: (path: string, message: string) => void;
	/** pi's own `mcp.json` files (user, then project): read in pi's format, below every Claude Code file. */
	piConfigs?: { user: string; project: string };
	/** Called for a pi-format server that is skipped, or overridden by a Claude Code file's server of the same name. */
	onNote?: (message: string) => void;
	/** Servers other pi extensions registered (`pi.getMcpServers()`): pi's format, below every file; `source` is the extension's path. */
	registered?: readonly RegisteredServer[];
}

/** One `pi.getMcpServers()` entry, structurally (pi 0.99's `RegisteredMcpServer`). */
export interface RegisteredServer {
	name: string;
	config: unknown;
	extensionPath: string;
}

/** The servers other extensions registered (`pi.getMcpServers()`, pi 0.99+); none on an older pi. */
export function registeredMcpServers(pi: object): RegisteredServer[] {
	const host = pi as { getMcpServers?: () => RegisteredServer[] };
	return typeof host.getMcpServers === "function" ? host.getMcpServers() : [];
}

export function loadServers(
	cwd: string,
	home: string,
	env: Record<string, string | undefined> = process.env,
	extraPaths: string[] = [],
	options: LoadServersOptions = {},
): McpServer[] {
	const byName = new Map<string, McpServer>();
	const piPaths = options.piConfigs ? [options.piConfigs.user, options.piConfigs.project] : [];
	const piFormat: PiFormat = { home, cwd };
	for (const { name, config, extensionPath } of options.registered ?? []) {
		const raw = (config && typeof config === "object" ? config : {}) as RawServer;
		const problem = piFormatProblem(raw);
		if (problem) {
			options.onNote?.(`MCP server "${name}" registered by ${extensionPath} is skipped: ${problem}.`);
			continue;
		}
		const server = parseServer(name, raw, extensionPath, env, piFormat);
		if (server) byName.set(name, { ...server, piOrigin: "extension" });
	}
	// Plugin configs come first so project and user files can override them,
	// then pi's own files, then Claude Code's.
	for (const path of [...extraPaths, ...piPaths, ...configPaths(cwd, home)]) {
		if (!existsSync(path)) continue;
		let file: Record<string, unknown> | undefined;
		try {
			file = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		} catch (error) {
			options.onError?.(path, (error as Error).message);
			continue;
		}
		const servers = serverMapOf(file);
		if (!servers) continue;
		const plugin = options.pluginNames?.get(path);
		const piOrigin: PiOrigin | undefined =
			path === options.piConfigs?.user ? "user" : path === options.piConfigs?.project ? "project" : undefined;
		for (const [rawName, raw] of Object.entries(servers)) {
			const name = plugin ? `plugin:${plugin}:${rawName}` : rawName;
			const problem = piOrigin ? piFormatProblem(raw ?? {}) : undefined;
			if (problem) {
				options.onNote?.(`MCP server "${name}" in ${path} is skipped: ${problem}.`);
				continue;
			}
			const server = parseServer(name, raw ?? {}, path, env, piOrigin ? piFormat : undefined);
			const inherited = byName.get(name);
			// The same server kept in both (common while moving between the two) is not worth a warning.
			if (!piOrigin && server && inherited?.piOrigin && hashServerConfig(server) !== hashServerConfig(inherited)) {
				options.onNote?.(`MCP server "${name}" in ${inherited.source} is overridden by the one in ${path}.`);
			}
			if (server) byName.set(name, piOrigin ? { ...server, piOrigin } : server);
			else byName.delete(name); // an explicit `disabled` entry removes an inherited one
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
