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
import { INSTALL_HINTS } from "../lsp/install-hints.ts";
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
	mcpServers: McpServer[];
	sessionModel?: Model<Api>;
	webSearchSettings: WebSearchSettings;
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

	const rg = which("rg");
	checks.push({ name: "rg", found: !!rg, path: rg, need: "optional", reason: "faster code search when the model shells out to ripgrep", hint: "brew install ripgrep" });

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
			hint: INSTALL_HINTS[config.command],
		});
		if (needed && !found) {
			findings.push({
				level: "warn",
				text: `${config.command} is not installed, so the model gets no language-server diagnostics after editing ${family[0]} files here.`,
				fix: INSTALL_HINTS[config.command] ? `Install it with: ${INSTALL_HINTS[config.command]}` : "Install it and make sure it is on your PATH.",
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
