/**
 * The product voice comes from the profile (working-docs/decisions/bi-fork.md):
 * with the fixture profile's marker text in force, every tool the base
 * registers at load describes itself, and each of its parameters, only in
 * the fixture's markers. A sentence of the base's own in a tool's words fails
 * here: it belongs in the profile. Not checked: the base's operational text
 * (results, refusals, notifications), which is the base's to write, and the
 * system prompt and side-call prompts, whose words are whole profile members
 * (the name guard, base-names-guard.test.ts, covers what the base adds).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProfileText } from "../../extensions/lib/profile/profile-contract.ts";
import { PROFILE_DIR, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** The manifest's base entries: the product's own glob is the profile's. */
const ENTRIES: string[] = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).pi.extensions as string[]).filter((entry) => entry.startsWith("extensions/"));

/** `text` without the fixture's markers (`[group.member …]`, nested brackets included). */
function withoutMarkers(text: string): string {
	let out = "";
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		if (depth === 0 && text[i] === "[" && /^\[[A-Za-z]+\.[A-Za-z_.]+[\] ]/.test(text.slice(i, i + 80))) depth = 1;
		else if (depth > 0 && text[i] === "[") depth++;
		else if (depth > 0 && text[i] === "]") depth--;
		else if (depth === 0) out += text[i];
	}
	return out;
}

/**
 * Words that are neither the base's nor the profile's: pi's own tool
 * definitions and a vendored package's, passed through unchanged. By tool,
 * the fields that are theirs (`*`: all of them).
 */
const THEIRS: Readonly<Record<string, readonly string[]>> = {
	read: ["*"],
	grep: ["*"],
	find: ["*"],
	ls: ["*"],
	write: ["promptSnippet", "promptGuidelines", "parameters"],
	edit: ["promptSnippet", "promptGuidelines", "parameters"],
	bash: ["promptSnippet", "promptGuidelines"],
	powershell: ["promptSnippet", "promptGuidelines"],
	url_context: ["*"],
};
const theirs = (tool: string, where: string): boolean => (THEIRS[tool] ?? []).some((field) => field === "*" || where.startsWith(field));

/** Three or more words in a row: the base's own prose. */
const PROSE = /[A-Za-z][A-Za-z'’]*(?:,?\s+[A-Za-z][A-Za-z'’]*){2,}/;

/** Every `description` in a parameter schema, with its path. */
function descriptions(schema: unknown, path: string, out: [string, string][] = []): [string, string][] {
	if (Array.isArray(schema)) schema.forEach((item, i) => descriptions(item, `${path}[${i}]`, out));
	else if (schema && typeof schema === "object") {
		for (const [key, value] of Object.entries(schema)) {
			if (key === "description" && typeof value === "string") out.push([path, value]);
			else descriptions(value, `${path}.${key}`, out);
		}
	}
	return out;
}

let fake: FakePi;
const failedToLoad: string[] = [];

beforeAll(async () => {
	const { mark: _mark, ...groups } = await import(pathToFileURL(join(ROOT, "test", "fixtures", "profile", "text.ts")).href);
	setActiveProfileForTest(resolveProfile({ features: {}, tools: {}, childExtensions: [], text: () => groups as ProfileText }, {}, PROFILE_DIR));
	fake = createFakePi();
	for (const entry of ENTRIES) {
		try {
			const module = await import(pathToFileURL(join(ROOT, entry)).href);
			await module.default(fake.pi as never);
		} catch (error) {
			failedToLoad.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
});

afterAll(() => setActiveProfileForTest(undefined));

describe("the product voice", () => {
	it("every base extension loads on the fixture's text", () => {
		expect(failedToLoad).toEqual([]);
		expect(fake.tools.size).toBeGreaterThan(20);
	});

	it("each tool's own words are the profile's", () => {
		const own: string[] = [];
		for (const [name, tool] of fake.tools) {
			const words: [string, string][] = [
				["description", String(tool.description ?? "")],
				["promptSnippet", String(tool.promptSnippet ?? "")],
				...((tool.promptGuidelines as string[] | undefined) ?? []).map((line, i): [string, string] => [`promptGuidelines[${i}]`, line]),
				...descriptions(tool.parameters, "parameters"),
			];
			for (const [where, text] of words) {
				if (theirs(name, where)) continue;
				const rest = withoutMarkers(text);
				if (PROSE.test(rest)) own.push(`${name} ${where}: ${rest.trim().slice(0, 120)}`);
			}
		}
		expect(own).toEqual([]);
	});

	it("tells a marker from prose", () => {
		expect(withoutMarkers("[shell.bashDescription {\"form\":\"long\"} | [a, b]] and more")).toBe(" and more");
		expect(withoutMarkers("Use [brackets] in plain text")).toBe("Use [brackets] in plain text");
	});
});
