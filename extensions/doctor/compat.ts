/**
 * The imported-configuration scan (pure fs): what of the user's Claude Code
 * setup One Code found, what it reads from each file, and what it does NOT
 * honour — the compatibility report behind "your setup works unchanged".
 *
 * Every settings file gets one row: present / valid / the keys One Code consumes
 * from it (permissions, hooks, plugins, MCP policy, the one `env` variable it
 * borrows) and the keys it leaves alone. "Leaves alone" is stated per file
 * because the answer differs by scope on purpose — a repository's own
 * `.claude/settings.json` may not grant itself `auto` mode or configure the
 * auto-mode classifier (working-docs/decisions/modes.md, auto-mode.md) — and a user
 * reading "works unchanged" must see exactly where it does not.
 *
 * Findings are the things silent elsewhere: a settings file that fails to
 * parse (loaders skip it and the user believes its rules are in force), a
 * `defaultMode` in a file that never contributes one, a CLAUDE.md over Claude
 * Code's 40k-char soft limit, a hook or MCP config the loaders rejected.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { managedSettingsPaths } from "../auto-mode/config.ts";
import { loadPluginHooks } from "../hooks/plugin-hooks.ts";
import { type HooksSource, loadHookSettings } from "../hooks/settings.ts";
import { claudeJsonPath, claudeUserDir } from "../lib/paths.ts";
import { claudeUserSettingsPath, settingsPaths } from "../lib/claude-settings.ts";
import { discoverContextFilePaths } from "../lib/claude-context.ts";
import { CLAUDE_MD_CHAR_LIMIT, claudeMdLimitWarning, indexLimitStatus, projectMemoryDir } from "../lib/memory.ts";
import { readDisabledMcpServers } from "../lib/mcp-overrides.ts";
import { oneCodeProjectSettingsPath, oneCodeSettingsPath } from "../lib/one-code-settings.ts";
import { parseFrontmatterLoosely } from "../lib/frontmatter.ts";
import { defaultDiscoverRoots, discoverPlugins, type DiscoveredPlugins } from "../lib/plugins.ts";
import { BUNDLED_SKILLS_DIR, promptTemplateNames, scanSkills } from "../lib/skill-scan.ts";
import { loadServers, type McpServer } from "../mcp/config.ts";
import type { PermissionMode } from "../permissions/matcher.ts";
import { MODES_NEVER_FROM_PROJECT } from "../permissions/settings.ts";
import { agentDirs, parseAgentFile } from "../subagents/agents.ts";
import type { Finding, ReportLine, ReportSection, SessionView } from "./report.ts";
import { countNoun, shortenHome } from "./report.ts";

export type SettingsScope = "claude-user" | "claude-project" | "claude-local" | "managed" | "onecode-user" | "onecode-project" | "claude-json";

export interface SettingsFileReport {
	scope: SettingsScope;
	label: string;
	path: string;
	exists: boolean;
	/** False when the file exists but is not a JSON object. */
	valid: boolean;
	error?: string;
	/** One phrase per consumed key, e.g. `permissions: 12 allow, 2 deny`. */
	used: string[];
	/** Top-level keys present that One Code never reads from this file. */
	ignored: string[];
	/** Keys present that One Code reads from OTHER scopes but deliberately not from this one. */
	refused: string[];
}

export interface ContextFileReport {
	path: string;
	descriptor: string;
	chars: number;
	overLimit: boolean;
}

export interface CompatReport {
	files: SettingsFileReport[];
	contextFiles: ContextFileReport[];
	memory: { dir: string; indexExists: boolean; indexStatus?: "ok" | "near" | "over" };
	agents: { user: number; project: number; plugin: number; bundled: number; failed: string[] };
	skills: { user: number; project: number; plugin: number; bundled: number; noDescription: string[] };
	commands: number;
	plugins: { claude: { total: number; enabled: number }; oneCode: { total: number; enabled: number } };
	hooks: { sources: HooksSource[]; commands: number; diagnostics: string[] };
	mcp: { servers: McpServer[]; disabled: Set<string>; configErrors: string[] };
	findings: Finding[];
}

