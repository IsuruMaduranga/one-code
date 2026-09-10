/**
 * Assemble the doctor report from gathered inputs (pure).
 *
 * Section order is the order a first-session user needs answers in: is the
 * install sound, is any provider ready, which model does each role get, what
 * would the presets change, what of my Claude Code setup was picked up, are my
 * MCP servers reachable, what external programs are missing — then the issues.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { extensionVersion } from "../lib/package-version.ts";
import { piVersionWarning, TESTED_PI_MAX_EXCLUSIVE, TESTED_PI_MIN } from "../lib/pi-version.ts";
import { modelSpec } from "../lib/model-policy.ts";
import { readJsonFile } from "../lib/atomic-write.ts";
import { oneCodeSettingsPath } from "../lib/one-code-settings.ts";
import { webSearchSettingsFrom } from "../web/backends.ts";
import { collectCompat, importedConfigSection, mcpSection } from "./compat.ts";
import { checkDependencies, dependenciesSection } from "./dependencies.ts";
import { collectModelFacts, modelsSection } from "./models.ts";
import { computePresets, presetsSection } from "./presets.ts";
import {
	type DoctorEnvironment,
	type DoctorReport,
	type Finding,
	type RegistryView,
	REPORT_TITLE,
	type ReportLine,
	type ReportSection,
	type SessionView,
	shortenHome,
} from "./report.ts";

export const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

/** The environment variables a first-time user is most likely to already have; hinted when nothing is configured. */
export const COMMON_KEY_ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"];

const AUTH_SOURCE_LABEL: Record<string, string> = {
	stored: "key saved by /login",
	environment: "environment variable",
	runtime: "provided by an extension",
	fallback: "default credentials",
	models_json_key: "key in models.json",
	models_json_command: "key command in models.json",
};

export function installationSection(env: DoctorEnvironment, findings: Finding[]): ReportSection {
	const lines: ReportLine[] = [];
	const pi = env.piVersion ? ` · pi ${env.piVersion}` : "";
	lines.push({
		text: env.install === "app" ? `Running: the bundled onecode app ${env.oneCodeVersion}${pi}` : `Running: one-code-extension ${env.oneCodeVersion} on your own pi${pi}`,
		level: "ok",
	});
	lines.push({ text: `Node ${env.nodeVersion} · ${env.platform}-${env.arch}`, level: "dim" });
	lines.push({ text: `pi agent dir: ${shortenHome(env.agentDir, env.home)} (auth, models, sessions, pi settings)`, level: "dim" });
	lines.push({ text: `One Code state: ${shortenHome(env.stateDir, env.home)} (own settings, plans)`, level: "dim" });
	const claudeDir = env.env.CLAUDE_CONFIG_DIR ? `${env.env.CLAUDE_CONFIG_DIR} (CLAUDE_CONFIG_DIR)` : shortenHome(`${env.home}/.claude`, env.home);
	lines.push({ text: `Claude Code config read from: ${claudeDir} (never written)`, level: "dim" });

	const versionWarning = piVersionWarning(env.piVersion);
	if (versionWarning) {
		lines.push({ text: `pi ${env.piVersion} is outside the tested range ${TESTED_PI_MIN} – <${TESTED_PI_MAX_EXCLUSIVE}`, level: "warn" });
		findings.push({ level: "warn", text: versionWarning, fix: env.install === "app" ? "Upgrade One Code (it pins a tested pi)." : "Update one-code-extension, or pin pi inside the tested range." });
	}

	if (env.latest) {
		switch (env.latest.status) {
			case "current":
				lines.push({ text: `Updates: up to date (${env.oneCodeVersion} is the latest release)`, level: "ok" });
				break;
			case "behind":
				lines.push({
					text: `Updates: ${env.latest.version} is available (you have ${env.oneCodeVersion}) — ${env.install === "app" ? "npm install -g @one-ai/one-code" : "pi update"}`,
					level: "warn",
				});
				break;
			case "skipped":
				lines.push({ text: `Updates: check skipped (${env.latest.reason ?? "offline"})`, level: "dim" });
				break;
			default:
				lines.push({ text: `Updates: could not check the registry${env.latest.reason ? ` (${env.latest.reason})` : ""}`, level: "dim" });
		}
	}
	return { title: "Installation", lines };
}

export interface ProviderSummary {
	provider: string;
	name: string;
	ready: boolean;
	source?: string;
	models: number;
	available: number;
}

export function summarizeProviders(registry: RegistryView): ProviderSummary[] {
	const byProvider = new Map<string, { models: number; available: number }>();
	for (const model of registry.all) {
		const entry = byProvider.get(model.provider) ?? { models: 0, available: 0 };
		entry.models++;
		byProvider.set(model.provider, entry);
	}
	for (const model of registry.available) {
		const entry = byProvider.get(model.provider) ?? { models: 0, available: 0 };
		entry.available++;
		byProvider.set(model.provider, entry);
	}
	const out: ProviderSummary[] = [];
	for (const [provider, counts] of byProvider) {
		let status: { configured: boolean; source?: string; label?: string } = { configured: false };
		try {
			status = registry.authStatus(provider);
		} catch {
			// a provider the registry cannot answer for counts as not configured
		}
		const ready = status.configured || counts.available > 0;
		const source = status.source ? AUTH_SOURCE_LABEL[status.source] ?? status.source : undefined;
		out.push({
			provider,
			name: registry.displayName?.(provider) ?? provider,
			ready,
			source: source && status.label && status.source === "environment" ? `${source} ${status.label}` : source,
			models: counts.models,
			available: counts.available,
		});
	}
	return out.sort((a, b) => Number(b.ready) - Number(a.ready) || a.provider.localeCompare(b.provider));
}

