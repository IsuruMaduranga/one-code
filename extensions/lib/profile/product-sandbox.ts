/**
 * The type of a profile's sandbox defaults and their load check
 * (lib/shell-run/sandbox-settings.ts applies them). It imports only the
 * leaf lib/core/plain-object.ts, so lib/profile/profile.ts can check the
 * block without loading the shell modules.
 *
 * The block has the shape of a settings file's `sandbox` block, laid over a
 * sandbox that is off before any settings file is read. It is code the
 * product ships, not a file a session can write, so it may both tighten and
 * loosen. `locked: true` makes every settings file count as a repository's:
 * a file can still tighten the sandbox, and nothing it writes turns it off or
 * widens it.
 */

import { isPlainObject } from "../core/plain-object.ts";

/** A profile's starting sandbox settings (`Profile.sandbox`). */
export interface ProductSandbox {
	enabled?: boolean;
	allowUnsandboxedCommands?: boolean;
	failIfUnavailable?: boolean;
	autoAllowBashIfSandboxed?: boolean;
	excludedCommands?: readonly string[];
	filesystem?: { allowWrite?: readonly string[]; denyWrite?: readonly string[]; denyRead?: readonly string[]; allowRead?: readonly string[] };
	network?: { allowedDomains?: readonly string[]; deniedDomains?: readonly string[]; allowLocalBinding?: boolean; allowUnixSockets?: readonly string[] };
	/**
	 * true: no settings file can loosen what this block sets or leaves at its
	 * default. Turning the sandbox off, auto-allow, excluded commands, writable
	 * and readable paths, allowed hosts, local binding and Unix sockets are
	 * ignored from every file, the user's own included; tightening still
	 * counts from every file.
	 */
	locked?: boolean;
}

const BOOLEANS = ["enabled", "allowUnsandboxedCommands", "failIfUnavailable", "autoAllowBashIfSandboxed", "locked"] as const;
const SECTIONS: Readonly<Record<"filesystem" | "network", Readonly<Record<string, "list" | "boolean">>>> = {
	filesystem: { allowWrite: "list", denyWrite: "list", denyRead: "list", allowRead: "list" },
	network: { allowedDomains: "list", deniedDomains: "list", allowLocalBinding: "boolean", allowUnixSockets: "list" },
};

const isList = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "");

/** What is wrong with a profile's `sandbox` block, one sentence each; empty when it is usable. A value the merge would skip in silence is refused here. */
export function productSandboxProblems(block: unknown): string[] {
	if (block === undefined) return [];
	if (!isPlainObject(block)) return [`its "sandbox" must be an object shaped like a settings file's sandbox block`];
	const problems: string[] = [];
	const known = new Set<string>([...BOOLEANS, "excludedCommands", ...Object.keys(SECTIONS)]);
	for (const key of Object.keys(block)) if (!known.has(key)) problems.push(`its "sandbox" has an unknown field "${key}"`);
	for (const key of BOOLEANS) if (block[key] !== undefined && typeof block[key] !== "boolean") problems.push(`its "sandbox.${key}" must be true or false`);
	if (block.excludedCommands !== undefined && !isList(block.excludedCommands)) problems.push(`its "sandbox.excludedCommands" must be a list of non-empty strings`);
	for (const [section, fields] of Object.entries(SECTIONS)) {
		const value = block[section];
		if (value === undefined) continue;
		if (!isPlainObject(value)) {
			problems.push(`its "sandbox.${section}" must be an object`);
			continue;
		}
		for (const [key, entry] of Object.entries(value)) {
			const kind = fields[key];
			if (kind === undefined) problems.push(`its "sandbox.${section}" has an unknown field "${key}"`);
			else if (kind === "list" && !isList(entry)) problems.push(`its "sandbox.${section}.${key}" must be a list of non-empty strings`);
			else if (kind === "boolean" && typeof entry !== "boolean") problems.push(`its "sandbox.${section}.${key}" must be true or false`);
		}
	}
	return problems;
}
