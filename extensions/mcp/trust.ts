/**
 * Project `.mcp.json` consent. A checked-in `.mcp.json` names commands that
 * run on the user's machine the moment the repo is opened, so its servers
 * connect only after the user approves them — Claude Code prompts "New MCP
 * server found in .mcp.json" and remembers the answer in
 * `enabledMcpjsonServers` / `disabledMcpjsonServers` /
 * `enableAllProjectMcpServers`. One Code honours those three keys READ-ONLY
 * (the approving two from the user's settings only, the disable list from
 * `.claude/settings.local.json` too — never the checked-in project
 * `settings.json`, which would let a repo approve itself) and keeps its
 * own answers under `~/.onecode`, keyed to a hash of each server's config so a
 * changed command re-prompts (CC keys by name alone). Servers from
 * `~/.claude.json` and plugins never prompt: the user wrote the first, and
 * installing a plugin was the consent. Servers from `.claude/settings.local.json`
 * ARE prompted (that file can be checked in — `git clone && onecode` would
 * otherwise spawn its servers with no consent, review H1); CC never reads
 * `mcpServers` from that file at all. Its `enableAll*`/`enabledMcpjsonServers`
 * policy keys are never honoured, for the same reason: git provenance cannot
 * tell a user's file from one shipped with a copied checkout
 * (`readClaudeMcpjsonPolicy`).
 *
 * A "No" is persisted as a project-scope disable (`lib/mcp-overrides.ts`), so
 * the server shows as disabled in `/mcp` and Enable there brings it back —
 * that click is the consent, recorded here. Escape declines for this session
 * only. Same shape as `hooks/trust.ts`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readSettingsFile, settingsPaths } from "../lib/claude-settings.ts";
import { boundConsentItems } from "../lib/consent-preview.ts";
import { consentStorePath } from "../lib/consent-stores.ts";
import type { McpServer } from "./config.ts";
import { escapeControlText } from "../lib/terminal-text.ts";

interface ProjectApprovals {
	/** "Use this and all future MCP servers in this project" was chosen. */
	enableAll?: boolean;
	servers: Record<string, { configHash: string; approvedAt: string }>;
}

interface ApprovalStore {
	version: 1;
	projects: Record<string, ProjectApprovals>;
}

export function approvalStorePath(): string {
	return consentStorePath("mcp");
}

/**
 * A server whose config a repository can ship (a project `.mcp.json`, a
 * checked-in `.claude/settings.local.json`, or pi's project `.pi/mcp.json`) —
 * so it is consent-gated. A plugin's `.mcp.json` (also named `.mcp.json`) is
 * excluded: installing the plugin was the consent. pi's user file
 * (`<agentDir>/mcp.json`) is the user's own, like `~/.claude.json`.
 */
export function isProjectScopedServer(server: McpServer, pluginConfigPaths: ReadonlySet<string>): boolean {
	if (pluginConfigPaths.has(server.source)) return false;
	const base = basename(server.source);
	return base === ".mcp.json" || base === "settings.local.json" || server.piOrigin === "project";
}

/** A server from a project `.mcp.json`: the only kind Claude Code's own answers approve. */
function definedInMcpjson(server: McpServer): boolean {
	return basename(server.source) === ".mcp.json";
}

/** The project file a consent-gated server comes from, as the dialog names it. */
function configLabel(server: McpServer): string {
	if (definedInLocalSettings(server)) return ".claude/settings.local.json";
	// pi's project file is `<dir>/<pi's config dir>/mcp.json`, `.pi/mcp.json` unless pi is rebranded.
	return server.piOrigin === "project" ? `${basename(dirname(server.source))}/mcp.json` : ".mcp.json";
}

/** "a and b" for the distinct config files of `servers`. */
function configLabels(servers: McpServer[]): string {
	return [...new Set(servers.map(configLabel))].join(" and ");
}

/** A server defined in `.claude/settings.local.json` rather than a `.mcp.json`. */
function definedInLocalSettings(server: McpServer): boolean {
	return basename(server.source) === "settings.local.json";
}

/** The directory the `.mcp.json` lives in — approvals are per config file, not per cwd. */
export function projectRootOf(server: McpServer): string {
	return dirname(server.source);
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, inner]) => [key, canonicalize(inner)]),
		);
	}
	return value;
}

/**
 * Everything that decides what the server runs or talks to; `source`/`missingEnv` are not part of it.
 * A stdio `cwd` (pi's files only) joins the material only when set, so existing approvals keep their hash.
 */
