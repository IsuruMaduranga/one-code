/**
 * Project `.mcp.json` consent. A checked-in `.mcp.json` names commands that
 * run on the user's machine the moment the repo is opened, so its servers
 * connect only after the user approves them — Claude Code prompts "New MCP
 * server found in .mcp.json" and remembers the answer in
 * `enabledMcpjsonServers` / `disabledMcpjsonServers` /
 * `enableAllProjectMcpServers`. One Code honours those three keys READ-ONLY
 * (user and `.claude/settings.local.json` scopes — never the checked-in
 * project `settings.json`, which would let a repo approve itself) and keeps its
 * own answers under `~/.onecode`, keyed to a hash of each server's config so a
 * changed command re-prompts (CC keys by name alone). Servers from
 * `~/.claude.json`, `.claude/settings.local.json`, and plugins never prompt:
 * the user wrote the first two, and installing a plugin was the consent.
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
import { oneCodeStateDir } from "../lib/paths.ts";
import type { McpServer } from "./config.ts";

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
	return join(oneCodeStateDir(), "mcp", "project-approvals.json");
}

/** A server that came from a project `.mcp.json` (not a plugin's, which is also named `.mcp.json`). */
export function isProjectMcpJson(server: McpServer, pluginConfigPaths: ReadonlySet<string>): boolean {
	return basename(server.source) === ".mcp.json" && !pluginConfigPaths.has(server.source);
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

/** Everything that decides what the server runs or talks to; `source`/`missingEnv` are not part of it. */
export function hashServerConfig(server: McpServer): string {
	const material =
		server.kind === "stdio"
			? { kind: "stdio", command: server.command, args: server.args, env: server.env ?? {} }
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

export function readClaudeMcpjsonPolicy(cwd: string, home: string): ClaudeMcpjsonPolicy {
	const paths = settingsPaths(cwd, home);
	const policy: ClaudeMcpjsonPolicy = { enableAll: false, enabled: new Set(), disabled: new Set() };
	// Deliberately not `paths.project`: a checked-in settings.json granting
	// enableAllProjectMcpServers would be the repo approving its own servers.
	for (const path of [paths.user, paths.local]) {
		const file = readSettingsFile(path);
		if (!file) continue;
		if (typeof file.enableAllProjectMcpServers === "boolean") policy.enableAll = file.enableAllProjectMcpServers;
		for (const name of stringArray(file.enabledMcpjsonServers)) policy.enabled.add(name);
		for (const name of stringArray(file.disabledMcpjsonServers)) policy.disabled.add(name);
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

export const CHOICE_ALL = "Use this and all future MCP servers in this project";
export const CHOICE_THIS = "Use this MCP server";
export const CHOICE_THESE = "Use these MCP servers";
export const CHOICE_NO = "No";

/** Claude Code's dialog title for one or several newly found servers. */
export function promptTitle(names: string[]): string {
	return names.length === 1
		? `New MCP server found in .mcp.json: ${names[0]}`
		: `${names.length} new MCP servers found in .mcp.json`;
}

/** One line per server naming what would run, for the dialog body. Never echoes env values. */
export function describeServers(servers: McpServer[]): string {
	return servers
		.map((server) =>
			server.kind === "stdio"
				? `${server.name}: ${[server.command, ...server.args].join(" ")}`
				: `${server.name}: ${server.url}`,
		)
		.map((line) => (line.length > 100 ? `${line.slice(0, 100)}…` : line))
		.join("\n");
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
	const claude = readClaudeMcpjsonPolicy(cwd, home);

	for (const server of servers) {
		if (!isProjectMcpJson(server, pluginConfigPaths)) {
			approved.push(server);
			continue;
		}
		if (claude.disabled.has(server.name)) {
			withheld.push({ server, reason: "disabled-by-claude-settings" });
			continue;
		}
		if (claude.enableAll || claude.enabled.has(server.name)) {
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
		deps.notify(
			`Skipped ${pending.length} MCP server${pending.length === 1 ? "" : "s"} from .mcp.json (${pending.map((s) => s.name).join(", ")}): not yet approved and no UI to ask. Approve once in an interactive session, or set enabledMcpjsonServers in .claude/settings.local.json.`,
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
			.select(`${promptTitle(names)}\n\n${describeServers(pending)}\n\nThese run on your machine.`, [CHOICE_ALL, useLabel, CHOICE_NO])
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
		deps.notify(`MCP server${pending.length === 1 ? "" : "s"} from .mcp.json not connected (${names.join(", ")}); enable in /mcp.`);
	}
	return { approved, withheld };
}

/** Test seam. */
export function resetMcpTrustSessionState(): void {
	sessionDecisions.clear();
	pendingPrompts.clear();
}