/**
 * The top-level keys One Code reads from each settings scope — the policy the
 * loaders implement (permissions/settings.ts, hooks/settings.ts, auto-mode/config.ts,
 * subagents/default-model.ts, mcp/trust.ts, lib/plugins.ts). A repository's own
 * files get no `autoMode` (the classifier is what contains the repo) and no `env`
 * (a checked-in env block must not route subagents).
 */
const MCP_POLICY_KEYS = ["enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"];
const CLAUDE_PROJECT_KEYS = new Set(["permissions", "hooks", "enabledPlugins", ...MCP_POLICY_KEYS]);
const SCOPE_KEYS: Record<SettingsScope, ReadonlySet<string>> = {
	"claude-user": new Set(["permissions", "hooks", "env", "enabledPlugins", "autoMode", ...MCP_POLICY_KEYS]),
	"claude-project": CLAUDE_PROJECT_KEYS,
	"claude-local": CLAUDE_PROJECT_KEYS,
	managed: new Set(["permissions", "hooks", "env", "autoMode", "enabledPlugins"]),
	"onecode-user": new Set(["subagentModel", "subagentModelSetFor", "autoMode", "permissions", "webSearch", "disabledMcpServers"]),
	"onecode-project": new Set(["permissions", "disabledMcpServers"]),
	"claude-json": new Set(),
};
/** Never worth reporting as "ignored". */
const SILENT_KEYS = new Set(["$schema"]);

type Json = Record<string, unknown>;

function readJsonObject(path: string): { exists: boolean; value?: Json; error?: string } {
	if (!existsSync(path)) return { exists: false };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { exists: true, error: "root must be a JSON object" };
		return { exists: true, value: parsed as Json };
	} catch (error) {
		return { exists: true, error: (error as Error).message };
	}
}

const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

function permissionsSummary(perms: unknown, scope: SettingsScope, findings: Finding[], path: string, home: string): { used?: string; refused?: string } {
	if (!perms || typeof perms !== "object") return {};
	const p = perms as Json;
	const parts: string[] = [];
	const allow = count(p.allow);
	const deny = count(p.deny);
	const ask = count(p.ask);
	if (allow || deny || ask) parts.push(`${allow} allow, ${deny} deny, ${ask} ask`);
	if (scope === "claude-project" || scope === "claude-local") {
		if (allow) parts.push("allow rules apply after a once-per-config consent");
	}
	let refused: string | undefined;
	const mode = typeof p.defaultMode === "string" ? p.defaultMode : undefined;
	if (mode) {
		const repoFile = scope === "claude-project" || scope === "claude-local";
		if (scope === "onecode-user" || scope === "onecode-project") {
			refused = `permissions.defaultMode "${mode}" — never read from One Code's own files`;
			findings.push({
				level: "warn",
				text: `${shortenHome(path, home)} sets permissions.defaultMode "${mode}", which One Code does not read from its own settings files.`,
				fix: "Set the default mode in ~/.claude/settings.json (or start with --permission-mode); remove the key here.",
			});
		} else if (repoFile && MODES_NEVER_FROM_PROJECT.has(mode as PermissionMode)) {
			refused = `permissions.defaultMode "${mode}" — a repository's files may not select it`;
			findings.push({
				level: "warn",
				text: `${shortenHome(path, home)} sets permissions.defaultMode "${mode}"; a repository's own settings never select that mode (it would let a cloned repo grant itself unattended approval). Claude Code applies the same rule.`,
				fix: "Set it in ~/.claude/settings.json instead, or pass --permission-mode.",
			});
		} else {
			parts.push(`defaultMode ${mode}`);
		}
	}
	if (p.disableBypassPermissionsMode === "disable") parts.push("bypass mode disabled");
	if (Array.isArray(p.additionalDirectories) && p.additionalDirectories.length > 0) {
		const dirs = p.additionalDirectories.length;
		const fromRepo = scope === "claude-project" || scope === "claude-local";
		parts.push(`${dirs} workspace director${dirs === 1 ? "y" : "ies"}${fromRepo ? " (applied once you trust the repository's settings)" : ""}`);
	}
	return { used: parts.length ? `permissions: ${parts.join("; ")}` : undefined, refused };
}

