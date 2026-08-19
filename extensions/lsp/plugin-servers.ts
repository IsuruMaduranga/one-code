/**
 * Plugin-provided LSP server configs (pure).
 *
 * The way Claude Code supports language servers: a plugin ships either a
 * `.lsp.json` in its root (`{"<server>": {command, extensionToLanguage, ...}}`)
 * or an `lspServers` field in `.claude-plugin/plugin.json` (a relative path to
 * such a JSON file, an inline record, or an array mixing both — manifest
 * entries win on server-name collision). Servers are named
 * `plugin:<plugin>:<server>` and routed by file extension via their required
 * `extensionToLanguage` map; there is no root-marker walk for plugin servers
 * (the built-in table in servers.ts keeps that) — they root at
 * `workspaceFolder ?? cwd`.
 *
 * `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${VAR}` and
 * `${VAR:-default}` are substituted in `command`, each `args` element, `env`
 * values, and `workspaceFolder` — never inside `settings` or
 * `initializationOptions`, which pass through verbatim. `${user_config.*}`
 * (plugin user-config prompts) is not supported: a server using it is rejected
 * with a named diagnostic rather than spawned with a live placeholder.
 *
 * Unsupported config fields are rejected loudly per repo convention:
 * `transport: "socket"`, `shutdownTimeout`, `restartOnCrash`, `maxRestarts`.
 */

import { readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathWithinBase, sanitizePathSegment } from "../lib/plugin-root.ts";

export interface ResolvedPluginServer {
	/** `plugin:<pluginName>:<serverName>` — the client-map key. */
	key: string;
	pluginName: string;
	serverName: string;
	/** Normalized `.ext` (lowercase, leading dot) → LSP languageId. */
	languageByExtension: Record<string, string>;
	command: string;
	args: string[];
	/** Fully substituted; includes CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA. */
	env: Record<string, string>;
	/** The `${CLAUDE_PLUGIN_DATA}` directory — wiring mkdirs it before spawn. */
	dataDir: string;
	workspaceFolder?: string;
	initializationOptions?: unknown;
	settings?: unknown;
	startupTimeoutMs?: number;
}

export interface PluginServerSource {
	name: string;
	path: string;
	/** Per-origin plugin-data base dir (Plugin.dataRoot from lib/plugins.ts). */
	dataRoot: string;
}

export function pluginDataDir(dataRoot: string, pluginName: string): string {
	return join(dataRoot, sanitizePathSegment(pluginName));
}

/** Resolve a manifest-declared relative path, or undefined when it escapes the plugin dir. */
export function resolveWithinPlugin(pluginPath: string, relativePath: string): string | undefined {
	return pathWithinBase(pluginPath, relativePath) ? resolve(pluginPath, relativePath) : undefined;
}

interface SubstitutionContext {
	pluginRootDir: string;
	dataDir: string;
	env: Record<string, string | undefined>;
}

interface SubstitutionResult {
	value: string;
	/** `${user_config.*}` seen — the whole server must be rejected. */
	userConfig: boolean;
	/** Env vars that had no value and no default (left literal). */
	missing: string[];
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::-([^}]*))?\}/g;

export function substitute(value: string, ctx: SubstitutionContext): SubstitutionResult {
	let userConfig = false;
	const missing: string[] = [];
	const result = value.replace(PLACEHOLDER, (literal, name: string, fallback: string | undefined) => {
		if (name === "CLAUDE_PLUGIN_ROOT") return ctx.pluginRootDir;
		if (name === "CLAUDE_PLUGIN_DATA") return ctx.dataDir;
		if (name.startsWith("user_config.")) {
			userConfig = true;
			return literal;
		}
		const env = ctx.env[name];
		if (env !== undefined) return env;
		if (fallback !== undefined) return fallback;
		missing.push(name);
		return literal;
	});
	return { value: result, userConfig, missing };
}

