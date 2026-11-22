/**
 * The sandbox section's facts, and `/sandbox`'s lines (pure). The words are
 * the profile's (`text.shell.sandbox`); the rules are printed as JSON in the
 * shape Claude Code prints them.
 */

import type { ActiveSandbox } from "../../lib/shell-run/sandbox.ts";
import type { SandboxSettings } from "../../lib/shell-run/sandbox-settings.ts";
import type { ShellSandboxText } from "../../lib/shell-run/shell-text.ts";

export interface SandboxFacts {
	settings: SandboxSettings;
	platform: "darwin" | "linux" | undefined;
	active: ActiveSandbox | undefined;
	unavailable: string | undefined;
	cwd: string;
	/** The hosts the user allowed for this session at a prompt. */
	sessionHosts?: readonly string[];
}

/** The prompt for a host the settings do not list, in the manual modes. */
export const hostPromptTitle = (host: string, port: number | undefined): string =>
	`Allow a sandboxed command to connect to ${host}${port ? `:${port}` : ""}?\n\n  Your sandbox settings do not list this host (sandbox.network.allowedDomains).`;
export const hostPromptOptions = (host: string) => ({ once: "Yes", session: `Yes, and don't ask again for ${host} this session`, no: "No" });

/** A long list is cut for the prompt, as Claude Code cuts its own. */
const LIST_CAP = 60;
const capped = (entries: readonly string[]): string[] => (entries.length <= LIST_CAP ? [...entries] : [...entries.slice(0, LIST_CAP), `... and ${entries.length - LIST_CAP} more (truncated for prompt size)`]);

/** The session's rules for a command run in `cwd`, as the section prints them. */
export function sandboxRules(active: ActiveSandbox, cwd: string): { filesystem: string } {
	const fs = active.filesystem(cwd);
	return {
		filesystem: JSON.stringify({ read: { denyOnly: capped(fs.denyRead), allowWithinDeny: capped(fs.allowRead) }, write: { allowOnly: capped(fs.allowWrite), denyWithinAllow: capped(fs.denyWrite) } }),
	};
}

/** The section for a session whose settings turn the sandbox on. */
export function sandboxSectionText(text: ShellSandboxText, facts: SandboxFacts & { platform: "darwin" | "linux" }): string {
	if (!facts.active) return text.unavailable({ reason: facts.unavailable ?? "it has not started", required: facts.settings.failIfUnavailable });
	return text.section({ platform: facts.platform, ...sandboxRules(facts.active, facts.cwd), unsandboxedAllowed: facts.settings.allowUnsandboxedCommands });
}

/** What the user is told about the product's own sandbox settings, when the profile supplies them: whether they are locked, and what the lock ignored. */
export function productSandboxLine(product: NonNullable<SandboxSettings["product"]>): string {
	if (!product.locked) return "The product sets the sandbox's starting settings; your settings apply over them.";
	const ignored = product.ignored.length > 0 ? ` Ignored because of the lock: ${product.ignored.join(", ")}.` : "";
	return `The product sets the sandbox's settings and locks them: your settings and a repository's can tighten the sandbox but cannot turn it off or widen it.${ignored}`;
}

/** What `/sandbox` shows the user, with the product's line second when the profile supplies the settings. */
export function sandboxStatusLines(facts: SandboxFacts): string[] {
	const lines = settingsStatusLines(facts);
	if (facts.settings.product) lines.splice(1, 0, productSandboxLine(facts.settings.product));
	return lines;
}

function settingsStatusLines(facts: SandboxFacts): string[] {
	const how = 'Turn it on with "sandbox": { "enabled": true } in your user settings; it applies from the next start.';
	if (!facts.platform) return ["Command sandbox: not available on this platform (commands run unsandboxed)."];
	if (!facts.settings.enabled) return ["Command sandbox: off.", how];
	if (!facts.active) {
		return [
			`Command sandbox: on in settings, not running (${facts.unavailable ?? "it has not started"}).`,
			facts.settings.failIfUnavailable ? "Shell commands are refused until it can start (sandbox.failIfUnavailable)." : "Shell commands run without it.",
		];
	}
	const fs = facts.active.filesystem(facts.cwd);
	const list = (entries: readonly string[]) => (entries.length > 0 ? entries.join(", ") : "none");
	return [
		`Command sandbox: on (${facts.platform === "darwin" ? "macOS Seatbelt" : "bubblewrap"}). Bash, PowerShell and Monitor commands run inside it.`,
		`Writable: ${list(fs.allowWrite)}`,
		`Never writable: ${fs.denyWrite.length} protected path${fs.denyWrite.length === 1 ? "" : "s"}`,
		`Not readable: ${list(fs.denyRead)}`,
		`Network hosts allowed: ${list(facts.settings.network.allowedDomains)}`,
		...(facts.sessionHosts?.length ? [`Network hosts allowed for this session (not in auto mode): ${list(facts.sessionHosts)}`] : []),
		"A host not listed: you are asked (auto mode reviews the hosts a command names; bypassPermissions allows it).",
		`Network hosts denied: ${list(facts.settings.network.deniedDomains)}`,
		`Commands outside the sandbox: ${list(facts.settings.excludedCommands)}`,
		`The model may ask to run a command outside it: ${facts.settings.allowUnsandboxedCommands ? "yes, through the permission gate" : "no (sandbox.allowUnsandboxedCommands is false)"}`,
		`A sandboxed Bash command runs without a prompt: ${facts.settings.autoAllowBashIfSandboxed ? "yes, in default and acceptEdits modes (deny and ask rules still apply)" : "no (set sandbox.autoAllowBashIfSandboxed in your user settings to allow it)"}`,
		"Change these under \"sandbox\" in your settings; changes apply from the next start (auto-allow and the fallback apply at once).",
	];
}