function hooksSummary(hooks: unknown): string | undefined {
	if (!hooks || typeof hooks !== "object") return undefined;
	const events = Object.entries(hooks as Json)
		.filter(([, groups]) => Array.isArray(groups) && groups.length > 0)
		.map(([event, groups]) => `${event} ×${(groups as unknown[]).reduce<number>((n, g) => n + count((g as Json)?.hooks), 0)}`);
	return events.length ? `hooks: ${events.join(", ")}` : undefined;
}

function summarizeFile(scope: SettingsScope, label: string, path: string, home: string, findings: Finding[]): SettingsFileReport {
	const read = readJsonObject(path);
	const report: SettingsFileReport = { scope, label, path, exists: read.exists, valid: !read.error, error: read.error, used: [], ignored: [], refused: [] };
	if (!read.exists) return report;
	if (read.error || !read.value) {
		findings.push({
			level: "error",
			text: `${shortenHome(path, home)} is not valid JSON (${read.error}); everything in it is ignored, so rules you believe are in force are not.`,
			fix: "Fix the syntax (a trailing comma is the usual cause) and rerun /doctor.",
		});
		return report;
	}
	const file = read.value;
	const known = SCOPE_KEYS[scope];
	/** Keys a branch below has already classified (used, refused or ignored), so the final sweep skips them. */
	const handled = new Set<string>();

	if (scope === "claude-json") {
		const servers = file.mcpServers && typeof file.mcpServers === "object" ? Object.keys(file.mcpServers as Json).length : 0;
		if (servers) report.used.push(`mcpServers: ${countNoun(servers, "user-scope server")}`);
		report.used.push("everything else in this file (onboarding state, usage counters) is Claude Code's own");
		return report;
	}

	const perms = permissionsSummary(file.permissions, scope, findings, path, home);
	if (perms.used) report.used.push(perms.used);
	if (perms.refused) report.refused.push(perms.refused);
	const hooks = hooksSummary(file.hooks);
	if (hooks && known.has("hooks")) report.used.push(hooks);
	if (file.enabledPlugins && typeof file.enabledPlugins === "object" && known.has("enabledPlugins")) {
		report.used.push(`enabledPlugins: ${Object.keys(file.enabledPlugins as Json).length}`);
	}
	if (file.env && typeof file.env === "object") {
		handled.add("env");
		const env = file.env as Json;
		const keys = Object.keys(env);
		if (known.has("env")) {
			const borrowed = typeof env.CLAUDE_CODE_SUBAGENT_MODEL === "string" ? `env.CLAUDE_CODE_SUBAGENT_MODEL = "${env.CLAUDE_CODE_SUBAGENT_MODEL}"` : undefined;
			if (borrowed) report.used.push(borrowed);
			const rest = keys.filter((k) => k !== "CLAUDE_CODE_SUBAGENT_MODEL");
			if (rest.length) report.ignored.push(`env (${countNoun(rest.length, "variable")} — One Code does not export settings env blocks)`);
		} else if (keys.length) {
			report.refused.push(`env (${keys.length}) — a repository's env block is not applied`);
		}
	}
	if (file.autoMode && typeof file.autoMode === "object") {
		handled.add("autoMode");
		const auto = file.autoMode as Json;
		const keys = Object.keys(auto);
		if (known.has("autoMode")) {
			if (scope === "claude-user" && ("classifierModel" in auto || "classifierModelSetFor" in auto)) {
				report.refused.push("autoMode.classifierModel — One Code's own key, read from ~/.onecode/settings.json only");
				findings.push({
					level: "warn",
					text: `${shortenHome(path, home)} carries autoMode.classifierModel, a One Code key that is now read only from ~/.onecode/settings.json; the value here is ignored.`,
					fix: "Move it with /auto-mode model (which writes the new location) and delete the stale key from ~/.claude/settings.json.",
				});
			}
			const consumed = keys.filter((k) => !(scope === "claude-user" && (k === "classifierModel" || k === "classifierModelSetFor")));
			if (consumed.length) report.used.push(`autoMode: ${consumed.join(", ")}`);
		} else {
			report.refused.push(`autoMode (${keys.join(", ")}) — never read from a repository's files`);
			findings.push({
				level: "warn",
				text: `${shortenHome(path, home)} has an autoMode block; auto-mode configuration is read from user and managed settings only, so it is ignored here (Claude Code does the same).`,
				fix: "Move the block to ~/.onecode/settings.json (or run /auto-mode setup there).",
			});
		}
	}
	if (scope === "claude-user" && ("subagentModel" in file || "subagentModelSetFor" in file)) {
		handled.add("subagentModel").add("subagentModelSetFor");
		report.refused.push("subagentModel — One Code's own key, read from ~/.onecode/settings.json only");
		findings.push({
			level: "warn",
			text: `${shortenHome(path, home)} carries subagentModel, a One Code key that is now read only from ~/.onecode/settings.json; the value here is ignored.`,
			fix: "Re-set it with /subagent (which writes the new location) and delete the stale key from ~/.claude/settings.json.",
		});
	}
	if (scope === "onecode-user") {
		if (typeof file.subagentModel === "string") report.used.push(`subagentModel "${file.subagentModel}"`);
		if (file.webSearch && typeof file.webSearch === "object") report.used.push("webSearch (keys/order for the search fallback)");
	}
	for (const key of ["enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"]) {
		if (key in file && known.has(key)) report.used.push(`${key}: ${Array.isArray(file[key]) ? count(file[key]) : String(file[key])}`);
	}
	if ("disabledMcpServers" in file && known.has("disabledMcpServers")) report.used.push(`disabledMcpServers: ${count(file.disabledMcpServers)} (via /mcp disable)`);

	for (const key of Object.keys(file)) {
		if (known.has(key) || SILENT_KEYS.has(key) || handled.has(key)) continue;
		report.ignored.push(key);
	}
	return report;
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		try {
			const stat = statSync(full);
			if (stat.isDirectory()) walkMarkdown(full, out);
			else if (entry.endsWith(".md")) out.push(full);
		} catch {
			// unreadable entry: skip
		}
	}
	return out;
}

