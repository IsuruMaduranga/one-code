/**
 * Claude Code rules fidelity: the rule scanner is deliberately separate from
 * normal CLAUDE.md import expansion, so exercise its filesystem and wiring
 * contracts together here. Fixtures use TMPDIR, outside the checkout's instructions.
 */
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import {
	buildClaudeMdBlock,
	discoverContextFiles,
	nestedInstructionFiles,
	nestedInstructionText,
} from "../../extensions/lib/claude-context.ts";
import { discoverRules, parseRule, readRuleInstructions, ruleMatches, splitRulePaths } from "../../extensions/lib/claude-rules.ts";
import { claudeManagedDir, forwardSlashes, isPathAtOrUnder } from "../../extensions/lib/paths.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

vi.mock("node:fs", async (load) => {
	const actual = await load<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

// Resolve the parent once so containment assertions use canonical paths. Native,
// as the code under test resolves: on Windows it expands an 8.3 short name
// (C:\Users\RUNNER~1) that the JS realpath keeps.
const scratch = realpathSync.native(tmpdir());
let fixture = "";

function makeFixture(name = "claude-rules-"): string {
	return (fixture = realpathSync.native(mkdtempSync(join(scratch, name))));
}

function write(root: string, file: string, content: string): string {
	const path = join(root, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

function paths(files: Array<{ path: string }>, root: string): string[] {
	return files.map((file) => forwardSlashes(relative(root, file.path)));
}

beforeEach(() => {
	makeFixture();
	// The checkout's own CLAUDE.md must not accidentally satisfy the AGENTS fallback test.
	const exists = fs.existsSync;
	vi.spyOn(fs, "existsSync").mockImplementation((path) => isPathAtOrUnder(String(path), fixture) && exists(path));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(fixture, { recursive: true, force: true });
});

describe("claude-rules text and matching semantics", () => {
	it("splits strings and arrays only at commas outside braces, expanding manual alternatives but never numeric ranges", () => {
		expect(splitRulePaths("src/{api, web}/** , docs/**,pkg/{a,b,c}.ts")).toEqual([
			"src/api/**",
			"src/web/**",
			"docs/**",
			"pkg/a.ts",
			"pkg/b.ts",
			"pkg/c.ts",
		]);
		expect(splitRulePaths(["a,b", ["c/{d,e}"], 7, null])).toEqual(["a", "b", "c/d", "c/e"]);
		// Claude Code's hand-written expansion regards this as one literal alternative.
		expect(splitRulePaths("release-{1..3}.md")).toEqual(["release-1..3.md"]);
	});

	it("removes frontmatter and HTML comments, strips /**, and makes empty, invalid, and all-** paths unconditional", () => {
		expect(parseRule("\uFEFF---\npaths: src/**, {test,docs}/**\n---\n<!-- private -->\nKeep this.\n")).toEqual({
			content: "Keep this.\n",
			globs: ["src", "test", "docs"],
		});
		for (const yaml of ["paths: []", "paths: 42", "paths: true", "paths: '**'"]) {
			const parsed = parseRule(`---\n${yaml}\n---\nAlways\n`);
			expect(parsed.globs, yaml).toBeUndefined();
			expect(parsed.content).toBe("Always\n");
		}
	});

	it("uses gitignore matching with negation and refuses paths outside the rule owner", () => {
		const project = write(fixture, "project/keep", "");
		const base = dirname(project);
		expect(ruleMatches(["*.ts", "!keep.ts"], join(base, "discard.ts"), base)).toBe(true);
		expect(ruleMatches(["*.ts", "!keep.ts"], join(base, "keep.ts"), base)).toBe(false);
		expect(ruleMatches(["**"], join(fixture, "elsewhere/a.ts"), base)).toBe(false);
		expect(ruleMatches(["["], join(base, "src/a.ts"), base)).toBe(false);
	});
});

describe("more binary parser cases", () => {
	it.each([
		["paths: '**/**'", undefined],
		["paths: ['', '**', '**/**']", undefined],
		["paths: ['**', '!generated/**']", ["**", "!generated"]],
		["paths:\n  - 'src/**/*.ts'\n  - 'tests/**'", ["src/**/*.ts", "tests"]],
		["paths: src/**", ["src"]],
		["paths: *.ts", ["*.ts"]],
		["paths: [not closed", ["[not closed"]],
	])("classifies YAML %s", (metadata, globs) => {
		expect(parseRule(`---\n${metadata}\n---\nRule`).globs).toEqual(globs);
	});

	it("preserves missing frontmatter, inline/fenced comments and unterminated comments", () => {
		for (const body of ["---\npaths: src/**\nno close", "Text <!-- inline -->\n", "`<!-- code -->`\n", "```\n<!-- fence -->\n```\n", "<!-- unfinished\n"]) {
			expect(parseRule(body)).toEqual({ content: body });
		}
		expect(parseRule("<!-- note --> Keep me\n").content).toBe(" Keep me\n");
	});

	it("repairs malformed YAML without stringifying valid flow arrays, and expands leading tabs only on retry", () => {
		expect(parseRule("---\npaths: [src/**]\ndescription: bad: value\n---\nRule\n")).toEqual({ content: "Rule\n", globs: ["src"] });
		expect(parseRule("---\npaths:\n\t- src/**\n---\nRule\n").globs).toEqual(["src"]);
		expect(parseRule('---\npaths: src/with\\"quote/**\ndescription: bad: value\n---\nRule').globs).toEqual(['src/with\\"quote']);
	});

	it("keeps raw CRLF without comments, and uses CommonMark comment blocks rather than a line regex", () => {
		expect(parseRule("Rule\r\nnext\r\n").content).toBe("Rule\r\nnext\r\n");
		expect(parseRule("   <!-- one --><!-- two -->\r\nRule\r\n").content).toBe("Rule\n");
		expect(parseRule("    <!-- indented code -->\n").content).toBe("    <!-- indented code -->\n");
	});

	it("bounds brace expansion and preserves alternative order", () => {
		expect(splitRulePaths("{a,b}/{c,d}")).toEqual(["a/c", "a/d", "b/c", "b/d"]);
		const overBudget = `{${Array.from({ length: 1001 }, (_, i) => i).join(",")}}`;
		expect(splitRulePaths(overBudget)).toEqual([overBudget]);
	});

	it("matches directory descendants, dot files, anchored paths and basename patterns like gitignore", () => {
		expect(ruleMatches(["src"], "src/deep/a.ts", fixture)).toBe(true);
		expect(ruleMatches(["src"], "lib/src/a.ts", fixture)).toBe(true);
		expect(ruleMatches(["/src"], "lib/src/a.ts", fixture)).toBe(false);
		expect(ruleMatches(["*.ts"], ".hidden/a.ts", fixture)).toBe(true);
		expect(ruleMatches(["src/*.ts"], "src/deep/a.ts", fixture)).toBe(false);
		for (const target of ["", "../outside.ts", "..hidden.ts"]) expect(ruleMatches(["**"], target, fixture)).toBe(false);
	});

	it("uses the binary's managed root on each platform", () => {
		expect(claudeManagedDir("darwin")).toBe("/Library/Application Support/ClaudeCode");
		expect(claudeManagedDir("win32")).toBe("C:\\Program Files\\ClaudeCode");
		expect(claudeManagedDir("linux")).toBe("/etc/claude-code");
	});
});

describe("discoverRules", () => {
	it("walks recursively depth-first, loads only lowercase .md, and ignores empty or missing rule files", () => {
		const cwd = join(fixture, "project");
		const rules = join(cwd, ".claude", "rules");
		write(cwd, ".claude/rules/a-dir/first.md", "first");
		write(cwd, ".claude/rules/a-dir/UPPER.MD", "no");
		write(cwd, ".claude/rules/a-dir/empty.md", "  \n");
		write(cwd, ".claude/rules/z.md", "last");
		expect(paths(discoverRules({ rulesDir: rules, cwd, home: fixture, scope: "Project" }), cwd)).toEqual([
			".claude/rules/a-dir/first.md",
			".claude/rules/z.md",
		]);
	});

	it("parses a rules directory again only when a stat of something it read changes", () => {
		const cwd = join(fixture, "project");
		const rules = join(cwd, ".claude", "rules");
		const fixed = new Date(2026, 0, 1);
		const file = write(cwd, ".claude/rules/a.md", "first");
		fs.utimesSync(file, fixed, fixed);
		const read = (includeExternal?: boolean) => discoverRules({ rulesDir: rules, cwd, home: fixture, scope: "Project", includeExternal }).map((f) => f.content.split("\n")[0]);
		expect(read()).toEqual(["first"]);
		// Same size and mtime: nothing a stat sees changed, so the parsed copy is reused.
		writeFileSync(file, "FIRST");
		fs.utimesSync(file, fixed, fixed);
		expect(read()).toEqual(["first"]);
		writeFileSync(file, "changed");
		expect(read()).toEqual(["changed"]);
		write(cwd, ".claude/rules/b.md", "added\n@../../later.md");
		expect(read()).toEqual(["changed", "added"]);
		write(cwd, "later.md", "late import");
		expect(read()).toEqual(["changed", "added", "late import"]);
		write(cwd, ".claude/rules/sub/c.md", "nested");
		expect(read()).toEqual(["changed", "added", "late import", "nested"]);
		write(cwd, ".claude/rules/sub/d.md", "nested two");
		expect(read()).toEqual(["changed", "added", "late import", "nested", "nested two"]);
		rmSync(file);
		expect(read()).toEqual(["added", "late import", "nested", "nested two"]);
		// Consent is part of what a cached walk is for, never carried across it.
		write(cwd, ".claude/rules/b.md", `added\n@${forwardSlashes(write(fixture, "outside.md", "outside import"))}`);
		expect(read()).toEqual(["added", "nested", "nested two"]);
		expect(read(true)).toEqual(["added", "outside import", "nested", "nested two"]);
		expect(read(false)).toEqual(["added", "nested", "nested two"]);
	});

	it("uses the project owner above .claude but the cwd for user rules", () => {
		const cwd = join(fixture, "project");
		const projectRules = join(cwd, ".claude", "rules");
		const userRules = join(fixture, "user", "rules");
		write(cwd, "src/a.ts", "");
		write(cwd, ".claude/rules/project.md", "---\npaths: src/**\n---\nproject");
		write(fixture, "user/rules/user.md", "---\npaths: src/**\n---\nuser");
		expect(discoverRules({ rulesDir: projectRules, cwd, home: fixture, scope: "Project", filePath: join(cwd, "src/a.ts") }).map((f) => f.content)).toEqual(["project"]);
		// A user rule is still relative to the project cwd, rather than ~/.claude/rules.
		expect(discoverRules({ rulesDir: userRules, cwd, home: fixture, scope: "User", filePath: join(cwd, "src/a.ts") }).map((f) => f.content)).toEqual(["user"]);
		expect(discoverRules({ rulesDir: projectRules, cwd, home: fixture, scope: "Project", filePath: join(fixture, "outside.ts") })).toEqual([]);
	});

	it("deduplicates canonical paths and cycles, while blocking linked project entries and linked .claude roots that escape cwd", () => {
		const cwd = join(fixture, "project");
		const rules = join(cwd, ".claude", "rules");
		const outside = join(fixture, "outside");
		write(cwd, ".claude/rules/inside.md", "inside");
		write(outside, "external.md", "external");
		symlinkSync(join(rules, "inside.md"), join(rules, "inside-link.md"));
		symlinkSync(rules, join(rules, "cycle"));
		symlinkSync(join(outside, "external.md"), join(rules, "external.md"));
		const found = discoverRules({ rulesDir: rules, cwd, home: fixture, scope: "Project" });
		expect(found.map((f) => f.content)).toEqual(["inside"]);
		expect(new Set(found.map((f) => f.key)).size).toBe(1);

		const linkedProject = join(fixture, "linked-project");
		write(outside, "rules/outside.md", "must not load");
		mkdirSync(linkedProject, { recursive: true });
		symlinkSync(outside, join(linkedProject, ".claude"));
		expect(discoverRules({ rulesDir: join(linkedProject, ".claude", "rules"), cwd: linkedProject, home: fixture, scope: "Project" })).toEqual([]);
	});

	it("follows external user-rule links and includes, but not unapproved project or managed links", () => {
		const cwd = join(fixture, "project");
		mkdirSync(cwd);
		const external = write(fixture, "shared/all.md", "Global. @../extra.txt\n");
		write(fixture, "shared/conditional.md", "---\npaths: '*.ts'\n---\nUser conditional\n");
		write(fixture, "extra.txt", "External include\n");
		mkdirSync(join(fixture, "user"));
		const rulesDir = join(fixture, "user", "rules");
		symlinkSync(dirname(external), rulesDir);
		const opts = { rulesDir, cwd, home: fixture, scope: "User" as const };
		expect(discoverRules(opts).map((file) => file.content)).toEqual(["Global. @../extra.txt\n", "External include\n"]);
		expect(discoverRules({ ...opts, filePath: join(cwd, "a.ts") }).map((file) => file.content)).toEqual(["User conditional\n"]);
		for (const scope of ["Project", "Managed"] as const) expect(discoverRules({ ...opts, scope })).toEqual([]);
		expect(discoverRules({ ...opts, includeExternal: false })).toEqual([]);
	});

	it("limits the linked .claude-parent gate to cwd and ancestors, as o$e/J1n does", () => {
		const cwd = join(fixture, "project");
		write(cwd, "nested/a.ts", "x");
		write(fixture, "external-claude/rules/r.md", "Nested linked-parent rule");
		symlinkSync(join(fixture, "external-claude"), join(cwd, "nested", ".claude"));
		const files = nestedInstructionFiles({ cwd, filePath: join(cwd, "nested", "a.ts"), home: fixture, rule: "claude-md" });
		expect(files.map((file) => file.content)).toEqual(["Nested linked-parent rule"]);
	});

	it("allows user hardlinks normally and rejects them in the binary's restricted user mode", () => {
		const cwd = join(fixture, "project");
		const file = write(cwd, ".claude/rules/linked.md", "user");
		fs.linkSync(file, join(cwd, "other.md"));
		const opts = { cwd, home: fixture, scope: "User" as const };
		expect(readRuleInstructions(file, opts)).toHaveLength(1);
		expect(readRuleInstructions(file, { ...opts, includeExternal: false })).toEqual([]);
	});

	it("extracts imports from comment residues but not code or comments, and rejects non-text include extensions", () => {
		const cwd = join(fixture, "project");
		const file = write(cwd, ".claude/rules/imports.md", "<!-- note --> @../../shared/yes.txt\n\n`@../../shared/no.txt`\n\n```\n@../../shared/no.txt\n```\n\n<!-- @../../shared/no.txt -->\n\n@../../shared/image.png\n");
		write(cwd, "shared/yes.txt", "YES");
		write(cwd, "shared/no.txt", "NO");
		write(cwd, "shared/image.png", "not text instructions");
		expect(readRuleInstructions(file, { cwd, home: fixture, scope: "Project" }).map((loaded) => loaded.path)).toEqual([file, join(cwd, "shared", "yes.txt")]);
	});

	it("keeps @ rule imports as separately parsed files, blocks external/deep imports, and emits a duplicate import once", () => {
		const cwd = join(fixture, "project");
		const rules = join(cwd, ".claude", "rules");
		const outside = write(fixture, "outside.md", "outside");
		write(cwd, ".claude/rules/a-root.md", "---\npaths: **\n---\nroot @./child.md @" + forwardSlashes(outside) + " @../../imports/f0.md\n");
		write(cwd, ".claude/rules/child.md", "---\npaths: **\n---\nchild\n");
		write(cwd, ".claude/rules/z-again.md", "again @./child.md\n");
		// Keep the chain inside the project but outside rules/, so f5 cannot be
		// independently discovered by the directory walk after import recursion stops.
		for (let i = 0; i < 6; i++) write(cwd, `imports/f${i}.md`, i === 5 ? "too deep" : `f${i} @./f${i + 1}.md`);

		const files = discoverRules({ rulesDir: rules, cwd, home: fixture, scope: "Project" });
		expect(files.map((f) => f.content)).toEqual(expect.arrayContaining(["root @./child.md @" + forwardSlashes(outside) + " @../../imports/f0.md\n", "child\n", "again @./child.md\n", "f0 @./f1.md", "f3 @./f4.md"]));
		expect(files.map((f) => f.content)).not.toContain("outside");
		expect(files.map((f) => f.content)).not.toContain("too deep");
		expect(files.filter((f) => f.content === "child\n")).toHaveLength(1);
		// Context discovery must not inline rules: each parsed file owns its header,
		// while the importing rule's visible @ reference stays in its own body.
		const context = discoverContextFiles({ cwd, homeClaudeDir: join(fixture, "user"), home: fixture, rule: "claude-md" });
		const importedContext = context.filter((file) => file.path.endsWith("a-root.md") || file.path.endsWith("child.md"));
		expect(importedContext.map((file) => file.content)).toEqual([
			"root @./child.md @" + forwardSlashes(outside) + " @../../imports/f0.md",
			"child",
		]);
		const block = buildClaudeMdBlock({ contextFiles: importedContext }) ?? "";
		expect(block).toContain(`Contents of ${join(rules, "a-root.md")} (project instructions, checked into the codebase):\n\nroot @./child.md`);
		expect(block).toContain(`Contents of ${join(rules, "child.md")} (project instructions, checked into the codebase):\n\nchild`);
		// Imported depth five is blocked (the importing rule itself is depth zero).
		expect(files.filter((f) => /^f\d /.test(f.content))).toHaveLength(4);
	});
});

describe("rules in Claude context discovery", () => {
	it("skips a .claude/CLAUDE.md linked to a file outside the project, but loads one linked inside", () => {
		const cwd = join(fixture, "project");
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		const outside = write(fixture, "outside/secret.md", "OUTSIDE SECRET");
		symlinkSync(outside, join(cwd, ".claude", "CLAUDE.md"));
		const opts = { cwd, home: fixture, homeClaudeDir: join(fixture, "user"), managedDir: join(fixture, "managed") };
		expect(JSON.stringify(discoverContextFiles(opts))).not.toContain("OUTSIDE SECRET");
		rmSync(join(cwd, ".claude", "CLAUDE.md"));
		symlinkSync(write(cwd, "docs/rules.md", "LINKED INSIDE RULES"), join(cwd, ".claude", "CLAUDE.md"));
		expect(JSON.stringify(discoverContextFiles(opts))).toContain("LINKED INSIDE RULES");
	});

	it("does not alter legacy prefix bytes when the new instruction locations are absent", () => {
		const cwd = join(fixture, "project");
		const path = write(cwd, "CLAUDE.md", "  legacy whitespace\n\n");
		const files = discoverContextFiles({ cwd, home: fixture, homeClaudeDir: join(fixture, "user"), managedDir: join(fixture, "managed") });
		expect(files).toEqual([{ path, content: "  legacy whitespace\n\n", descriptor: "project instructions, checked into the codebase" }]);
		expect(buildClaudeMdBlock({ contextFiles: files })).toBe(
			"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n" +
			`Contents of ${path} (project instructions, checked into the codebase):\n\n  legacy whitespace\n`,
		);
	});

	it("preserves the old global ~/.claude/CLAUDE.md bytes when no new files exist", () => {
		const cwd = join(fixture, "project");
		mkdirSync(cwd);
		const path = write(fixture, "home/.claude/CLAUDE.md", "---\nname: legacy\n---\n  global whitespace\n\n");
		const files = discoverContextFiles({ cwd, home: join(fixture, "home"), homeClaudeDir: join(fixture, "home", ".claude") });
		expect(files).toEqual([{ path, content: "---\nname: legacy\n---\n  global whitespace\n\n", descriptor: "user's private global instructions for all projects" }]);
	});

	it("deduplicates AGENTS.md that .claude/CLAUDE.md imports in both-files mode", () => {
		const cwd = join(fixture, "project");
		const hidden = write(cwd, ".claude/CLAUDE.md", "@../AGENTS.md");
		const agents = write(cwd, "AGENTS.md", "shared instruction");
		const files = discoverContextFiles({ cwd, home: fixture, homeClaudeDir: join(fixture, "user"), rule: "claude-md-and-agents-md" });
		expect(files.map((file) => file.path)).toEqual([hidden, agents]);
		expect(files.map((file) => file.descriptor)).toEqual(["project instructions, checked into the codebase", "project instructions, checked into the codebase"]);
	});

	it("allows an ancestor's conditional rule to match a read in a sibling of cwd without walking that sibling's instructions", () => {
		const cwd = join(fixture, "project");
		mkdirSync(cwd);
		write(fixture, ".claude/rules/ancestor.md", "---\npaths: sibling/**\n---\nAncestor rule");
		write(fixture, "sibling/CLAUDE.md", "not a nested directory");
		const filePath = write(fixture, "sibling/a.ts", "x");
		expect(nestedInstructionFiles({ cwd, filePath, home: fixture, rule: "claude-md" }).map((file) => file.content)).toEqual(["Ancestor rule"]);
	});

	it("resolves an outside-spelled symlink into cwd before walking nested directories and matching rules", () => {
		const cwd = join(fixture, "project");
		write(cwd, "src/a.ts", "x");
		write(cwd, "src/.claude/CLAUDE.md", "Nested instructions");
		write(cwd, "src/.claude/rules/ts.md", "---\npaths: '*.ts'\n---\nNested conditional");
		const alias = join(fixture, "alias");
		symlinkSync(join(cwd, "src"), alias);
		expect(nestedInstructionFiles({ cwd, filePath: join(alias, "a.ts"), home: fixture, rule: "claude-md" }).map((file) => file.content)).toEqual(["Nested instructions", "Nested conditional"]);
		// The same, from a cwd that is itself spelled through a symlink.
		const linkedCwd = join(fixture, "linked-project");
		symlinkSync(cwd, linkedCwd);
		expect(nestedInstructionFiles({ cwd: linkedCwd, filePath: join(alias, "a.ts"), home: fixture, rule: "claude-md" }).map((file) => file.content)).toEqual(["Nested instructions", "Nested conditional"]);
	});

	it("reads .claude/CLAUDE.md with its own parsed includes and never lets rules alone suppress AGENTS fallback", () => {
		const cwd = join(fixture, "project");
		const agents = write(cwd, "AGENTS.md", "agent rule");
		write(cwd, ".claude/rules/only.md", "rule");
		const opts = { cwd, home: fixture, homeClaudeDir: join(fixture, "user"), rule: "claude-md-or-agents-md" as const };
		expect(discoverContextFiles(opts).some((file) => file.path === agents)).toBe(true);
		const hidden = write(cwd, ".claude/CLAUDE.md", "---\npaths: never/**\n---\n  Hidden. @note.md\n");
		const included = write(cwd, ".claude/note.md", "---\nname: note\n---\nNote.\n");
		const files = discoverContextFiles(opts);
		expect(files.some((file) => file.path === agents)).toBe(false);
		expect(files.filter((file) => [hidden, included].includes(file.path)).map((file) => file.content)).toEqual(["Hidden. @note.md", "Note."]);
	});
	it("orders startup as managed file/rules, user file/rules, then each ancestor's files, rules and local file", () => {
		const cwd = join(fixture, "project", "sub");
		const managed = join(fixture, "managed");
		const user = join(fixture, "user");
		const project = dirname(cwd);
		const mFile = write(managed, "CLAUDE.md", "managed-file");
		const mRule = write(managed, ".claude/rules/m.md", "managed-rule");
		const uFile = write(user, "CLAUDE.md", "user-file");
		const uRule = write(user, "rules/u.md", "user-rule");
		const pFile = write(project, "CLAUDE.md", "project-file");
		const pDot = write(project, ".claude/CLAUDE.md", "project-dot");
		const pRule = write(project, ".claude/rules/p.md", "project-rule");
		const pLocal = write(project, "CLAUDE.local.md", "project-local");
		const sFile = write(cwd, "CLAUDE.md", "sub-file");
		const sDot = write(cwd, ".claude/CLAUDE.md", "sub-dot");
		const sRule = write(cwd, ".claude/rules/s.md", "sub-rule");
		const sLocal = write(cwd, "CLAUDE.local.md", "sub-local");
		const expected = [mFile, mRule, uFile, uRule, pFile, pDot, pRule, pLocal, sFile, sDot, sRule, sLocal];
		const files = discoverContextFiles({ cwd, homeClaudeDir: user, managedDir: managed, home: fixture, rule: "claude-md" })
			.filter((file) => expected.includes(file.path));
		expect(files.map((file) => file.path)).toEqual(expected);
		expect(files.map((file) => file.content)).toEqual(["managed-file", "managed-rule", "user-file", "user-rule", "project-file", "project-dot", "project-rule", "project-local", "sub-file", "sub-dot", "sub-rule", "sub-local"]);
	});

	it("suppresses AGENTS fallback when an ancestor .claude/CLAUDE.md exists, and independent/managed modes have their separate surfaces", () => {
		const cwd = join(fixture, "project", "sub");
		const project = dirname(cwd);
		const managed = join(fixture, "managed");
		const user = join(fixture, "user");
		write(project, ".claude/CLAUDE.md", "ancestor claude");
		const agent = write(cwd, "AGENTS.md", "agent");
		const managedFile = write(managed, "CLAUDE.md", "managed");
		const managedRule = write(managed, ".claude/rules/m.md", "managed rule");
		write(user, "CLAUDE.md", "user");
		const fallback = discoverContextFiles({ cwd, homeClaudeDir: user, managedDir: managed, home: fixture, rule: "claude-md-or-agents-md" });
		expect(fallback.some((file) => file.path === agent)).toBe(false);
		const managedOnly = discoverContextFiles({ cwd, homeClaudeDir: user, managedDir: managed, home: fixture, rule: "managed-only" })
			.filter((file) => [managedFile, managedRule].includes(file.path));
		expect(managedOnly.map((file) => file.path)).toEqual([managedFile, managedRule]);
		expect(discoverContextFiles({ cwd, homeClaudeDir: user, managedDir: managed, home: fixture, rule: "agents-md" }).filter((file) => file.path === agent).map((file) => file.path)).toEqual([agent]);
		// Rules are never an independent AGENTS.md-mode attachment.
		expect(discoverContextFiles({ cwd, homeClaudeDir: user, managedDir: managed, home: fixture, rule: "agents-md" }).some((file) => file.path.endsWith(join("rules", "m.md")))).toBe(false);
	});

	it("uses trimmed parsed rule bodies and descriptors at startup, but nested attachments keep raw parsed bodies without descriptors", () => {
		const cwd = join(fixture, "project");
		const nested = join(cwd, "src");
		const user = join(fixture, "user");
		const rule = write(nested, ".claude/rules/rule.md", "---\npaths: **\n---\n\n  raw body  \n");
		write(nested, "x.ts", "x");
		const startup = discoverContextFiles({ cwd: nested, homeClaudeDir: user, home: fixture, rule: "claude-md" }).find((file) => file.path === rule);
		expect(startup?.content).toBe("raw body");
		const block = buildClaudeMdBlock({ contextFiles: startup ? [startup] : [] }) ?? "";
		expect(block).toContain(`Contents of ${rule} (project instructions, checked into the codebase):\n\nraw body`);
		const [late] = nestedInstructionFiles({ filePath: join(nested, "x.ts"), cwd, rule: "claude-md", home: fixture, homeClaudeDir: user });
		expect(late?.content).toBe("raw body  \n");
		expect(late && nestedInstructionText(late)).toBe(`Contents of ${rule}:\n\nraw body  \n`);
	});

	it("orders nested managed/user conditional rules, each nested directory's files and rules, then ancestor conditional rules", () => {
		const cwd = join(fixture, "project");
		const user = join(fixture, "user");
		const managed = join(fixture, "managed");
		write(cwd, "src/deep/x.ts", "x");
		write(managed, ".claude/rules/m.md", "---\npaths: src/**\n---\nmanaged");
		write(user, "rules/u.md", "---\npaths: src/**\n---\nuser");
		write(cwd, ".claude/rules/root.md", "---\npaths: src/**\n---\nroot conditional");
		write(cwd, "src/CLAUDE.md", "src file");
		write(cwd, "src/.claude/CLAUDE.md", "src dot");
		write(cwd, "src/CLAUDE.local.md", "src local");
		write(cwd, "src/.claude/rules/always.md", "always");
		write(cwd, "src/.claude/rules/match.md", "---\npaths: deep/**\n---\nsrc conditional");
		write(cwd, "src/deep/.claude/rules/always.md", "deep always");
		write(cwd, "src/deep/.claude/rules/match.md", "---\npaths: **\n---\ndeep conditional");
		const nestedFiles = nestedInstructionFiles({ filePath: join(cwd, "src/deep/x.ts"), cwd, rule: "claude-md", home: fixture, homeClaudeDir: user, managedDir: managed });
		expect(nestedFiles.map((file) => file.content)).toEqual([
			"managed", "user", "src file", "src dot", "src local", "always", "src conditional", "deep always", "deep conditional", "root conditional",
		]);
	});
});

describe("claude-context rule attachment wiring", () => {
	it("does not mark a filtered conditional import as shown, and never repeats a startup rule on read", async () => {
		const home = join(fixture, "home");
		const cwd = join(fixture, "project");
		write(cwd, "src/a.ts", "x");
		write(cwd, ".claude/rules/always.md", "Always. @./conditional.md\n");
		const conditional = write(cwd, ".claude/rules/conditional.md", "---\npaths: src/**\n---\nOnly source files.\n");
		stubHome(home);
		const fake = createFakePi();
		const emitted: Array<{ text?: string; placement?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push(data as never));
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd });
		await fake.fireOne("session_start", {}, ctx);
		expect(emitted.some((entry) => entry.text?.includes("Only source files."))).toBe(false);
		await fake.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, isError: false, content: [] }, ctx);
		expect(emitted.filter((entry) => !entry.placement).map((entry) => entry.text)).toEqual([`Contents of ${conditional}:\n\nOnly source files.\n`]);
	});

	it("freezes successful startup in first-prepend, attaches a matching nested rule once, and resets only attachments on compaction/tree", async () => {
		const home = join(fixture, "home");
		const cwd = join(fixture, "project");
		write(cwd, "CLAUDE.md", "startup instruction\n");
		write(cwd, "src/other.ts", "other");
		write(cwd, "src/match/yes.ts", "yes");
		const rule = write(cwd, "src/.claude/rules/only-match.md", "---\npaths: match/**\n---\nmatching nested rule\n");
		stubHome(home); // CLAUDE_CONFIG_DIR remains unset: use the fake home's ~/.claude.
		const fake = createFakePi();
		const emitted: Array<{ text?: string; key?: string; placement?: string; scope?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push(data as never));
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd });
		await fake.fireOne("session_start", {}, ctx);
		const startup = emitted.filter((entry) => entry.key === "claude-context");
		expect(startup).toHaveLength(1);
		expect(startup[0]).toMatchObject({ placement: "first-prepend", scope: "every-turn" });
		expect(startup[0].text).toContain("startup instruction");

		const read = (path: string, isError = false) => fake.fire("tool_result", { toolName: "read", input: { path }, isError, content: [] }, ctx);
		// An unsuccessful and an unmatched successful read must not consume the later matching rule.
		await read("src/match/yes.ts", true);
		await read("src/other.ts");
		expect(emitted.filter((entry) => entry.key === undefined && entry.text?.includes("matching nested rule"))).toHaveLength(0);
		await read("src/match/yes.ts");
		expect(emitted.filter((entry) => entry.key === undefined && entry.text === `Contents of ${rule}:\n\nmatching nested rule\n`)).toHaveLength(1);
		await read("src/match/yes.ts");
		expect(emitted.filter((entry) => entry.key === undefined && entry.text?.includes("matching nested rule"))).toHaveLength(1);

		await fake.fireOne("session_compact", {}, ctx);
		await read("src/match/yes.ts");
		await fake.fireOne("session_tree", {}, ctx);
		await read("src/match/yes.ts");
		expect(emitted.filter((entry) => entry.key === undefined && entry.text?.includes("matching nested rule"))).toHaveLength(3);
		// The startup prefix is not re-emitted or altered by attachment resets.
		expect(emitted.filter((entry) => entry.key === "claude-context")).toEqual(startup);
	});
});