/** Raw server configs gathered from one plugin's sources, manifest winning. */
export function collectRawServers(
	plugin: Pick<PluginServerSource, "name" | "path">,
	lspConfigPath: string | undefined,
	manifestLspServers: unknown,
	diagnostics: string[],
): Record<string, unknown> {
	const servers: Record<string, unknown> = {};

	const mergeRecord = (raw: unknown, sourceLabel: string) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			diagnostics.push(`${plugin.name}: ${sourceLabel} must be a JSON object mapping server names to configs`);
			return;
		}
		Object.assign(servers, raw as Record<string, unknown>);
	};

	const mergeFile = (path: string, sourceLabel: string) => {
		let raw: string;
		try {
			raw = readFileSync(path, "utf-8");
		} catch (error) {
			diagnostics.push(`${plugin.name}: could not read ${sourceLabel} (${(error as Error).message})`);
			return;
		}
		try {
			mergeRecord(JSON.parse(raw), sourceLabel);
		} catch (error) {
			diagnostics.push(`${plugin.name}: invalid JSON in ${sourceLabel} (${(error as Error).message})`);
		}
	};

	if (lspConfigPath) mergeFile(lspConfigPath, ".lsp.json");

	const mergeManifestEntry = (entry: unknown) => {
		if (typeof entry === "string") {
			const resolved = resolveWithinPlugin(plugin.path, entry);
			if (!resolved) {
				diagnostics.push(`${plugin.name}: manifest lspServers path "${entry}" escapes the plugin directory — rejected`);
				return;
			}
			mergeFile(resolved, `manifest lspServers file "${entry}"`);
			return;
		}
		mergeRecord(entry, "manifest lspServers");
	};

	if (manifestLspServers !== undefined) {
		if (Array.isArray(manifestLspServers)) for (const entry of manifestLspServers) mergeManifestEntry(entry);
		else mergeManifestEntry(manifestLspServers);
	}

	return servers;
}

/** The manifest's raw `lspServers` value, read directly off plugin.json. */
export function readManifestLspServers(pluginPath: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(join(pluginPath, ".claude-plugin", "plugin.json"), "utf-8");
	} catch {
		return undefined;
	}
	try {
		return (JSON.parse(raw) as { lspServers?: unknown }).lspServers;
	} catch {
		return undefined;
	}
}

const UNSUPPORTED_FIELDS = ["shutdownTimeout", "restartOnCrash", "maxRestarts"] as const;

/**
 * Validate + substitute one server config. Returns undefined (with the reason
 * pushed to `diagnostics`) rather than producing a spawnable-but-wrong config.
 */