export interface CompatInput {
	cwd: string;
	home: string;
	agentDir: string;
	env: NodeJS.ProcessEnv;
	/** `<package>/agents`, so bundled agents are counted. */
	bundledAgentsDir?: string;
}

export function collectCompat(input: CompatInput): CompatReport {
	const { cwd, home, agentDir, env } = input;
	const findings: Finding[] = [];
	const claudeDir = claudeUserDir(home, env);
	const claude = settingsPaths(cwd, home);

	const files: SettingsFileReport[] = [
		summarizeFile("claude-user", "Claude Code user settings", claudeUserSettingsPath(home), home, findings),
		summarizeFile("claude-project", "project settings (checked in)", claude.project, home, findings),
		summarizeFile("claude-local", "project settings (local)", claude.local, home, findings),
		...managedSettingsPaths().map((path) => summarizeFile("managed", "managed settings (organisation policy)", path, home, findings)),
		summarizeFile("claude-json", "Claude Code's .claude.json", claudeJsonPath(home, env), home, findings),
		summarizeFile("onecode-user", "One Code user settings", oneCodeSettingsPath(home, env), home, findings),
		summarizeFile("onecode-project", "One Code per-repository settings", oneCodeProjectSettingsPath(cwd, home, env), home, findings),
	];

	// Context files, sized — the block every turn pays for.
	const contextFiles: ContextFileReport[] = discoverContextFilePaths({
		cwd,
		homeClaudeDir: claudeDir,
		homeOneCodeDir: join(home, ".onecode"),
		agentsFallback: true,
	}).map(({ path, descriptor }) => {
		let chars = 0;
		try {
			chars = readFileSync(path, "utf-8").length;
		} catch {
			// unreadable: reported as 0 chars
		}
		const warning = claudeMdLimitWarning(basename(path), chars);
		if (warning) {
			findings.push({ level: "warn", text: `${shortenHome(path, home)}: ${warning}`, fix: `Trim it below ${CLAUDE_MD_CHAR_LIMIT / 1000}k chars, or run /doctor fix to have the model propose what to cut.` });
		}
		return { path, descriptor, chars, overLimit: warning !== null };
	});

	// Auto-memory (shared with Claude Code).
	const memDir = projectMemoryDir(cwd, home);
	const indexPath = join(memDir, "MEMORY.md");
	let indexStatus: "ok" | "near" | "over" | undefined;
	if (existsSync(indexPath)) {
		try {
			indexStatus = indexLimitStatus(readFileSync(indexPath, "utf-8"));
		} catch {
			indexStatus = undefined;
		}
		if (indexStatus === "over") findings.push({ level: "warn", text: `${shortenHome(indexPath, home)} is over the 200-line / 25KB load limit; entries past it are dropped.`, fix: "Shorten the index to one line per entry (/memory opens it)." });
	}

	// Plugins (Claude Code-installed, read-through, plus One Code's own root).
	let discovered: DiscoveredPlugins | undefined;
	try {
		discovered = discoverPlugins(defaultDiscoverRoots(agentDir, cwd, home));
	} catch (error) {
		findings.push({ level: "warn", text: `Plugin discovery failed: ${(error as Error).message}` });
	}
	const pluginCounts = (origin: "claude" | "one-code") => {
		const list = (discovered?.plugins ?? []).filter((p) => p.originRoot === origin);
		return { total: list.length, enabled: list.filter((p) => p.enabled).length };
	};

	// Agents.
	const agentFailed: string[] = [];
	const countAgents = (dir: string): number => {
		let ok = 0;
		for (const file of walkMarkdown(dir)) {
			let content = "";
			try {
				content = readFileSync(file, "utf-8");
			} catch {
				continue;
			}
			if (parseAgentFile(file, content)) ok++;
			else agentFailed.push(file);
		}
		return ok;
	};
	const [userAgentsDir, projectAgentsDir] = agentDirs(cwd, home);
	const agents = {
		user: countAgents(userAgentsDir),
		project: countAgents(projectAgentsDir),
		plugin: (discovered?.agentDirs ?? []).reduce((n, d) => n + walkMarkdown(d.dir).length, 0),
		bundled: input.bundledAgentsDir ? walkMarkdown(input.bundledAgentsDir).length : 0,
		failed: agentFailed,
	};
	for (const file of agentFailed) {
		findings.push({ level: "warn", text: `Agent file ${shortenHome(file, home)} has no body and is skipped.`, fix: "Add the agent's instructions below the frontmatter, or remove the file." });
	}

	// Skills.
	const scanned = scanSkills(cwd, home, agentDir, discovered?.skills ?? [], BUNDLED_SKILLS_DIR);
	const noDescription: string[] = [];
	for (const skill of scanned) {
		try {
			const { frontmatter } = parseFrontmatterLoosely(readFileSync(skill.path, "utf-8"));
			if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) noDescription.push(skill.path);
		} catch {
			// unreadable SKILL.md: pi reports it when it loads
		}
	}
	const bundledSkills = scanned.filter((s) => s.path.startsWith(BUNDLED_SKILLS_DIR)).length;
	const skills = {
		user: scanned.filter((s) => s.scope === "user" && !s.path.startsWith(BUNDLED_SKILLS_DIR)).length,
		project: scanned.filter((s) => s.scope === "project" && !s.path.startsWith(BUNDLED_SKILLS_DIR)).length,
		plugin: scanned.filter((s) => s.scope === "plugin").length,
		bundled: bundledSkills,
		noDescription,
	};
	for (const path of noDescription) {
		findings.push({
			level: "warn",
			text: `${shortenHome(path, home)} has no description in its frontmatter (malformed YAML drops every field), so the model matches it against its first body line.`,
			fix: "Give the skill `name:` and `description:` lines between the leading `---` markers.",
		});
	}

	// Hooks.
	const hookDiagnostics: string[] = [];
	const hooksLoaded = loadHookSettings(claudeDir, cwd);
	hookDiagnostics.push(...hooksLoaded.diagnostics);
	const pluginHooks = discovered ? loadPluginHooks(defaultDiscoverRoots(agentDir, cwd, home), hookDiagnostics) : [];
	const hookSources = [...hooksLoaded.sources, ...pluginHooks];
	const hookCommands = hookSources.reduce(
		(n, source) => n + Object.values(source.config).reduce((m, groups) => m + (groups ?? []).reduce((k, g) => k + g.hooks.length, 0), 0),
		0,
	);
	for (const diagnostic of hookDiagnostics) findings.push({ level: "warn", text: `Hooks: ${diagnostic}` });

	// MCP.
	const configErrors: string[] = [];
	const servers = loadServers(cwd, home, env, discovered?.mcpConfigs ?? [], {
		pluginNames: discovered?.mcpConfigPlugins,
		onError: (path, message) => configErrors.push(`${shortenHome(path, home)}: ${message}`),
	});
	for (const error of configErrors) findings.push({ level: "error", text: `MCP config ${error} — its servers are not loaded.`, fix: "Fix the JSON and run /mcp reconnect." });
	for (const server of servers) {
		if (server.missingEnv?.length) {
			findings.push({
				level: "warn",
				text: `MCP server "${server.name}" references unset environment variable${server.missingEnv.length === 1 ? "" : "s"} ${server.missingEnv.join(", ")} (from ${shortenHome(server.source, home)}).`,
				fix: "Export the variable before launching, or the server will fail to connect.",
			});
		}
	}

	return {
		files,
		contextFiles,
		memory: { dir: memDir, indexExists: existsSync(indexPath), indexStatus },
		agents,
		skills,
		commands: promptTemplateNames(cwd, home, agentDir).length,
		plugins: { claude: pluginCounts("claude"), oneCode: pluginCounts("one-code") },
		hooks: { sources: hookSources, commands: hookCommands, diagnostics: hookDiagnostics },
		mcp: { servers, disabled: readDisabledMcpServers(cwd, home, env), configErrors },
		findings,
	};
}