export function providersSection(registry: RegistryView, findings: Finding[]): { section: ReportSection; readyCount: number } {
	const providers = summarizeProviders(registry);
	const ready = providers.filter((p) => p.ready);
	const lines: ReportLine[] = [];
	for (const provider of ready) {
		const models = provider.available || provider.models;
		lines.push({
			text: `${provider.name} (${provider.provider}): ready — ${provider.source ?? "credentials configured"} · ${models} model${models === 1 ? "" : "s"}`,
			level: "ok",
		});
	}
	const rest = providers.length - ready.length;
	if (ready.length === 0) {
		lines.push({ text: `No provider has credentials (${rest} known providers)`, level: "error" });
		findings.push({
			level: "error",
			text: "No model provider is configured, so no session can send a request yet.",
			fix: `Run /login inside One Code, or export a key such as ${COMMON_KEY_ENV_VARS.slice(0, 2).join(" or ")} before launching. Free options: OpenCode Zen (deepseek-v4-flash-free) and OpenRouter's :free models.`,
		});
	} else if (rest > 0) {
		lines.push({ text: `${rest} more provider${rest === 1 ? "" : "s"} without credentials — /login to add one, or set its API-key environment variable`, level: "dim" });
	}
	return { section: { title: "Providers", lines }, readyCount: ready.length };
}

export interface BuildInput {
	env: DoctorEnvironment;
	registry: RegistryView;
	session: SessionView;
}

export function buildDoctorReport({ env, registry, session }: BuildInput): DoctorReport {
	const findings: Finding[] = [];
	const sections: ReportSection[] = [];

	sections.push(installationSection(env, findings));
	const providers = providersSection(registry, findings);
	sections.push(providers.section);

	const facts = collectModelFacts(registry.available, session, env.home, env.env);
	sections.push(modelsSection(facts, session, findings));

	const presets = computePresets(registry.available, session.model);
	sections.push(presetsSection(presets, session.model));

	const compat = collectCompat({ cwd: env.cwd, home: env.home, agentDir: env.agentDir, env: env.env, bundledAgentsDir: BUNDLED_AGENTS_DIR });
	findings.push(...compat.findings);
	sections.push(importedConfigSection(compat, env.home));
	sections.push(mcpSection(compat, session, env.home));

	const webSearchSettings = webSearchSettingsFrom(readJsonFile<{ webSearch?: unknown }>(oneCodeSettingsPath(env.home, env.env))?.webSearch);
	const deps = checkDependencies({ cwd: env.cwd, env: env.env, platform: env.platform, mcpServers: compat.mcp.servers, sessionModel: session.model, webSearchSettings });
	findings.push(...deps.findings);
	sections.push(dependenciesSection(deps));

	// Errors first, then warnings, in discovery order within each.
	findings.sort((a, b) => Number(b.level === "error") - Number(a.level === "error"));
	const ready = providers.readyCount > 0 && session.model !== undefined && !findings.some((f) => f.level === "error");

	return {
		title: REPORT_TITLE,
		summary: summaryText({ ready, providersReady: providers.readyCount, main: session.model, subagent: facts.subagent.model, classifier: facts.classifier.model, files: compat.files.filter((f) => f.exists).length, contextFiles: compat.contextFiles.length, findings }),
		sections,
		findings,
		ready,
	};
}

function summaryText(input: {
	ready: boolean;
	providersReady: number;
	main?: Model<Api>;
	subagent?: Model<Api>;
	classifier?: Model<Api>;
	files: number;
	contextFiles: number;
	findings: Finding[];
}): string {
	const errors = input.findings.filter((f) => f.level === "error").length;
	const warnings = input.findings.length - errors;
	const config = `${input.files} settings file${input.files === 1 ? "" : "s"} and ${input.contextFiles} instruction file${input.contextFiles === 1 ? "" : "s"} are in use.`;
	if (input.providersReady === 0 || !input.main) {
		return `Not ready: no model provider has credentials, so nothing can run yet. Connect one with /login (or an API-key environment variable), then rerun /doctor. ${config}`;
	}
	const roles = `Main model ${modelSpec(input.main)}${input.subagent ? `, subagents on ${modelSpec(input.subagent)}` : ""}${input.classifier ? `, auto-mode classifier ${modelSpec(input.classifier)}` : ""}.`;
	if (!input.ready) return `${errors} problem${errors === 1 ? "" : "s"} need attention (listed at the bottom). ${roles} ${config}`;
	const tail = warnings ? `${warnings} warning${warnings === 1 ? "" : "s"} below; none blocks a session.` : "No issues found.";
	return `Ready. ${roles} ${config} ${tail}`;
}

/** The extension's own version — the app overrides it with CC_VERSION (lockstep releases). */
export function oneCodeVersion(env: NodeJS.ProcessEnv = process.env): string {
	return env.CC_VERSION ?? extensionVersion();
}
