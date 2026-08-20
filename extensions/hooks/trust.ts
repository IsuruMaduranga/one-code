/**
 * Project-hook consent. Hooks in a repo's `.claude/settings.json` are
 * arbitrary code execution the moment the repo is opened, so they run only
 * after the user approves them — once per configuration: approval is keyed to
 * a hash of the project+local hook config and persisted under `~/.onecode`, so
 * it survives restarts but any change to the hooks re-prompts (Claude Code's
 * own hooks-review behaviour). User, managed, and plugin hooks never prompt
 * (installing a plugin was the consent).
 *
 * pi's own project-trust store is deliberately not reused: it only triggers
 * on `.pi/*` resources, so a repo with only `.claude/settings.json` would
 * never be asked — silently never approved.
 *
 * A declined prompt sticks for the process (module state), not on disk:
 * "no" means "not this session", not "never ask again".
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { oneCodeStateDir } from "../lib/paths.ts";
import type { HooksSource } from "./settings.ts";

interface ApprovalStore {
	version: 1;
	approvals: Record<string, { configHash: string; approvedAt: string }>;
}

export function approvalStorePath(): string {
	return join(oneCodeStateDir(), "hooks", "project-approvals.json");
}

/** Key order must not change the hash — two spellings of one config are one consent. */
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

export function hashProjectHooks(projectSources: HooksSource[]): string {
	const canonical = JSON.stringify(projectSources.map((source) => [source.scope, canonicalize(source.config)]));
	return createHash("sha256").update(canonical).digest("hex");
}

export function readStoredApproval(projectRoot: string, storePath = approvalStorePath()): string | undefined {
	try {
		const store = JSON.parse(readFileSync(storePath, "utf-8")) as ApprovalStore;
		return store.approvals?.[projectRoot]?.configHash;
	} catch {
		return undefined;
	}
}

export function persistApproval(projectRoot: string, configHash: string, storePath = approvalStorePath()): void {
	let store: ApprovalStore = { version: 1, approvals: {} };
	try {
		const existing = JSON.parse(readFileSync(storePath, "utf-8")) as ApprovalStore;
		if (existing && typeof existing === "object" && existing.approvals) store = existing;
	} catch {
		// Fresh store.
	}
	store.approvals[projectRoot] = { configHash, approvedAt: new Date().toISOString() };
	try {
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(storePath, `${JSON.stringify(store, null, "\t")}\n`);
	} catch {
		// Approval still holds for this session; it will just re-prompt next run.
	}
}

/** A short human summary of what the project wants to run, for the consent dialog. */
export function describeProjectHooks(projectSources: HooksSource[]): string {
	const commands: string[] = [];
	for (const source of projectSources) {
		for (const entries of Object.values(source.config)) {
			for (const entry of entries) {
				for (const hook of entry.hooks) commands.push(hook.command);
			}
		}
	}
	const shown = commands.slice(0, 5).map((cmd) => (cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd));
	const more = commands.length > shown.length ? `\n… and ${commands.length - shown.length} more` : "";
	return `${commands.length} command hook(s):\n${shown.join("\n")}${more}`;
}

export interface TrustDecisionDeps {
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean | undefined>;
	notify: (message: string) => void;
	storePath?: string;
}

/** Process-lifetime memory of declined/approved hashes per project, so a dispatch storm asks once. */
const sessionDecisions = new Map<string, boolean>();
const pendingPrompts = new Map<string, Promise<boolean>>();

/**
 * Whether the project/local hook sources may run. Resolves without prompting
 * when the stored approval matches; otherwise prompts once (concurrent
 * dispatches share the in-flight prompt) and persists a yes.
 */
export async function projectHooksApproved(
	projectRoot: string,
	projectSources: HooksSource[],
	deps: TrustDecisionDeps,
): Promise<boolean> {
	if (projectSources.length === 0) return true;
	const configHash = hashProjectHooks(projectSources);
	const key = `${projectRoot}:${configHash}`;

	const remembered = sessionDecisions.get(key);
	if (remembered !== undefined) return remembered;
	if (readStoredApproval(projectRoot, deps.storePath) === configHash) {
		sessionDecisions.set(key, true);
		return true;
	}
	if (!deps.hasUI) {
		sessionDecisions.set(key, false);
		deps.notify("Project hooks skipped: not yet approved and no UI to ask (user/managed hooks still run).");
		return false;
	}

	let pending = pendingPrompts.get(key);
	if (!pending) {
		pending = (async () => {
			const approved =
				(await deps.confirm(
					"Run this project's hooks?",
					`This project's .claude settings define ${describeProjectHooks(projectSources)}\n\nThey run as shell commands on your machine. Approval is remembered until the hook config changes.`,
				)) === true;
			sessionDecisions.set(key, approved);
			if (approved) persistApproval(projectRoot, configHash, deps.storePath);
			else deps.notify("Project hooks disabled for this session (user/managed hooks still run).");
			return approved;
		})().finally(() => pendingPrompts.delete(key));
		pendingPrompts.set(key, pending);
	}
	return pending;
}

/** Test seam. */
export function resetTrustSessionState(): void {
	sessionDecisions.clear();
	pendingPrompts.clear();
}
