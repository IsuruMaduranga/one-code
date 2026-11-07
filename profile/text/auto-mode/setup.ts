/**
 * One Code's `/auto-mode setup` drafting call (the profile's `autoModeSetup`
 * text): the model drafts Environment slot values and extra rules from the
 * facts the harness gathered, as strict JSON the base parses.
 */

import type { AutoModeSetupText } from "../../../extensions/auto-mode/text.ts";

export const autoModeSetup: AutoModeSetupText = {
	system: [
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
	].join("\n"),
	usageOptions: ["Software development in this repo", "Mixed — coding and general tasks", "Mostly questions and analysis"],
	defaultsHeading: "## Default Environment slots (keep any slot you cannot improve on)",
	factsHeading: "## Gathered facts (JSON)",
	notes: {
		probeFailed: (what, command, error) => `${what} was not gathered (${command} failed: ${error})`,
		unreadable: (what, error) => `${what} exists but could not be read (${error})`,
		visibilityUnknown: "gh repo view returned unparseable JSON — repository visibility unknown",
		noShellHistory: "no shell history file found — usage patterns not gathered",
		historyDeclined: "shell history scan declined by the user",
		allowUnreadable: "user settings permissions.allow could not be read",
	},
};
