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

/** One replacement: a spelling of a secret value and the placeholder that takes its place. */
interface Replacement {
	spelling: string;
	placeholder: string;
}

interface SecretStore {
	bySource: Map<string, SecretValue[]>;
	/** Every spelling of every value, longest first, so a value that contains another is replaced whole. Rebuilt when a source changes. */
	plan: Replacement[];
}

const store = (): SecretStore => processState("secrets:values", () => ({ bySource: new Map<string, SecretValue[]>(), plan: [] }));

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
	store().plan = [...bySource.values()]
		.flat()
		.flatMap((secret) => spellings(secret.value).map((spelling) => ({ spelling, placeholder: placeholderFor(secret.name) })))
		.sort((x, y) => y.spelling.length - x.spelling.length);
	return secrets.length - kept.length;
}

/** `text` with every registered secret value replaced by its placeholder; the same string when none occurs. */
export function redactSecretValues(text: string): string {
	let out = text;
	for (const { spelling, placeholder } of store().plan) out = out.replaceAll(spelling, placeholder);
	return out;
}

/** Whether any secret value is registered. */
export function hasSecretValues(): boolean {
	return store().plan.length > 0;
}

/** The problems in a profile's secret file names, for the resolver to report with the rest. */
export function secretFileProblems(names: readonly string[]): string[] {
	return names.filter((name) => typeof name !== "string" || name.trim() === "" || /[\\/]/.test(name)).map((name) => `secret file "${name}" must be a bare file name`);
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
