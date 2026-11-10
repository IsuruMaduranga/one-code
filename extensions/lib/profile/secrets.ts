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
 * (`setSecretValues`), and the base replaces each occurrence in two places.
 * In every tool result and task notification before it is stored
 * (safety/secret-values, lib/notify/notifications.ts), which keeps the
 * session file clean. And in every request's new tail as the ledger records
 * it (request/ledger/wire.ts), which catches what reaches the model another
 * way: a reminder (a changed-file excerpt, diagnostics, hook output), a
 * command the user runs with `!`, the user's own message. The model's own
 * messages are left as it wrote them. A placeholder the model saw must not
 * be written back over the real value, so a file tool whose input carries
 * one is refused (safety/secret-values).
 *
 * The values are process state: a secret is one in every session of the
 * process, and a child session has its own event bus, so a channel would
 * leave a subagent's results unredacted unless the product remembered to
 * re-announce there.
 */

import { posix } from "node:path";
import { forwardSlashes } from "./paths.ts";
import { processState } from "./process-state.ts";

const { basename } = posix;

/** A value shorter than this is not registered: replacing `8080` or `dev` everywhere would damage ordinary output. */
export const MIN_SECRET_LENGTH = 6;

export interface SecretValue {
	value: string;
	/** Shown in the placeholder (`[secret:db_password]`), so the model can still reason about which value was there. */
	name?: string;
}

interface SecretStore {
	bySource: Map<string, SecretValue[]>;
	/** Each spelling's placeholder. */
	placeholders: Map<string, string>;
	/** One pattern over every spelling, longest first, so a value that contains another is replaced whole and a placeholder is never rewritten. Undefined with no value. */
	pattern: RegExp | undefined;
}

const store = (): SecretStore => processState("secrets:values", () => ({ bySource: new Map<string, SecretValue[]>(), placeholders: new Map<string, string>(), pattern: undefined }));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name safe inside the placeholder. */
const placeholderFor = (name: string | undefined): string => {
	const safe = name?.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60);
	return safe ? `[secret:${safe}]` : "[secret]";
};

/** The spellings a value can take in output: itself, and its JSON string form when escaping changes it. */
const spellings = (value: string): string[] => {
	const json = JSON.stringify(value).slice(1, -1);
	return json === value ? [value] : [value, json];
};

/**
 * Replace the secret values registered under `source` (a product names one
 * source per owner, such as a config file's path). Returns how many were
 * left out as too short.
 */
export function setSecretValues(source: string, secrets: readonly SecretValue[]): number {
	const { bySource } = store();
	const kept = secrets.filter((secret) => typeof secret.value === "string" && secret.value.length >= MIN_SECRET_LENGTH);
	if (kept.length === 0) bySource.delete(source);
	else bySource.set(source, kept);
	const placeholders = new Map<string, string>();
	for (const secret of [...bySource.values()].flat()) {
		for (const spelling of spellings(secret.value)) if (!placeholders.has(spelling)) placeholders.set(spelling, placeholderFor(secret.name));
	}
	const ordered = [...placeholders.keys()].sort((x, y) => y.length - x.length);
	store().placeholders = placeholders;
	store().pattern = ordered.length > 0 ? new RegExp(ordered.map(escapeRegExp).join("|"), "g") : undefined;
	return secrets.length - kept.length;
}

/** `text` with every registered secret value replaced by its placeholder, in one pass; the same string when none occurs. */
export function redactSecretValues(text: string): string {
	const { pattern, placeholders } = store();
	return pattern ? text.replace(pattern, (match) => placeholders.get(match) ?? match) : text;
}

/** A JSON value with every string redacted; the same reference when nothing changed. */
export function redactSecretValuesIn(value: unknown): unknown {
	if (typeof value === "string") return redactSecretValues(value);
	if (Array.isArray(value)) {
		let next: unknown[] | undefined;
		value.forEach((item, i) => {
			const redacted = redactSecretValuesIn(item);
			if (redacted !== item) (next ??= [...value])[i] = redacted;
		});
		return next ?? value;
	}
	if (value && typeof value === "object") {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			next[key] = redactSecretValuesIn(item);
			changed ||= next[key] !== item;
		}
		return changed ? next : value;
	}
	return value;
}

/** Whether any secret value is registered. */
export function hasSecretValues(): boolean {
	return store().pattern !== undefined;
}

/** Whether `text` carries a placeholder that stands for a registered value: writing it to a file would replace the real value with the placeholder. */
export function carriesSecretPlaceholder(text: string): boolean {
	for (const placeholder of new Set(store().placeholders.values())) if (text.includes(placeholder)) return true;
	return false;
}

/** The problems in a profile's secret file names, for the resolver to report with the rest. */
export function secretFileProblems(names: readonly string[]): string[] {
	// A name is matched literally, so a path or a glob would silently protect nothing.
	return names.filter((name) => typeof name !== "string" || name.trim() === "" || /[\\/*?[\]]/.test(name)).map((name) => `secret file "${name}" must be a bare file name, with no folder and no wildcard`);
}

/** A character a file name continues with: a secret file's name is a match only when none sits beside it. */
const NAME_CHAR = /[A-Za-z0-9_.-]/;
const bounded = (ch: string | undefined): boolean => !ch || !NAME_CHAR.test(ch);

/** Whether a path's last segment is one of the names (case-folded: macOS and Windows fold file names). */
export function isSecretFilePath(path: string, names: ReadonlySet<string>): boolean {
	if (names.size === 0 || !path) return false;
	return names.has(basename(forwardSlashes(path)).toLowerCase());
}

/** Whether a command line names one of the files: the name bounded by characters no file name continues with. */
export function commandNamesSecretFile(command: string, names: ReadonlySet<string>): boolean {
	if (names.size === 0 || !command) return false;
	const lower = command.toLowerCase();
	for (const name of names) {
		for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
			if (bounded(lower[at - 1]) && bounded(lower[at + name.length])) return true;
		}
	}
	return false;
}
