/**
 * External programs One Code leans on (pure fs): present on PATH or not, and
 * whether THIS project needs them.
 *
 * Nothing here is required to start a session — One Code searches with bash and
 * talks to providers over HTTPS — so the report distinguishes "needed for this
 * project" (a language server for a language the working directory contains,
 * the command an MCP server is configured to spawn) from "optional" (ripgrep)
 * and never turns a missing optional into a problem. Web search is listed here
 * too: which route a search would take on the current provider, since on most
 * providers it depends on a third-party key.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { whichOnPath } from "../lib/which.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getProviderKind } from "pi-web-search/src/api.ts";
import { installHint, serverInstallHint } from "../lsp/install-hints.ts";
import { SERVERS } from "../lsp/servers.ts";
import { typescriptPreflight } from "../lsp/servers.ts";
import type { McpServer } from "../mcp/config.ts";
import { BRAVE_KEY_ENV, resolveChain, TAVILY_KEY_ENV, type WebSearchSettings } from "../web/backends.ts";
import type { Finding, ReportLine, ReportSection } from "./report.ts";

export type DependencyNeed = "required" | "project" | "optional" | "unused";

export interface DependencyCheck {
	name: string;
	found: boolean;
	path?: string;
	need: DependencyNeed;
	/** Why it matters, user-facing. */
	reason: string;
	/** Install command when known. */
	hint?: string;
}

export type WebSearchRoute = "provider-native" | "brave" | "tavily" | "exa-free" | "none";

export interface DependencyReport {
	checks: DependencyCheck[];
	webSearch: { route: WebSearchRoute; detail: string };
	findings: Finding[];
}

/** Languages the working directory plausibly contains, by the LSP table's own root markers. */
export function projectLanguages(cwd: string): string[] {
	const seen = new Map<string, string>(); // command → languageId (one per server binary)
	for (const [languageId, config] of Object.entries(SERVERS)) {
		if (seen.has(config.command)) continue;
		if (config.rootMarkers.some((marker) => existsSync(join(cwd, marker)))) seen.set(config.command, languageId);
	}
	return [...seen.values()];
}

/** Whether the model's provider has a search API of its own — pi-web-search's judgement, the same gate the web_search tool uses. */
export function providerHasNativeSearch(model: Model<Api> | undefined): boolean {
	return model !== undefined && getProviderKind(model) !== "unsupported";
}

export interface DependencyInput {
	cwd: string;
	env: NodeJS.ProcessEnv;
	platform?: string;
	/** pi's agent dir; its `bin/` holds the ripgrep pi downloads itself. */
	agentDir?: string;
	mcpServers: McpServer[];
	sessionModel?: Model<Api>;
	webSearchSettings: WebSearchSettings;
	/**
	 * The shell tools as the session resolves them (build.ts, from
	 * lib/shell-spawn.ts + powershell/policy.ts): which bash, which PowerShell,
	 * which one is primary, and the startup notices. On Windows this is the
	 * first thing a user asks the doctor — "which shells did you find?" — and
	 * the report had no line for it until 2026-09-19 (the Vultr VM session).
	 */
	shells?: ShellsInput;
}

export interface ShellsInput {
	/** The bash binary the bash tool runs, or undefined when none exists. */
	bash?: string;
	/** An ignored CLAUDE_CODE_GIT_BASH_PATH, in the resolver's words. */
	bashWarning?: string;
	/** The PowerShell executable the powershell tool would run, or undefined. */
	powershell?: string;
	/** From `shellToolPolicy`: the tool is meant to be on (env switch, else Windows). */
	powershellWanted: boolean;
	/** From `shellToolPolicy`: a bash is part of this platform's expected shape (not Windows). */
	bashExpected: boolean;
	primary: "powershell" | "bash" | "none";
	notices: string[];
}

function bashReason(s: ShellsInput): string {
	if (s.primary === "bash") return "the primary shell tool";
	if (s.bash) return "the bash tool, alongside PowerShell";
	return s.bashExpected ? "the bash tool" : "the bash tool (Git for Windows provides one)";
}

function powershellReason(s: ShellsInput): string {
	if (!s.powershellWanted) return s.bashExpected ? "the powershell tool (off; CLAUDE_CODE_USE_POWERSHELL_TOOL=1 turns it on with a pwsh on PATH)" : "the powershell tool (off: CLAUDE_CODE_USE_POWERSHELL_TOOL=0)";
	return s.primary === "powershell" ? "the primary shell tool" : "the powershell tool";
}