export function resolveServerConfig(
	plugin: PluginServerSource,
	serverName: string,
	raw: unknown,
	env: Record<string, string | undefined>,
	diagnostics: string[],
): ResolvedPluginServer | undefined {
	const label = `${plugin.name}:${serverName}`;
	const reject = (reason: string): undefined => {
		diagnostics.push(`${label}: ${reason} — server skipped`);
		return undefined;
	};

	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return reject("config must be an object");
	const config = raw as Record<string, unknown>;

	for (const field of UNSUPPORTED_FIELDS) {
		if (config[field] !== undefined) return reject(`"${field}" is not supported`);
	}
	if (config.transport !== undefined && config.transport !== "stdio") {
		return reject(`transport "${String(config.transport)}" is not supported (stdio only)`);
	}

	if (typeof config.command !== "string" || config.command.length === 0) {
		return reject('"command" must be a non-empty string');
	}
	if (config.command.includes(" ") && !config.command.startsWith("/")) {
		return reject('"command" must not contain spaces — use the args array for arguments');
	}

	const extRaw = config.extensionToLanguage;
	if (extRaw === null || typeof extRaw !== "object" || Array.isArray(extRaw)) {
		return reject('"extensionToLanguage" (extension → language id map) is required');
	}
	const languageByExtension: Record<string, string> = {};
	for (const [ext, languageId] of Object.entries(extRaw as Record<string, unknown>)) {
		if (typeof languageId !== "string" || languageId.length === 0) {
			return reject(`extensionToLanguage["${ext}"] must be a non-empty language id`);
		}
		const normalized = (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase();
		languageByExtension[normalized] = languageId;
	}
	if (Object.keys(languageByExtension).length === 0) {
		return reject('"extensionToLanguage" must have at least one mapping');
	}

	if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((a) => typeof a !== "string"))) {
		return reject('"args" must be an array of strings');
	}
	if (config.startupTimeout !== undefined && (typeof config.startupTimeout !== "number" || config.startupTimeout <= 0)) {
		return reject('"startupTimeout" must be a positive number of milliseconds');
	}
	if (config.workspaceFolder !== undefined && typeof config.workspaceFolder !== "string") {
		return reject('"workspaceFolder" must be a string');
	}
	if (
		config.env !== undefined &&
		(config.env === null || typeof config.env !== "object" || Array.isArray(config.env) ||
			Object.values(config.env as Record<string, unknown>).some((v) => typeof v !== "string"))
	) {
		return reject('"env" must be a map of string values');
	}

	const dataDir = pluginDataDir(plugin.dataRoot, plugin.name);
	const ctx: SubstitutionContext = { pluginRootDir: plugin.path, dataDir, env };
	const missing = new Set<string>();
	let sawUserConfig = false;
	const sub = (value: string): string => {
		const result = substitute(value, ctx);
		if (result.userConfig) sawUserConfig = true;
		for (const name of result.missing) missing.add(name);
		return result.value;
	};

	const command = sub(config.command);
	const args = ((config.args as string[] | undefined) ?? []).map(sub);
	const substitutedEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries((config.env as Record<string, string> | undefined) ?? {})) {
		substitutedEnv[key] = sub(value);
	}
	const workspaceFolder = typeof config.workspaceFolder === "string" ? sub(config.workspaceFolder) : undefined;

	if (sawUserConfig) {
		return reject("${user_config.*} placeholders are not supported (plugin user-config prompts are not implemented)");
	}
	if (missing.size > 0) {
		diagnostics.push(`${label}: environment variable${missing.size === 1 ? "" : "s"} not set: ${[...missing].join(", ")} (left as-is)`);
	}
	if (command.includes("${")) {
		return reject(`command still contains an unresolved placeholder after substitution ("${command}")`);
	}

	return {
		key: `plugin:${plugin.name}:${serverName}`,
		pluginName: plugin.name,
		serverName,
		languageByExtension,
		command,
		args,
		env: { CLAUDE_PLUGIN_ROOT: plugin.path, CLAUDE_PLUGIN_DATA: dataDir, ...substitutedEnv },
		dataDir,
		workspaceFolder,
		initializationOptions: config.initializationOptions,
		settings: config.settings,
		startupTimeoutMs: config.startupTimeout as number | undefined,
	};
}

/** Everything one plugin contributes, resolved and substituted. */
export function resolvePluginServers(
	plugin: PluginServerSource,
	lspConfigPath: string | undefined,
	manifestLspServers: unknown,
	env: Record<string, string | undefined>,
): { servers: ResolvedPluginServer[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	const raw = collectRawServers(plugin, lspConfigPath, manifestLspServers, diagnostics);
	const servers: ResolvedPluginServer[] = [];
	for (const [serverName, config] of Object.entries(raw)) {
		const resolved = resolveServerConfig(plugin, serverName, config, env, diagnostics);
		if (resolved) servers.push(resolved);
	}
	return { servers, diagnostics };
}

export interface ExtensionRouting {
	byExtension: Map<string, ResolvedPluginServer>;
	collisions: string[];
}

/**
 * Extension → server routing across all plugins. Deterministic on collision:
 * servers sorted by plugin then server name, first claim wins, the loser is
 * recorded for /lsp and a one-time notify.
 */
export function resolveExtensionRouting(servers: ResolvedPluginServer[]): ExtensionRouting {
	const sorted = [...servers].sort((a, b) => a.key.localeCompare(b.key));
	const byExtension = new Map<string, ResolvedPluginServer>();
	const collisions: string[] = [];
	for (const server of sorted) {
		for (const ext of Object.keys(server.languageByExtension)) {
			const holder = byExtension.get(ext);
			if (holder) {
				collisions.push(`${ext}: ${server.key} ignored (${holder.key} claimed it first)`);
				continue;
			}
			byExtension.set(ext, server);
		}
	}
	return { byExtension, collisions };
}

/** LanguageId a plugin server uses for a path (routing already matched it). */
export function pluginLanguageId(server: ResolvedPluginServer, path: string): string {
	const ext = extname(path).toLowerCase();
	return server.languageByExtension[ext] ?? Object.values(server.languageByExtension)[0];
}
