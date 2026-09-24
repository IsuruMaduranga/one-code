/**
 * Consent for a repository's own allow rules. `.claude/settings.json` and
 * `.claude/settings.local.json` travel with the checkout, so an allow rule in
 * them is a grant made by whoever committed the file, not by the user running
 * One Code — and in auto mode a rule beats the classifier, so a cloned repo
 * shipping `Bash(curl:*)` would exfiltrate unclassified. Project hooks and
 * project `.mcp.json` servers already need a once-per-config consent
 * (hooks/trust.ts, mcp/trust.ts); this is the same shape for allow rules:
 * approval keyed to a hash of the rule list, persisted under `~/.onecode`, so
 * any change to the rules re-prompts. Deny and ask rules from the same files
 * never prompt — they can only tighten the gate.
 *
 * The prompt is lazy: it appears the first time a project rule would be the
 * deciding allow, not at startup (most sessions never hit one). A declined
 * prompt sticks for the process, not on disk. Pure fs + hashing here; the
 * permissions extension owns the dialog.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { oneCodeStateDir } from "../lib/paths.ts";

interface ApprovalStore {
	version: 1;
	approvals: Record<string, { rulesHash: string; approvedAt: string }>;
}

export function projectAllowStorePath(): string {
	return join(oneCodeStateDir(), "permissions", "project-allow-approvals.json");
}

/** Order-insensitive: the same rules in another order are one consent. */
export function hashProjectAllow(rules: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify([...rules].sort())).digest("hex");
}

export function readStoredProjectAllowApproval(projectRoot: string, storePath = projectAllowStorePath()): string | undefined {
	try {
		const store = JSON.parse(readFileSync(storePath, "utf-8")) as ApprovalStore;
		return store.approvals?.[projectRoot]?.rulesHash;
	} catch {
		return undefined;
	}
}

/** True when the stored consent covers exactly this rule list. */
export function projectAllowApproved(projectRoot: string, rules: readonly string[], storePath = projectAllowStorePath()): boolean {
	return rules.length > 0 && readStoredProjectAllowApproval(projectRoot, storePath) === hashProjectAllow(rules);
}

export function persistProjectAllowApproval(projectRoot: string, rules: readonly string[], storePath = projectAllowStorePath()): void {
	let store: ApprovalStore = { version: 1, approvals: {} };
	try {
		const existing = JSON.parse(readFileSync(storePath, "utf-8")) as ApprovalStore;
		if (existing && typeof existing === "object" && existing.approvals) store = existing;
	} catch {
		// Fresh store.
	}
	store.approvals[projectRoot] = { rulesHash: hashProjectAllow(rules), approvedAt: new Date().toISOString() };
	try {
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(storePath, `${JSON.stringify(store, null, "\t")}\n`);
	} catch {
		// Approval still holds for this session; it will just re-prompt next run.
	}
}

/**
 * The consent dialog's text: what the repository wants pre-approved (allow
 * rules, and workspace directories whose files it wants readable), and what
 * the current call would use: the rule it matches, or the directory it reads
 * inside.
 */
export type TrustFiring = { rule: string } | { dir: string };

export function describeProjectAllow(rules: readonly string[], firing: TrustFiring, dirs: readonly string[] = []): { title: string; message: string } {
	const list = (items: readonly string[]) => {
		const shown = items.slice(0, 8);
		return `${shown.join("\n")}${items.length > shown.length ? `\n… and ${items.length - shown.length} more` : ""}`;
	};
	const parts = [
		...(rules.length > 0 ? [`pre-approve ${rules.length} permission rule(s):\n${list(rules)}`] : []),
		...(dirs.length > 0 ? [`add ${dirs.length} workspace director${dirs.length === 1 ? "y" : "ies"}, whose files would be read without a prompt:\n${list(dirs)}`] : []),
	];
	return {
		title: dirs.length > 0 ? "Trust this repository's permission settings?" : "Trust this repository's allow rules?",
		message:
			`This repository's .claude settings ${parts.join("\n\nand ")}\n\n` +
			`The current call ${"dir" in firing ? `reads inside the workspace directory ${firing.dir}` : `matches "${firing.rule}"`} and would run without a prompt` +
			" (in auto mode, without the classifier). Whoever committed the file granted this, not you." +
			" Approval is remembered until these settings change; declining keeps them off for this session.",
	};
}

/** How a repository's workspace directory enters the consent list: distinct from any rule, and hashed with them. */
export const projectDirectoryConsentEntry = (raw: string): string => `additionalDirectories: ${raw}`;
