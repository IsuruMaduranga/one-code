/**
 * The base's text names no other product and no catalog entry
 * (working-docs/decisions/bi-fork.md): a base sentence that says "Claude
 * Code" or "CLAUDE.md", or sends the model to an agent or skill only One
 * Code's catalogs ship, would reach every product's users and model. Such
 * text belongs in the profile. The product's own name is the brand guard's
 * (brand-guard.test.ts); Claude Code's locations are the location guard's
 * (claude-locations-guard.test.ts).
 *
 * `KNOWN` is the list of files that name one today, each with why. It only
 * shrinks: a file that stops naming one must leave it, and a new file fails
 * until its text moves to the profile.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compareWithAllowlist } from "./helpers/claude-locations.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const BASE = join(ROOT, "extensions");

/** Catalog entries the base reads by name (profile-catalog-names.test.ts): every product ships them. */
const RELIED_ON = new Set(["general-purpose", "loop", "code-review"]);

/** One Code's catalog names that only its profile ships, read from the repo's profile when it is One Code's. */
const ONE_CODE_ONLY = ["explore", "plan", "artifact-design", "fewer-permission-prompts", "security-review", "simplify", "workflow-authoring"];

/** A catalog name as a name: quoted, a slash command, or before "agent" or "skill"; `plan` and `explore` alone are English. */
const catalogName = (name: string) => new RegExp(`["'\`]${name}["'\`]|(?<![\\w/.-])/${name}\\b|\\b${name} (sub)?agents?\\b|\\b${name} skill\\b`, "i");

const OTHER_PRODUCT = /Claude Code|\bCLAUDE(\.local)?\.md\b|\bClaude session\b|claude\.ai\b/;

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return walk(path);
		return name.endsWith(".ts") || name.endsWith(".mjs") ? [path] : [];
	});
}

/** The text of every string and template literal in a file: comments, identifiers and module specifiers are not text. */
function literals(source: string, path: string): string[] {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
		else if (ts.isTemplateExpression(node)) found.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${…}"));
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

const files = walk(BASE).map((path) => [relative(BASE, path).split("\\").join("/"), literals(readFileSync(path, "utf8"), path)] as const);

const naming = (pattern: RegExp): string[] => files.filter(([, texts]) => texts.some((text) => pattern.test(text))).map(([path]) => path);

/** Base files whose text names Claude Code today, and why each is left (S8 and S9 shrink this list). */
const KNOWN_OTHER_PRODUCT: Record<string, string> = {
	"commands/doctor/build.ts": "ui: /doctor's compaction row compares the keep window with Claude Code's",
	"commands/doctor/compat.ts": "ui: /doctor's imported-configuration section words the provider's files itself; the provider should",
	"commands/doctor/index.ts": "ui: /doctor's command and subcommand descriptions",
	"commands/doctor/models.ts": "ui: /doctor's tier labels name the prompt register",
	"context/memory/index.ts": "ui: /memory's description and listing heading; should take the instruction file's name",
	"lib/app/compaction-keep.mjs": "ui: the app's first-run note on the compaction keep window",
	"lib/app/replaced-builtins.mjs": "ui: the app's first-run note on pi's replaced built-ins",
	"lib/models/classifier-model.ts": "ui: the cross-provider classifier notice; should take the instruction file's name",
	"safety/permissions/index.ts": "ui: the bypass flag's description, the fast-path notice, /auto-mode's notes on the ruleset and on Claude Code's settings",
	"safety/permissions/panel/render.ts": "ui: the /permissions panel's note on the built-in ruleset",
	"tools/mcp/index.ts": "ui: why a server is off, naming the provider's setting",
	"tools/plugins/index.ts": "ui: /plugins' description and the read-only notice for the provider's plugins",
	"tools/plugins/panel/render.ts": "ui: the /plugins panel's origin rows",
};

/** Base files whose text names an agent or skill only One Code ships. */
const KNOWN_CATALOG: Record<string, string> = {};

describe("the base's text", () => {
	it("names no other product", () => {
		const { unlisted, stale } = compareWithAllowlist(naming(OTHER_PRODUCT), KNOWN_OTHER_PRODUCT);
		expect(unlisted, "this text names Claude Code: move the words to the profile, or word them neutrally").toEqual([]);
		expect(stale, "these no longer name Claude Code; drop them from KNOWN_OTHER_PRODUCT").toEqual([]);
	});

	it("names no agent or skill that only One Code's catalogs ship", () => {
		// The names are One Code's: on another profile the check still holds, since the base is the same.
		const shipped = ONE_CODE_ONLY.filter((name) => !RELIED_ON.has(name));
		const hits = [...new Set(shipped.flatMap((name) => naming(catalogName(name))))].sort();
		const { unlisted, stale } = compareWithAllowlist(hits, KNOWN_CATALOG);
		expect(unlisted, "this text names a catalog entry a product may not ship: move the words to the profile").toEqual([]);
		expect(stale, "these no longer name one; drop them from KNOWN_CATALOG").toEqual([]);
	});

	it("keeps the catalog list current with One Code's profile", () => {
		const agents = join(ROOT, "profile", "agents");
		const skills = join(ROOT, "profile", "skills");
		// Only where the profile in the tree is One Code's (the base suite runs on the fixture's).
		if (!existsSync(join(agents, "explore.md"))) return;
		const names = [...readdirSync(agents).map((file) => file.replace(/\.md$/, "")), ...readdirSync(skills)].filter((name) => !RELIED_ON.has(name));
		expect(names.sort()).toEqual([...ONE_CODE_ONLY].sort());
	});

	it("tells a catalog name from the English word", () => {
		expect(catalogName("plan").test("Enter plan mode to plan the change")).toBe(false);
		expect(catalogName("plan").test('subagent_type: "plan"')).toBe(true);
		expect(catalogName("explore").test("Launch up to 3 explore agents")).toBe(true);
		expect(catalogName("simplify").test("run /simplify first")).toBe(true);
		expect(catalogName("simplify").test("path/simplify.ts")).toBe(false);
	});
});
