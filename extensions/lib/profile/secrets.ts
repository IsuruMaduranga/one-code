/**
 * Secrets a product keeps from the model (working-docs/decisions/bi-fork.md),
 * in two layers. Pure: no pi imports.
 *
 * Names: the profile lists its secret files (`Profile.secretFiles`, bare file
 * names). The permission gate refuses a file tool on one and a shell command
 * that names one, in every mode (lib/rules/matcher.ts). This steers the model
 * to the product's own tools, and cannot be complete: `cat *.toml` or a
 * program that prints its configuration names no file.
 *
 * Values: the product registers the secret values it knows
 * (`setSecretValues`), and the base replaces each occurrence in every tool
 * result and task notification before it is stored, so the bytes that reach
 * the model are checked, whatever command produced them
 * (safety/secret-values, lib/notify/notifications.ts).
 *
 * The values are process state: a secret is one in every session of the
 * process, and a child session has its own event bus, so a channel would
 * leave a subagent's results unredacted unless the product remembered to
 * re-announce there.
 */

import { processState } from "./process-state.ts";

/** A value shorter than this is not registered: replacing `8080` or `dev` everywhere would damage ordinary output. */
export const MIN_SECRET_LENGTH = 6;

export interface SecretValue {
	value: string;
	/** Shown in the placeholder (`[secret:db_password]`), so the model can still reason about which value was there. */
	name?: string;
}

const values = (): Map<string, SecretValue[]> => processState("secrets:values", () => new Map<string, SecretValue[]>());

/**
 * Replace the secret values registered under `source` (a product names one
 * source per owner, such as a config file's path). Returns how many were
 * left out as too short.
 */
export function setSecretValues(source: string, secrets: readonly SecretValue[]): number {
	const kept = secrets.filter((secret) => typeof secret.value === "string" && secret.value.length >= MIN_SECRET_LENGTH);
	if (kept.length === 0) values().delete(source);
	else values().set(source, kept);
	return secrets.length - kept.length;
}

/** A name safe inside the placeholder. */
const label = (name: string | undefined): string => {
	const safe = name?.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60);
	return safe ? `[secret:${safe}]` : "[secret]";
};

/** The spellings a value can take in output: itself, and its JSON string form when escaping changes it. */
const spellings = (value: string): string[] => {
	const json = JSON.stringify(value).slice(1, -1);
	return json === value ? [value] : [value, json];
};

/** `text` with every registered secret value replaced by its placeholder; the same string when none occurs. */
export function redactSecrets(text: string): string {
	const registered = values();
	if (registered.size === 0 || text.length < MIN_SECRET_LENGTH) return text;
	// Longest first, so a value that contains another is replaced whole.
	const all = [...registered.values()].flat().sort((a, b) => b.value.length - a.value.length);
	let out = text;
	for (const secret of all) {
		for (const spelling of spellings(secret.value)) {
			if (out.includes(spelling)) out = out.split(spelling).join(label(secret.name));
		}
	}
	return out;
}

/** Whether any secret value is registered. */
export function hasSecretValues(): boolean {
	return values().size > 0;
}

/** The problems in a profile's secret file names, for the resolver to report with the rest. */
export function secretFileProblems(names: readonly string[]): string[] {
	return names.filter((name) => typeof name !== "string" || name.trim() === "" || /[\\/]/.test(name)).map((name) => `secret file "${name}" must be a bare file name`);
}

const NAME_CHAR = "A-Za-z0-9_.-";

/** Whether a path's last segment is one of the names (case-folded: macOS and Windows fold file names). */
export function isSecretFilePath(path: string, names: ReadonlySet<string>): boolean {
	if (names.size === 0 || !path) return false;
	const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
	return names.has(base.toLowerCase());
}

/** Whether a command line names one of the files: the name bounded by characters no file name continues with. */
export function commandNamesSecretFile(command: string, names: ReadonlySet<string>): boolean {
	if (names.size === 0 || !command) return false;
	const lower = command.toLowerCase();
	for (const name of names) {
		let at = lower.indexOf(name);
		while (at !== -1) {
			const before = at === 0 ? "" : lower[at - 1];
			const after = lower[at + name.length] ?? "";
			const bounded = (ch: string) => ch === "" || !new RegExp(`[${NAME_CHAR}]`).test(ch);
			if (bounded(before) && bounded(after)) return true;
			at = lower.indexOf(name, at + 1);
		}
	}
	return false;
}
