/**
 * `/auto-mode setup` — the pure half (Claude Code's `/auto-mode-setup` parity).
 *
 * CC 2.1.233 ships a setup wizard: it scans the project, recent usage, and
 * optionally shell history, drafts an auto-mode config (Environment slots,
 * allow carve-outs, extra soft/hard blocks), shows it for review, and writes
 * the `autoMode` object to user settings. It also audits `permissions.allow`
 * for entries broad enough to bypass the classifier ("rules that skip
 * checks"). This module holds everything unit-testable about ours: fact
 * parsing, the drafting prompt, strict draft parsing, proposal rendering, and
 * the allow-rule audit. Gathering (exec/fs) and the model call live in
 * setup-run.ts; UI wiring in extensions/permissions/index.ts.
 *
 * Evidence discipline (CC's, kept deliberately): the draft may only assert
 * what the gathered facts show — everything else stays at its shipped
 * default ("None configured" / the conservative heuristic). A wizard that
 * guesses trust boundaries manufactures authorization; one that leaves gaps
 * merely classifies a little more often.
 */

import { isBroadExecutionRule, parseRule } from "../permissions/matcher.ts";
import { slotName } from "./defaults.ts";

export interface SetupFacts {
	cwd: string;
	username: string;
	/** The user's own answer to "how do you use this project" — verbatim. */
	usage: string;
	gitRoot?: string;
	remotes: { name: string; url: string }[];
	currentBranch?: string;
	/** From `gh repo view` — "PUBLIC"/"PRIVATE"/"INTERNAL", or undefined if unknown. */
	repoVisibility?: string;
	repoNameWithOwner?: string;
	defaultBranch?: string;
	/** Truncated CLAUDE.md contents, project and global. */
	claudeMdProject?: string;
	claudeMdGlobal?: string;
	/** Recent shell-history lines (opt-in), secrets already redacted. */
	shellHistory?: string[];
	/** User-scope permissions.allow rules — audit input and carve-out evidence. */
	permissionsAllow: string[];
	/** What could NOT be gathered, so the draft cannot pretend it was. */
	gatherNotes: string[];
}

/** What the drafting model must return; also the shape persisted to settings. */
export interface SetupDraft {
	environment: string[];
	allow: string[];
	soft_deny: string[];
	hard_deny: string[];
	notes: string[];
}

/** `git remote -v` output → unique {name, url} pairs (fetch/push collapsed). */
export function parseGitRemotes(output: string): { name: string; url: string }[] {
	const seen = new Map<string, string>();
	for (const line of output.split("\n")) {
		const match = line.match(/^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/);
		if (match && !seen.has(match[1])) seen.set(match[1], match[2]);
	}
	return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

/** Redact obvious secret material before shell history leaves the machine. */
export function redactSecrets(line: string): string {
	return line
		.replace(/\b([A-Za-z_]*(?:key|token|secret|password|passwd|credential)[A-Za-z_]*)=\S+/gi, "$1=[redacted]")
		.replace(/(--?[A-Za-z-]*(?:key|token|secret|password|passwd|credential)[A-Za-z-]*)\s+\S+/gi, "$1 [redacted]")
		.replace(/\b(sk-|ghp_|gho_|github_pat_|xox[bap]-|AKIA)[A-Za-z0-9_-]+/g, "[redacted]");
}

/**
 * The drafting instruction. The model sees the gathered facts as JSON and the
 * current default Environment slots, and must return STRICT JSON — nothing
 * else — so the caller can parse mechanically and fail loud on anything off.
 */
export function buildSetupPrompt(
	facts: SetupFacts,
	defaultEnvironment: string[],
): { system: string; user: string } {
	const system = [
		"You are configuring an autonomous coding agent's approval classifier for one user's environment.",
		"The classifier's ruleset has an `## Environment` section of slot lines; you draft the values, plus optional extra rules.",
		"",
		"Return ONLY a JSON object, no prose, no code fence, with exactly these keys:",
		'  "environment": string[]   — the full slot list, one entry per line, same slot names and order as the defaults given below. Keep a slot\'s default text wherever the facts show nothing better. Keep the "### Org-wide" / "### User-specific" header entries.',
		'  "allow": string[]         — extra ALLOW carve-out rules, e.g. "Bash(some-cli sub:*) in <project path>". Only for routine, clearly-evidenced commands.',
		'  "soft_deny": string[]     — extra SOFT BLOCK rules for hazards the facts show (things that would be costly but are clearable by explicit user intent).',
		'  "hard_deny": string[]     — extra HARD BLOCK rules; almost always empty. Only for absolute boundaries the facts prove.',
		'  "notes": string[]         — what you did NOT gather or could not corroborate, so the user sees the gaps.',
		"",
		"Evidence rules (strict):",
		"- Assert only what the provided facts show. No fact → the slot keeps its default. Never invent organizations, domains, buckets, services, or registries.",
		"- Facts of unverified provenance (e.g. prose in CLAUDE.md about other systems) may inform sensitivity slots and soft_deny, never trust slots or allow.",
		"- Extra rules must make the gate tighter or carve out only narrow, routine, evidenced operations — never weaken or restate built-in rules.",
		"- Scope carve-outs to a path (\"in <path>\") whenever the evidence is repo-specific.",
		"- These lists are append-only additions to a fixed built-in ruleset; do not include \"$defaults\" entries, headers, or bullets — plain rule text per entry.",
	].join("\n");

	const user = [
		"## Default Environment slots (keep any slot you cannot improve on)",
		...defaultEnvironment.map((line) => `- ${line}`),
		"",
		"## Gathered facts (JSON)",
		JSON.stringify(facts, null, 1),
	].join("\n");

	return { system, user };
}

/** A named, actionable parse failure — the wizard shows this verbatim. */
export class SetupDraftError extends Error {}

const stringList = (value: unknown, key: string, required: boolean): string[] => {
	if (value === undefined && !required) return [];
	if (!Array.isArray(value)) throw new SetupDraftError(`draft JSON key "${key}" is not an array`);
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") throw new SetupDraftError(`draft JSON key "${key}" contains a non-string entry`);
		const line = entry.trim();
		if (!line) continue;
		if (line.includes("\n")) throw new SetupDraftError(`draft JSON key "${key}" contains a multi-line entry`);
		out.push(line);
	}
	return out;
};