export function checkDependencies(input: DependencyInput): DependencyReport {
	const { cwd, env } = input;
	const platform = input.platform ?? process.platform;
	const findings: Finding[] = [];
	const checks: DependencyCheck[] = [];
	const which = (command: string) => whichOnPath(command, env, platform);

	const git = which("git");
	checks.push({ name: "git", found: !!git, path: git, need: "required", reason: "repository detection, auto mode's recoverability check, worktree isolation", hint: "https://git-scm.com/downloads" });
	if (!git) findings.push({ level: "warn", text: "git is not on PATH: worktree isolation and auto mode's git-recoverability check are unavailable.", fix: "Install git and make sure it is on the PATH used to launch One Code." });

	// pi downloads ripgrep into <agentDir>/bin on first run when PATH has none
	// and puts that dir on the shell tools' PATH, so a copy there is "found".
	const rgName = platform === "win32" ? "rg.exe" : "rg";
	const bundledRg = input.agentDir ? join(input.agentDir, "bin", rgName) : undefined;
	if (input.shells) {
		const s = input.shells;
		checks.push({ name: "bash", found: !!s.bash, path: s.bash, need: s.bashExpected ? "required" : "optional", reason: bashReason(s), hint: s.bashExpected ? undefined : "https://git-scm.com/download/win" });
		checks.push({ name: "powershell", found: !!s.powershell, path: s.powershell, need: s.powershellWanted ? "required" : "unused", reason: powershellReason(s), hint: "https://aka.ms/powershell" });
		if (s.bashWarning) findings.push({ level: "warn", text: s.bashWarning, fix: "Point CLAUDE_CODE_GIT_BASH_PATH at a bash.exe or sh.exe, or unset it to use Git for Windows' default location." });
		for (const notice of s.notices) {
			const switchSet = notice.includes("CLAUDE_CODE_USE_POWERSHELL_TOOL");
			findings.push({
				level: s.primary === "none" ? "error" : "warn",
				text: notice,
				fix: switchSet ? "Install PowerShell 7 (pwsh) or unset CLAUDE_CODE_USE_POWERSHELL_TOOL." : "Install Git for Windows or PowerShell 7.",
			});
		}
	}

	const rg = which("rg") ?? (bundledRg && existsSync(bundledRg) ? bundledRg : undefined);
	checks.push({ name: "rg", found: !!rg, path: rg, need: "optional", reason: "faster code search when the model shells out to ripgrep", hint: installHint("ripgrep", platform) });

	const languages = projectLanguages(cwd);
	const seenCommands = new Set<string>();
	for (const [languageId, config] of Object.entries(SERVERS)) {
		if (seenCommands.has(config.command)) continue;
		seenCommands.add(config.command);
		const found = which(config.command);
		const needed = languages.includes(languageId);
		const family = Object.entries(SERVERS).filter(([, c]) => c.command === config.command).map(([id]) => id);
		checks.push({
			name: config.command,
			found: !!found,
			path: found,
			need: needed ? "project" : "unused",
			reason: `lsp_diagnostics for ${family.join("/")}${needed ? " (this project)" : ""}`,
			hint: serverInstallHint(config.command, platform),
		});
		if (needed && !found) {
			findings.push({
				level: "warn",
				text: `${config.command} is not installed, so the model gets no language-server diagnostics after editing ${family[0]} files here.`,
				fix: serverInstallHint(config.command, platform) ? `Install it with: ${serverInstallHint(config.command, platform)}` : "Install it and make sure it is on your PATH.",
			});
		}
		if (needed && found && config.command === "typescript-language-server") {
			const preflight = typescriptPreflight(cwd);
			if (preflight) findings.push({ level: "warn", text: preflight });
		}
	}

	for (const server of input.mcpServers) {
		if (server.kind !== "stdio") continue;
		const command = server.command;
		const found = which(command);
		checks.push({ name: command, found: !!found, path: found, need: "project", reason: `spawns MCP server "${server.name}"` });
		if (!found) {
			findings.push({
				level: "warn",
				text: `MCP server "${server.name}" runs "${command}", which is not on PATH; it will fail to start.`,
				fix: "Install the command, or use its absolute path in the server config.",
			});
		}
	}

	const webSearch = webSearchRoute(input);
	return { checks, webSearch, findings };
}

export function webSearchRoute(input: Pick<DependencyInput, "env" | "sessionModel" | "webSearchSettings">): DependencyReport["webSearch"] {
	if (providerHasNativeSearch(input.sessionModel)) {
		return { route: "provider-native", detail: `${input.sessionModel!.provider} has its own search API; web_search uses it` };
	}
	// The same chain the web_search tool builds, so the report names the route a session would take.
	const first = resolveChain(input.env, input.webSearchSettings)[0];
	if (!first || first.keyless) {
		return {
			route: "exa-free",
			detail: `no provider search and no ${BRAVE_KEY_ENV}/${TAVILY_KEY_ENV}: falls back to Exa's free, rate-limited endpoint (results are labelled)`,
		};
	}
	const envVar = first.name === "brave" ? BRAVE_KEY_ENV : TAVILY_KEY_ENV;
	return { route: first.name, detail: `${first.label} (${input.env[envVar]?.trim() ? envVar : "key in ~/.onecode/settings.json"})` };
}

export function dependenciesSection(report: DependencyReport): ReportSection {
	const lines: ReportLine[] = [];
	const label: Record<DependencyNeed, string> = { required: "needed", project: "needed for this project", optional: "optional", unused: "not needed here" };
	const ordered = [...report.checks].sort((a, b) => rank(a) - rank(b));
	for (const check of ordered) {
		const state = check.found ? `found${check.path ? ` (${check.path})` : ""}` : "not found";
		const level: ReportLine["level"] = check.found ? (check.need === "unused" ? "dim" : "ok") : check.need === "unused" || check.need === "optional" ? "dim" : "warn";
		const hint = !check.found && check.hint && check.need !== "unused" ? ` — install: ${check.hint}` : "";
		lines.push({ text: `${check.name}: ${state} · ${label[check.need]} · ${check.reason}${hint}`, level });
	}
	lines.push({ text: `Web search: ${report.webSearch.detail}`, level: report.webSearch.route === "exa-free" ? "dim" : "ok" });
	return { title: "Dependencies", lines };
}

const NEED_RANK: Record<DependencyNeed, number> = { required: 0, project: 1, optional: 2, unused: 3 };
const rank = (check: DependencyCheck): number => NEED_RANK[check.need] * 2 + (check.found ? 1 : 0);
