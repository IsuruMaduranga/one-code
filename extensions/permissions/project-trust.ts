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

/** The consent dialog's text: what the repository wants pre-approved, and which rule fired now. */
export function describeProjectAllow(rules: readonly string[], firing: string): { title: string; message: string } {
	const shown = rules.slice(0, 8);
	const more = rules.length > shown.length ? `\n… and ${rules.length - shown.length} more` : "";
	return {
		title: "Trust this repository's allow rules?",
		message:
			`This repository's .claude settings pre-approve ${rules.length} permission rule(s):\n${shown.join("\n")}${more}\n\n` +
			`The current call matches "${firing}" and would run without a prompt` +
			" (in auto mode, without the classifier). Whoever committed the file granted this, not you." +
			" Approval is remembered until the rules change; declining keeps them off for this session.",
	};
}
