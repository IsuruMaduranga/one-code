/**
 * Atomic JSON file writes (pure fs, no pi imports).
 *
 * Write to a temp sibling, then rename over the target — a reader never sees a
 * partially written file, and a crash mid-write leaves the target untouched.
 * Read-modify-write callers must spread over the parsed existing object so
 * unknown fields round-trip (the files also belong to future versions and to
 * users who hand-edit them).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let sequence = 0;

export function writeJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${++sequence}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, path);
}

/** Parse a JSON file, or `undefined` when missing/unreadable/malformed. */
export function readJsonFile<T>(path: string): T | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

/**
 * A `{key: boolean}` store file (the shape both override stores use): read
 * drops non-boolean values, write is an atomic read-modify-write that
 * round-trips unknown values.
 */
export function readBooleanMap(path: string): Record<string, boolean> {
	const parsed = readJsonFile<Record<string, unknown>>(path);
	if (!parsed || typeof parsed !== "object") return {};
	const map: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "boolean") map[key] = value;
	}
	return map;
}

export function setBooleanMapEntry(path: string, key: string, value: boolean): void {
	const existing = readJsonFile<Record<string, unknown>>(path) ?? {};
	writeJsonAtomic(path, { ...existing, [key]: value });
}