/** `user 2 · project 0 · plugin 7` — counts by origin, the noun being the origin not the thing counted. */
const byOrigin = (counts: Record<string, number>): string =>
	Object.entries(counts)
		.map(([origin, n]) => `${origin} ${n}`)
		.join(" · ");

export function importedConfigSection(compat: CompatReport, home: string): ReportSection {
	const lines: ReportLine[] = [];
	for (const file of compat.files) {
		if (!file.exists) continue;
		const path = shortenHome(file.path, home);
		if (!file.valid) {
			lines.push({ text: `${file.label} ${path}: invalid JSON — ignored`, level: "error" });
			continue;
		}
		const used = file.used.length ? file.used.join(" · ") : "nothing One Code reads";
		lines.push({ text: `${file.label} ${path}: ${used}`, level: "ok" });
		for (const refused of file.refused) lines.push({ text: `not honoured here: ${refused}`, indent: 1, level: "warn" });
		if (file.ignored.length) lines.push({ text: `not used by One Code: ${file.ignored.join(", ")}`, indent: 1, level: "dim" });
	}
	if (lines.length === 0) lines.push({ text: "No settings files found — defaults apply (auto permission mode, no hooks, no plugins).", level: "dim" });

	if (compat.contextFiles.length) {
		const total = compat.contextFiles.reduce((n, f) => n + f.chars, 0);
		lines.push({ text: `Instruction files (${compat.contextFiles.length}, ${(total / 1000).toFixed(1)}k chars read every turn):`, level: "ok" });
		for (const file of compat.contextFiles) {
			lines.push({ text: `${shortenHome(file.path, home)} — ${(file.chars / 1000).toFixed(1)}k chars${file.overLimit ? " (over the 40k soft limit)" : ""}`, indent: 1, level: file.overLimit ? "warn" : "dim" });
		}
	} else {
		lines.push({ text: "Instruction files: none (no CLAUDE.md, AGENTS.md or ONECODE.md from here to the repository root)", level: "dim" });
	}
	lines.push({
		text: compat.memory.indexExists
			? `Auto-memory: ${shortenHome(compat.memory.dir, home)} (MEMORY.md ${compat.memory.indexStatus ?? "present"}; shared with Claude Code)`
			: `Auto-memory: ${shortenHome(compat.memory.dir, home)} (empty; created when the model saves its first note)`,
		level: "dim",
	});
	const a = compat.agents;
	lines.push({
		text: `Agents: ${byOrigin({ user: a.user, project: a.project, plugin: a.plugin, bundled: a.bundled })}${a.failed.length ? ` · ${a.failed.length} skipped` : ""}`,
		level: a.failed.length ? "warn" : "ok",
	});
	const s = compat.skills;
	lines.push({
		text: `Skills: ${byOrigin({ user: s.user, project: s.project, plugin: s.plugin, bundled: s.bundled })} · ${countNoun(compat.commands, "command template")}`,
		level: s.noDescription.length ? "warn" : "ok",
	});
	const p = compat.plugins;
	lines.push({
		text: `Plugins: ${p.claude.enabled}/${p.claude.total} Claude Code-installed enabled (read-only; toggle in /plugins), ${p.oneCode.enabled}/${p.oneCode.total} installed by One Code`,
		level: "ok",
	});
	if (compat.hooks.sources.length) {
		const scopes = compat.hooks.sources.map((s) => (s.pluginName ? `plugin ${s.pluginName}` : s.scope)).join(", ");
		lines.push({ text: `Hooks: ${countNoun(compat.hooks.commands, "command")} from ${scopes}`, level: compat.hooks.diagnostics.length ? "warn" : "ok" });
	} else {
		lines.push({ text: "Hooks: none configured", level: "dim" });
	}
	return { title: "Imported configuration", subtitle: "what One Code reads from your Claude Code and One Code files", lines };
}