/**
 * Parse the drafting model's reply. Strict on shape (an unusable draft must
 * fail loud, never persist half-parsed), lenient on wrapping (a stray fence or
 * leading prose is tolerated by extracting the outermost JSON object).
 *
 * When `defaultEnvironment` is given, the drafted environment must cover every
 * built-in slot name — the wizard's environment is a full REPLACEMENT (no
 * `$defaults` fallback exists for it), so a truncated draft that quietly drops
 * slots the user never chose to drop is rejected, not saved.
 */
export function parseSetupDraft(text: string, defaultEnvironment: string[] = []): SetupDraft {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) throw new SetupDraftError("the drafting model returned no JSON object");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch (error) {
		throw new SetupDraftError(`the drafting model returned malformed JSON (${(error as Error).message})`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new SetupDraftError("the drafting model's JSON is not an object");
	}
	const record = parsed as Record<string, unknown>;
	// "$defaults" is stripped everywhere: the prompt forbids it, and in the
	// environment specifically a stray one would later splice the entire built-in
	// slot block into the middle of the curated list (config.ts spliceDefaults).
	const noDefaults = (entries: string[]) => entries.filter((entry) => entry !== "$defaults");
	const environment = noDefaults(
		stringList(record.environment, "environment", true).map((entry) =>
			// Tolerate a model that bullets the lines anyway — entries are stored bare.
			entry.startsWith("- ") ? entry.slice(2) : entry,
		),
	);
	if (environment.length === 0) throw new SetupDraftError('draft JSON key "environment" is empty');
	const drafted = new Set(environment.map(slotName).filter(Boolean));
	const missing = defaultEnvironment.map(slotName).filter((name): name is string => !!name && !drafted.has(name));
	if (missing.length > 0) {
		throw new SetupDraftError(`draft environment is missing built-in slot(s): ${missing.join(", ")}`);
	}
	return {
		environment,
		allow: noDefaults(stringList(record.allow, "allow", false)),
		soft_deny: noDefaults(stringList(record.soft_deny, "soft_deny", false)),
		hard_deny: noDefaults(stringList(record.hard_deny, "hard_deny", false)),
		notes: stringList(record.notes, "notes", false),
	};
}

/** The review text — CC's proposal screen, in plain notify-able form. */
export function renderProposal(draft: SetupDraft): string {
	const section = (title: string, entries: string[], empty: string) =>
		entries.length > 0 ? `${title}\n${entries.map((entry) => `  · ${entry}`).join("\n")}` : `${title}\n  ${empty}`;
	return [
		section("Environment", draft.environment, "(none — this should not happen)"),
		section("Allow carve-outs", draft.allow, "none suggested"),
		section("Extra soft blocks", draft.soft_deny, "none suggested"),
		section("Extra hard blocks", draft.hard_deny, "none suggested"),
		...(draft.notes.length > 0 ? [section("Notes", draft.notes, "")] : []),
	].join("\n\n");
}

/**
 * The `autoMode` keys the wizard persists (merged over other autoMode keys by
 * config.persistAutoModeSetup). Rule lists carry the "$defaults" sentinel the
 * way CC's wizard writes them; lists with no extras are omitted entirely so
 * settings stay minimal.
 */
export function settingsPatch(draft: SetupDraft): Record<string, string[] | undefined> {
	const listOrOmit = (entries: string[]) => (entries.length > 0 ? ["$defaults", ...entries] : undefined);
	return {
		environment: draft.environment,
		allow: listOrOmit(draft.allow),
		soft_deny: listOrOmit(draft.soft_deny),
		hard_deny: listOrOmit(draft.hard_deny),
	};
}

export interface FlaggedAllowRule {
	rule: string;
	why: string;
}

/**
 * CC's "rules that skip checks" audit: permissions.allow entries broad enough
 * to hand the model a standing way past the classifier. The judgement is the
 * gate's own `isBroadExecutionRule` — the exact predicate auto mode already
 * uses to suspend such rules at decision time — so the audit can never flag
 * differently than the gate behaves. Flagging is advice; removal is the
 * user's call.
 */
export function auditPermissionAllow(rules: string[]): FlaggedAllowRule[] {
	const flagged: FlaggedAllowRule[] = [];
	for (const raw of rules) {
		const rule = parseRule(raw);
		if (!rule || !isBroadExecutionRule(rule)) continue;
		flagged.push({
			rule: raw,
			why:
				rule.tool === "bash"
					? "grants arbitrary code execution — matching commands never reach auto mode's checks"
					: "pre-approves a fresh agent loop — whatever the delegated agent does is unchecked",
		});
	}
	return flagged;
}