export function hashServerConfig(server: McpServer): string {
	const material =
		server.kind === "stdio"
			? { kind: "stdio", command: server.command, args: server.args, env: server.env ?? {}, ...(server.cwd ? { cwd: server.cwd } : {}) }
			: { kind: "http", url: server.url, headers: server.headers ?? {} };
	return createHash("sha256").update(JSON.stringify(canonicalize(material))).digest("hex");
}

/** Claude Code's own answers, read from its settings (user + local scopes only). */
export interface ClaudeMcpjsonPolicy {
	enableAll: boolean;
	enabled: Set<string>;
	disabled: Set<string>;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Claude Code's answers that One Code honours. The approving keys
 * (`enableAllProjectMcpServers`, `enabledMcpjsonServers`) count only from the
 * user's `~/.claude/settings.json`. Until 2026-09-27 they also counted from a
 * `.claude/settings.local.json` that git reported untracked, but a directory
 * that carries its own `.git` (a tarball of a working copy, a copied or
 * synced checkout) makes a shipped file untracked too, so its servers
 * connected with no prompt, headless included. No check of the local file
 * can tell who wrote it, so it no longer approves anything: its servers go
 * through One Code's own dialog and hash-keyed store. Its
 * `disabledMcpjsonServers` only tightens, so it is still honoured. Async for
 * its callers; nothing here shells out any more.
 */
export async function readClaudeMcpjsonPolicy(cwd: string, home: string): Promise<ClaudeMcpjsonPolicy> {
	const paths = settingsPaths(cwd, home);
	const policy: ClaudeMcpjsonPolicy = { enableAll: false, enabled: new Set(), disabled: new Set() };
	// Deliberately not `paths.project`: a checked-in settings.json granting
	// enableAllProjectMcpServers would be the repo approving its own servers.
	// The local file is in the checkout too, whatever git says about it.
	for (const path of [paths.user, paths.local]) {
		const file = readSettingsFile(path);
		if (!file) continue;
		for (const name of stringArray(file.disabledMcpjsonServers)) policy.disabled.add(name);
		if (path === paths.local) continue;
		if (typeof file.enableAllProjectMcpServers === "boolean") policy.enableAll = file.enableAllProjectMcpServers;
		for (const name of stringArray(file.enabledMcpjsonServers)) policy.enabled.add(name);
	}
	return policy;
}

function readStore(storePath: string): ApprovalStore {
	try {
		const existing = JSON.parse(readFileSync(storePath, "utf-8")) as ApprovalStore;
		if (existing && typeof existing === "object" && existing.projects) return existing;
	} catch {
		// Fresh store.
	}
	return { version: 1, projects: {} };
}

function writeStore(storePath: string, store: ApprovalStore): void {
	try {
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(storePath, `${JSON.stringify(store, null, "\t")}\n`, { mode: 0o600 });
	} catch {
		// Approval still holds for this session; it will just re-prompt next run.
	}
}

export function readStoredApproval(projectRoot: string, storePath = approvalStorePath()): ProjectApprovals | undefined {
	return readStore(storePath).projects[projectRoot];
}

/** Record consent for one server's current config. */
export function persistApproval(projectRoot: string, server: McpServer, storePath = approvalStorePath()): void {
	const store = readStore(storePath);
	const project = (store.projects[projectRoot] ??= { servers: {} });
	project.servers[server.name] = { configHash: hashServerConfig(server), approvedAt: new Date().toISOString() };
	writeStore(storePath, store);
}

/** Record "this and all future servers in this project". */
export function persistEnableAll(projectRoot: string, storePath = approvalStorePath()): void {
	const store = readStore(storePath);
	const project = (store.projects[projectRoot] ??= { servers: {} });
	project.enableAll = true;
	writeStore(storePath, store);
}

/**
 * Why `/mcp`'s Reconnect must not connect a server, or undefined. A server
 * whose config references an unset variable is never connected (startup
 * skips it and never asks for consent), so Reconnect must not either: it
 * would spawn the command with the variable expanded to nothing, and a
 * project server would run with no consent.
 */
export function reconnectRefusal(server: McpServer): string | undefined {
	if (!server.missingEnv?.length) return undefined;
	const names = server.missingEnv.join(", ");
	return `"${server.name}" needs ${names} set in the environment. Set ${server.missingEnv.length === 1 ? "it" : "them"} and restart One Code.`;
}

export const CHOICE_ALL = "Use this and all future MCP servers in this project";
export const CHOICE_THIS = "Use this MCP server";
export const CHOICE_THESE = "Use these MCP servers";
export const CHOICE_NO = "No";

/** Claude Code's dialog title for one or several newly found servers; `file` names where they were found. */
export function promptTitle(names: string[], file = ".mcp.json"): string {
	return names.length === 1
		? `New MCP server found in ${file}: ${escapeControlText(names[0])}`
		: `${names.length} new MCP servers found in ${file}`;
}

/**
 * Environment variables that change what a stdio server's command runs, or
 * where it loads code from: an interpreter's preload and search paths, the
 * dynamic loader's, `PATH`, and npm's config. Matched case-insensitively
 * (Windows environment names are). The consent dialog shows these values in
 * full, because `npx -y some-mcp` with `NODE_OPTIONS=--require ./x.js` is not
 * the command it looks like.
 */
const EXECUTION_ENV = new Set([
	"PATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"PYTHONHOME",
	"PERL5OPT",
	"PERL5LIB",
	"RUBYOPT",
	"RUBYLIB",
	"BASH_ENV",
	"ENV",
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"ELECTRON_RUN_AS_NODE",
	"GIT_SSH_COMMAND",
	"GIT_EXEC_PATH",
	"COMSPEC",
	"PATHEXT",
]);
const EXECUTION_ENV_PREFIXES = ["DYLD_", "NPM_CONFIG_"];

/** Whether an env key changes what a server's command executes (`EXECUTION_ENV`). */
export function changesExecution(key: string): boolean {
	const upper = key.toUpperCase();
	return EXECUTION_ENV.has(upper) || EXECUTION_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * One line per server naming what would run, for the dialog body. Commands and
 * URLs are shown in full (a truncated one hides where a padded attack lives).
 * Every `env` key a stdio server sets is named; the values of the keys that
 * change what executes (`changesExecution`) are shown in full, quoted, and the
 * rest are not echoed, since they are usually credentials. The variable NAMES
 * a server's command/args/env/headers reference are listed too (from
 * `referencedEnv`, captured before expansion) — approving a URL should not
 * silently ship a credential the header interpolates (review M5).
 */
export function describeServers(servers: McpServer[]): string {
	const lines = servers.map((server) => {
		const what =
			server.kind === "stdio"
				? `${server.name}: ${[server.command, ...server.args].join(" ")}`
				: `${server.name}: ${server.url}`;
		const vars = server.referencedEnv ?? [];
		const headerNames = server.kind === "http" ? Object.keys(server.headers ?? {}) : [];
		const env = server.kind === "stdio" ? Object.entries(server.env ?? {}) : [];
		const notes = [
			server.kind === "stdio" && server.cwd ? `cwd: ${server.cwd}` : "",
			env.length ? `env: ${env.map(([key, value]) => (changesExecution(key) ? `${key}=${JSON.stringify(value)}` : key)).join(", ")}` : "",
			vars.length ? `uses ${vars.map((v) => `$${v}`).join(", ")}` : "",
			headerNames.length ? `headers: ${headerNames.join(", ")}` : "",
		].filter(Boolean);
		return notes.length ? `${what}\n    (${notes.join("; ")})` : what;
	});
	// Bound the modal: a very long command/url or many servers cannot flood it.
	return boundConsentItems(lines, "review .mcp.json before approving");
}

export interface McpTrustDeps {
	hasUI: boolean;
	/** `ctx.ui.select` — returns the chosen option, or undefined on Escape. */
	select: (title: string, options: string[]) => Promise<string | undefined>;
	notify: (message: string) => void;
	/** Persist an explicit "No" (project-scope disable), so it does not re-prompt every start. */
	disable: (server: McpServer) => void;
	storePath?: string;
}

export interface McpTrustOutcome {
	/** Servers that may connect (includes every non-project-`.mcp.json` server). */
	approved: McpServer[];
	/** Project `.mcp.json` servers that must not connect, with why. */
	withheld: { server: McpServer; reason: "declined" | "not-approved" | "disabled-by-claude-settings" }[];
}

/** Process-lifetime memory per project+server+hash, so /clear (a new session_start) does not re-ask a "No". */
const sessionDecisions = new Map<string, boolean>();
const pendingPrompts = new Map<string, Promise<string | undefined>>();

/**
 * Split servers into those that may connect and those withheld, prompting
 * once (one dialog for every new project server) when there is a UI.
 */
export async function approveMcpServers(
	servers: McpServer[],
	pluginConfigPaths: ReadonlySet<string>,
	cwd: string,
	home: string,
	deps: McpTrustDeps,
): Promise<McpTrustOutcome> {
	const approved: McpServer[] = [];
	const withheld: McpTrustOutcome["withheld"] = [];
	const pending: McpServer[] = [];
	// Reading CC's policy reads two settings files, so only do it when a
	// server actually needs consent.
	const anyProjectScoped = servers.some((s) => isProjectScopedServer(s, pluginConfigPaths));
	const claude: ClaudeMcpjsonPolicy = anyProjectScoped
		? await readClaudeMcpjsonPolicy(cwd, home)
		: { enableAll: false, enabled: new Set<string>(), disabled: new Set<string>() };

	for (const server of servers) {
		if (!isProjectScopedServer(server, pluginConfigPaths)) {
			approved.push(server);
			continue;
		}
		if (claude.disabled.has(server.name)) {
			withheld.push({ server, reason: "disabled-by-claude-settings" });
			continue;
		}
		// Claude Code's own answers approve `.mcp.json` servers only. A server
		// DEFINED in settings.local.json must never be approved by that same
		// file's `enableAllProjectMcpServers` (SECURITY-REVIEW-2026-09-23 H4), and
		// one from pi's `.pi/mcp.json` is not a file those answers were about: both
		// go through One Code's hash-keyed consent below, like any other.
		if (definedInMcpjson(server) && (claude.enableAll || claude.enabled.has(server.name))) {
			approved.push(server);
			continue;
		}
		const root = projectRootOf(server);
		const hash = hashServerConfig(server);
		const stored = readStoredApproval(root, deps.storePath);
		if (stored?.enableAll || stored?.servers[server.name]?.configHash === hash) {
			approved.push(server);
			continue;
		}
		const remembered = sessionDecisions.get(`${root}:${server.name}:${hash}`);
		if (remembered === true) approved.push(server);
		else if (remembered === false) withheld.push({ server, reason: "declined" });
		else pending.push(server);
	}

	if (pending.length === 0) return { approved, withheld };

	if (!deps.hasUI) {
		for (const server of pending) withheld.push({ server, reason: "not-approved" });
		// enabledMcpjsonServers approves `.mcp.json` servers only (above), so the
		// hint names it only when one of those is waiting.
		const fromMcpjson = pending.some(definedInMcpjson);
		const sources = configLabels(pending);
		deps.notify(
			`Skipped ${pending.length} MCP server${pending.length === 1 ? "" : "s"} from ${sources} (${pending.map((s) => s.name).join(", ")}): not yet approved and no UI to ask. Approve once in an interactive session${fromMcpjson ? ", or set enabledMcpjsonServers in ~/.claude/settings.json" : ""}.`,
		);
		return { approved, withheld };
	}

	// One dialog for the batch; concurrent callers (a reconnect racing startup) share it.
	const names = pending.map((s) => s.name);
	const key = pending.map((s) => `${projectRootOf(s)}:${s.name}:${hashServerConfig(s)}`).join("|");
	let prompt = pendingPrompts.get(key);
	if (!prompt) {
		const useLabel = pending.length === 1 ? CHOICE_THIS : CHOICE_THESE;
		prompt = deps
			.select(`${promptTitle(names, configLabels(pending))}\n\n${describeServers(pending)}\n\nThese run on your machine.`, [CHOICE_ALL, useLabel, CHOICE_NO])
			.finally(() => pendingPrompts.delete(key));
		pendingPrompts.set(key, prompt);
	}
	const choice = await prompt;

	for (const server of pending) {
		const root = projectRootOf(server);
		const decisionKey = `${root}:${server.name}:${hashServerConfig(server)}`;
		if (choice === CHOICE_ALL || choice === CHOICE_THIS || choice === CHOICE_THESE) {
			sessionDecisions.set(decisionKey, true);
			if (choice === CHOICE_ALL) persistEnableAll(root, deps.storePath);
			persistApproval(root, server, deps.storePath);
			approved.push(server);
		} else {
			sessionDecisions.set(decisionKey, false);
			withheld.push({ server, reason: "declined" });
			// An explicit "No" is remembered as a disable; Escape is this session only.
			if (choice === CHOICE_NO) deps.disable(server);
		}
	}
	if (choice !== CHOICE_ALL && choice !== CHOICE_THIS && choice !== CHOICE_THESE) {
		deps.notify(`MCP server${pending.length === 1 ? "" : "s"} from ${configLabels(pending)} not connected (${names.join(", ")}); enable in /mcp.`);
	}
	return { approved, withheld };
}

/** Test seam. */
export function resetMcpTrustSessionState(): void {
	sessionDecisions.clear();
	pendingPrompts.clear();
}