export function mcpSection(compat: CompatReport, session: SessionView | undefined, home: string): ReportSection {
	const lines: ReportLine[] = [];
	const live = new Map((session?.mcp?.servers ?? []).map((s) => [s.name, s]));
	if (compat.mcp.servers.length === 0 && compat.mcp.configErrors.length === 0) {
		lines.push({ text: "No MCP servers configured (.mcp.json, ~/.claude.json, or a plugin's .mcp.json)", level: "dim" });
	}
	for (const server of compat.mcp.servers) {
		const status = live.get(server.name);
		const disabled = compat.mcp.disabled.has(server.name);
		const where = shortenHome(server.source, home);
		const shape = server.kind === "stdio" ? `stdio: ${server.command}` : `http: ${server.url}`;
		let state: string;
		let level: ReportLine["level"] = "ok";
		if (disabled) {
			state = "disabled (/mcp enable to turn on)";
			level = "dim";
		} else if (status) {
			state = status.status === "connected" ? `connected${status.toolCount !== undefined ? ` · ${status.toolCount} tools` : ""}` : status.status === "authNeeded" ? "needs authentication (/mcp)" : status.status === "connecting" ? "connecting…" : `failed${status.detail ? `: ${status.detail}` : ""}`;
			level = status.status === "connected" ? "ok" : status.status === "connecting" ? "dim" : "warn";
		} else {
			state = server.missingEnv?.length ? `missing ${server.missingEnv.join(", ")}` : "configured (status known once a session connects)";
			level = server.missingEnv?.length ? "warn" : "dim";
		}
		lines.push({ text: `${server.name} — ${shape} · ${state}`, level });
		lines.push({ text: `from ${where}`, indent: 1, level: "dim" });
	}
	for (const error of compat.mcp.configErrors) lines.push({ text: `config error: ${error}`, level: "error" });
	return { title: "MCP servers", lines };
}
