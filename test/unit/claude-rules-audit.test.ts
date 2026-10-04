import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRuleInstructions } from "../../extensions/lib/claude-rules.ts";
import { discoverContextFiles } from "../../extensions/lib/claude-context.ts";

let root: string;
function write(path: string, content: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}
beforeEach(() => {
	mkdirSync(join(process.cwd(), ".scratch"), { recursive: true });
	root = realpathSync(mkdtempSync(join(process.cwd(), ".scratch", "rules-audit-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("instruction file size limits", () => {
	it("skips rule files over the reference's 4 MiB limit", () => {
		const path = write(join(root, ".claude", "rules", "huge.md"), "x".repeat(4_194_305));
		expect(readRuleInstructions(path, { cwd: root, home: root, scope: "Project" })).toHaveLength(0);
	});

	it("keeps files exactly at the byte limit, including UTF-8 text", () => {
		const path = write(join(root, "boundary.md"), "é".repeat(2_097_152));
		const files = readRuleInstructions(path, { cwd: root, home: root, scope: "Project" });
		expect(files).toHaveLength(1);
		expect(Buffer.byteLength(files[0].content)).toBe(4_194_304);
	});

	it("skips oversized legacy files and imported children", () => {
		const path = write(join(root, "CLAUDE.md"), "x".repeat(4_194_305));
		const local = write(join(root, "CLAUDE.local.md"), "Keep @huge.txt\n");
		write(join(root, "huge.txt"), "x".repeat(4_194_305));
		const files = discoverContextFiles({ cwd: root, home: root, homeClaudeDir: join(root, "home"), managedDir: join(root, "managed"), rule: "claude-md" });
		expect(files.some((file) => file.path === path)).toBe(false);
		expect(files.find((file) => file.path === local)?.content).toBe("Keep @huge.txt\n");
	});
});

describe("startup project import containment", () => {
	it("blocks relative and symlink escapes, while keeping in-project and user imports", () => {
		const cwd = join(root, "project");
		mkdirSync(cwd);
		write(join(root, "outside.txt"), "OUTSIDE SENTINEL");
		write(join(cwd, "inside.txt"), "INSIDE SENTINEL");
		symlinkSync(join(root, "outside.txt"), join(cwd, "alias.txt"));
		const path = write(join(cwd, "CLAUDE.md"), "@../outside.txt @alias.txt @inside.txt\n");
		const global = write(join(root, "home", "CLAUDE.md"), "@../outside.txt\n");
		const files = discoverContextFiles({ cwd, home: root, homeClaudeDir: join(root, "home"), managedDir: join(root, "managed"), rule: "claude-md" });
		expect(files.find((file) => file.path === path)?.content).toBe("@../outside.txt @alias.txt INSIDE SENTINEL\n");
		expect(files.find((file) => file.path === path)?.imported).toEqual([join(cwd, "inside.txt")]);
		expect(files.find((file) => file.path === global)?.content).toBe("OUTSIDE SENTINEL\n");
	});

	it("preserves the optional global ONECODE reader's external imports", () => {
		const cwd = join(root, "project");
		mkdirSync(cwd);
		write(join(root, "outside.txt"), "GLOBAL ONECODE IMPORT");
		const path = write(join(root, "onecode", "ONECODE.md"), "@../outside.txt\n");
		const files = discoverContextFiles({ cwd, home: root, homeClaudeDir: join(root, "home"), homeOneCodeDir: join(root, "onecode"), managedDir: join(root, "managed"), rule: "claude-md" });
		expect(files.find((file) => file.path === path)?.content).toBe("GLOBAL ONECODE IMPORT\n");
	});

	it.each(["CLAUDE.md", "CLAUDE.local.md"])("does not inline unapproved external imports from %s", (name) => {
		const cwd = join(root, "project");
		const external = write(join(root, "outside.txt"), "OUTSIDE PRIVATE SENTINEL");
		const path = write(join(cwd, name), `Project instructions. @${external}\n`);
		const file = discoverContextFiles({ cwd, home: root, homeClaudeDir: join(root, "home"), managedDir: join(root, "managed"), rule: "claude-md" }).find((file) => file.path === path);
		expect(file?.content).toBe(`Project instructions. @${external}\n`);
	});
});

describe("rule import reference behavior", () => {
	it("decodes binary-looking .md as UTF-8, as the reference reader does", () => {
		const path = join(root, "binary.md");
		writeFileSync(path, Buffer.from([0, 255, 65]));
		expect(readRuleInstructions(path, { cwd: root, home: root, scope: "Project" })[0]?.content).toBe("\u0000\uFFFDA");
	});
	it.each([
		"- Example `x @../../secret.txt `\n",
		"- Example <!-- @../../secret.txt -->\n",
		"1. Example ``x @../../secret.txt ``\n",
		"- Parent\n  - Example `x @../../secret.txt `\n",
	])("matches 2.1.289's raw list-container scan: %s", (content) => {
		// Y1n scans text containers before their children. This surprising
		// code/comment behavior is upstream, not an extension regression.
		const path = write(join(root, ".claude", "rules", "rule.md"), content);
		const imported = write(join(root, "secret.txt"), "PRIVATE SENTINEL");
		expect(readRuleInstructions(path, { cwd: root, home: root, scope: "Project" }).map((file) => file.path)).toEqual([path, imported]);
	});

	it("still imports ordinary and emphasized references in lists", () => {
		const path = write(join(root, ".claude", "rules", "rule.md"), "- @../../ordinary.txt\n- **@../../emphasized.txt**\n");
		const ordinary = write(join(root, "ordinary.txt"), "ordinary");
		const emphasized = write(join(root, "emphasized.txt"), "emphasized");
		expect(readRuleInstructions(path, { cwd: root, home: root, scope: "Project" }).map((file) => file.path)).toEqual([path, ordinary, emphasized]);
	});
});
