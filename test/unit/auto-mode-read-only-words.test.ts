import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasReadOnlyShellWords, parseCommand } from "../../extensions/auto-mode/shell-analysis.ts";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "cc-read-only-words-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

const proven = (command: string) => hasReadOnlyShellWords(parseCommand(command).segments[0], cwd, cwd);

describe("hasReadOnlyShellWords", () => {
	it.each([
		`rg -g '!**/x/**' slugify .`,
		`grep --include='**/x/**' --exclude-dir='**/y/**' slugify .`,
		`git diff -- ':!**/x/**'`,
		`find . -name 'settings*' -print`,
		`uniq a`,
		`cat ~/.claude/settings.json`,
		`echo '.claude/settings.json'`,
		`rg -g '!**/x/**' slugify . 2>/dev/null`,
		`find . -not -path './.git/*' -name '*.pem'`,
		`cat Makefile`,
		`cat .env`,
	])("uses the pre-gate's option/operand proof: %s", (command) => {
		expect(proven(command)).toBe(true);
	});

	it.each([
		`uniq a .claude/settings.local.json`,
		`uniq sample-*`,
		`rg --pre=prog -g '!**/x/**' slugify .`,
		`git diff --output=.claude/settings.json`,
		`git -c diff.external=prog diff`,
		`find .claude -name 'settings*' -delete`,
		`find . -name '*.pem' -delete`,
		`sort -o Makefile a`,
		`cp .env x`,
		`sort --output=.claude/settings.json a`,
		`cp x .claude/settings.json`,
		`fd --exclude '**/x/**' slugify .`,
		`./rg -g '!**/x/**' slugify .`,
		`env rg -g '!**/x/**' slugify .`,
		`RIPGREP_CONFIG_PATH=config rg -g '!**/x/**' slugify .`,
		`rg -g "$pattern" slugify .`,
		`echo "$(cp x .claude/settings.json)"`,
		`cat <(cp x .claude/settings.json)`,
		`echo x > .claude/settings.*`,
		`echo x > out.txt`,
		`printf -v PATH ./bin`,
		`printf '%n' PATH`,
		`cat <<'EOF'\ncp x .claude/settings.json\nEOF`,
	])("does not substitute a command name for a proof: %s", (command) => {
		expect(proven(command)).toBe(false);
	});

	it("does not exempt read-only words within a substitution", () => {
		const inner = parseCommand(`echo "$(cat .claude/settings.json)"`).segments[1];
		expect(hasReadOnlyShellWords(inner, cwd, cwd)).toBe(false);
	});

	it("retains git's checkout-program veto", () => {
		mkdirSync(join(cwd, ".git"));
		writeFileSync(join(cwd, ".git", "config"), "[diff]\nexternal = prog\n");
		expect(proven(`git diff -- ':!**/x/**'`)).toBe(false);
	});
});

describe("shell command word source ranges", () => {
	it("marks expansions outside simple-command words as unattributed", () => {
		expect(parseCommand("(( PATH = 0 )); cat file").unattributedExpansion).toBe(true);
		expect(parseCommand("case $((PATH=0)) in *) true;; esac; cat file").unattributedExpansion).toBe(true);
		expect(parseCommand("if rg needle .; then code=$?; fi").unattributedExpansion).toBe(false);
	});

	it("attributes only words, including words after redirects and repeated spellings", () => {
		const command = `if rg 2>/dev/null -g '!**/x/**' slugify .; then cat .claude/settings.json > .claude/settings.json; fi`;
		const { segments } = parseCommand(command);
		expect(segments.map((segment) => segment.wordRanges?.map(({ start, end }) => command.slice(start, end)))).toEqual([
			["rg", "-g", "'!**/x/**'", "slugify", "."],
			["cat", ".claude/settings.json"],
		]);
	});

	it("keeps heredoc bodies and here-strings out of command word ranges", () => {
		for (const command of [`cat <<'EOF'\n.claude/settings.json\nEOF`, `cat <<< '.claude/settings.json'`]) {
			const [segment] = parseCommand(command).segments;
			expect(segment.wordRanges?.map(({ start, end }) => command.slice(start, end))).toEqual(["cat"]);
		}
	});

	it("does not reuse backtick-body offsets as offsets into the whole line", () => {
		const { segments } = parseCommand("cat <<EOF\n`cat .claude/settings.json`\nEOF");
		expect(segments[1].substitution).toBeDefined();
		expect(segments[1].wordRanges).toBeUndefined();
	});
});
