import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSafetyControlTarget, safetyControlWrite } from "../../extensions/auto-mode/safety-floor.ts";
import { analyzeShellCommand } from "../../extensions/auto-mode/shell-analysis.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { oneCodeProjectSettingsPath } from "../../extensions/lib/one-code-settings.ts";
import { claudeJsonPath, forwardSlashes, toPosixPath } from "../../extensions/lib/paths.ts";

let home: string;
let cwd: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cc-floor-home-"));
	cwd = mkdtempSync(join(tmpdir(), "cc-floor-cwd-"));
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", "settings.json"), "{}");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

const check = (toolName: string, input: Record<string, unknown>) =>
	safetyControlWrite({ toolName, input, cwd, home });

/** A path as it is spelled inside a bash command line: forward slashes (a backslash is an escape there). */
const sh = forwardSlashes;

describe("safetyControlWrite: writing tools", () => {
	it("floors a write to the user settings file, however it is spelled", () => {
		expect(check("write", { path: join(home, ".claude", "settings.json") })).toContain("permission rules");
		expect(check("edit", { file_path: join(home, ".claude", "settings.json") })).toBeDefined();
		expect(check("write", { path: "~/.claude/settings.json" })).toBeDefined();
	});

	it("floors project-scope settings files, in this checkout or another", () => {
		expect(check("write", { path: ".claude/settings.json" })).toBeDefined();
		expect(check("write", { path: ".claude/settings.local.json" })).toBeDefined();
		expect(check("write", { path: join(tmpdir(), "other-checkout", ".claude", "settings.json") })).toBeDefined();
	});

	it("floors ~/.claude.json, which also carries permission state", () => {
		expect(check("write", { path: join(home, ".claude.json") })).toBeDefined();
	});

	it("stays out of the way of routine writes, including elsewhere under ~/.claude", () => {
		// ~/.claude also holds memory and skills the agent writes routinely; a
		// floor that fires on routine work teaches the user to approve blind.
		expect(check("write", { path: join(cwd, "src", "index.ts") })).toBeUndefined();
		expect(check("write", { path: join(home, ".claude", "projects", "p", "memory", "note.md") })).toBeUndefined();
		expect(check("write", { path: join(home, ".claude", "skills", "deploy", "SKILL.md") })).toBeUndefined();
		expect(check("read", { path: join(home, ".claude", "settings.json") })).toBeUndefined();
	});

	it("resolves a symlink to a settings file rather than trusting the literal path", () => {
		symlinkSync(join(home, ".claude", "settings.json"), join(cwd, "innocent.json"));
		expect(check("write", { path: join(cwd, "innocent.json") })).toBeDefined();
	});

	it("resolves a symlinked parent directory, even for a file that does not exist yet", () => {
		symlinkSync(join(home, ".claude"), join(cwd, "cfg"));
		expect(check("write", { path: join(cwd, "cfg", "settings.json") })).toBeDefined();
	});
});

describe("safetyControlWrite: shell commands", () => {
	it("floors a redirect into the settings file", () => {
		expect(check("bash", { command: `echo '{}' > ${sh(join(home, ".claude", "settings.json"))}` })).toBeDefined();
		expect(check("bash", { command: "echo '{}' > ~/.claude/settings.json" })).toBeDefined();
	});

	it("floors file-writing commands aimed at settings files", () => {
		expect(check("bash", { command: `cp /tmp/mine.json ${sh(join(cwd, ".claude", "settings.local.json"))}` })).toBeDefined();
	});

	it("does not floor reads of the same files", () => {
		expect(check("bash", { command: "cat ~/.claude/settings.json" })).toBeUndefined();
	});

	it("leaves ordinary shell work alone", () => {
		expect(check("bash", { command: "npm test" })).toBeUndefined();
		expect(check("bash", { command: `echo hi > ${join(cwd, "out.txt")}` })).toBeUndefined();
	});
});

describe("safetyControlWrite: read-only words in escalated compound commands", () => {
	const observed = `git diff --check && git diff -- README.md CHANGELOG.md src/text_utils.py src/inventory.py && if rg --hidden --no-ignore -n --glob '!.git/**' --glob '!node_modules/**' --glob '!**/__pycache__/**' 'slugify' .; then echo 'Old name still present'; exit 1; else code=$?; if [ "$code" -eq 1 ]; then echo 'No old-name references found'; else exit "$code"; fi; fi && git status --short`;

	it.each([
		observed,
		`rg -g '!**/__pycache__/**' slugify . && exit 0`,
		`rg -g'!**/x/**' slugify . && exit 0`,
		`grep -r --include='**/x/**' slugify . && exit 0`,
		`grep -r --exclude-dir '**/x/**' slugify . && exit 0`,
		`git diff -- ':!**/x/**' && exit 0`,
		`cat .claude/settings.json && exit 0`,
		`rg 2>/dev/null -g '!**/x/**' slugify . && exit 0`,
		`find . -name 'settings*' -print && exit 0`,
		`rg -g '!**/.claude/settings.json' slugify . && exit 0`,
		`grep --exclude-dir '.claude/settings.json' slugify . && exit 0`,
		`git diff -- ':!.claude/settings.json' && exit 0`,
		`npm test && rg -g '!**/x/**' slugify .`,
		`echo '😀'; rg -g '!**/x/**' slugify . && exit 0`,
		// A -regex whose fixed tail no control file's name can end with.
		`find src -regex '.*\\.orig' -delete`,
		`find . -iregex '.*/node_modules/.*\\.LOG$' -delete`,
		`find . -regex '.*/build/' -exec rm -rf {} +`,
		// A pipeline of proven read-only commands runs no member's output (GPT-6.1 Sol, live).
		`pwd; ls -la; git status --short; cat Makefile; find . -maxdepth 3 -type f -not -path './.git/*' | sort`,
		`cat Makefile; find . -path './.git/*' | sort | head -n 5`,
		`cat Makefile; cat .claude/settings.json | jq .permissions`,
		// A read that names a credential or execution-primitive path escalates for the classifier but cannot write (DeepSeek V4.1 Flash, live).
		`grep -rnIE "(sk_[A-Za-z0-9_]{8,}|-----BEGIN)" . 2>/dev/null | grep -v node_modules | head -30; echo "=== keys ==="; find . -not -path './.git/*' -not -path './node_modules/*' \\( -name "*.pem" -o -name "*.key" -o -name "*.env*" \\) 2>/dev/null`,
		`find . -not -path './.git/*' -name '*.pem' && exit 0`,
		`cat Makefile && find . -path './.git/*' -name Makefile`,
		// A negated find pattern excludes files; it never selects one (Qwen 3.8 Flash, live).
		`find . -type f -not -path './.git/*' | head -50 && echo '---' && wc -l $(find . -type f \\( -name '*.py' -o -name '*.ts' \\) -not -path './.git/*' -not -path './node_modules/*')`,
		`find . -not \\( -path './.git/*' -o -path './node_modules/*' \\) -name '*.py' | xargs wc -l && exit 0`,
		// A loop anywhere leaves every word unproven; a negated glob pattern still names nothing (DeepSeek V4.1 Flash, live).
		`find src tests -type f -not -path '*/node_modules/*' | sort && for f in tests/*.py; do echo "--- $f ---"; cat "$f"; done`,
		`for f in a b; do echo "$f"; done; find . ! -path '*/.claude/*' -name '*.py'`,
		`for f in a b; do echo "$f"; done; find . -not \\( -path './.git/*' -o -path './node_modules/*' \\) \\( -name '*.py' -o -name '*.ts' \\) | sort`,
	])("does not floor proven read-only words: %s", (command) => {
		expect(analyzeShellCommand({ command, cwd, home }).verdict).toBe("escalate");
		expect(check("bash", { command })).toBeUndefined();
		expect(check("monitor", { command })).toBeUndefined();
	});

	it.each([
		`uniq a .claude/settings.local.json`,
		`echo x >&.claude/settings.json`,
		`cp x .claude/settings.json`,
		`find .claude -name 'settings*' -delete`,
		`rsync --delete src/ .claude/settings.json`,
		`echo x > .claude/settings.*`,
		`rg -g '!**/x/**' slugify . > .claude/settings.*`,
		`rg --pre='cp x .claude/settings.json' slugify .`,
		`git diff --output=.claude/settings.json`,
		`sh -c 'cp x .claude/settings.json'`,
		`echo "$(cp x .claude/settings.json)"`,
		`cat <(cp x .claude/settings.json)`,
		`unknown --output=.claude/settings.json`,
		`rg -g '!**/x/**' slugify .; cp x .claude/settings.json`,
		`cp x .claude/settings.json; rg -g '!**/x/**' slugify .`,
		`cat .claude/settings.json > .claude/settings.json`,
		`cat < .claude/settings.json && exit 0`,
		`echo '😀'; cat .claude/settings.json; cp x .claude/settings.json`,
		`cat .claude/settings.json > .claude/settings.*`,
		`{ rg -g '!**/x/**' slugify .; } > .claude/settings.*`,
		`rg -g '!**/x/**' slugify . && mystery '**/x/**'`,
		`rg -g '!**/x/**' slugify . && fd --exclude '**/x/**' slugify .`,
		`rg --unmodelled-option -g '!**/x/**' slugify .`,
		`rg -g '!**/x/**' slugify . && sh -c 'cat .claude/settings.json'`,
		`rg -g '!**/x/**' slugify . && echo "$(cat .claude/settings.json)"; exit 0`,
		`echo 'cp x .claude/settings.json' | sh`,
		`cat Makefile; find . -path './.git/*' | sh`,
		`cat Makefile; find . -path './.git/*' | mystery`,
		`cat Makefile; find . -path './.git/*' -delete | sort`,
		`cat Makefile; find . -path './.git/*' | { sort; mystery; }`,
		`cat Makefile; (find . -path './.git/*' | sort)`,
		`cat Makefile; echo "$(find . -path './.git/*' | sort)"`,
		`cat Makefile; find . -path "$(mystery)/*" | sort`,
		`find . -path './.git/*' -name '*.key' -exec mystery {} + && exit 0`,
		`find . -not -path './.git/*' -name 'settings*' -delete && exit 0`,
		`find . -not \\( -path './x/*' \\) -name '*' -delete && exit 0`,
		`find . -not -path './x/*' -o -name 'settings.json' -delete && exit 0`,
		`rm $(find .claude -name 'settings*')`,
		// A negated pattern selects everything else under `-o`, a second negation or a negated conjunction, and a find that acts may act on any file it leaves in.
		`find .claude -not -name settings.json -o -exec cp evil.json {} \\;`,
		`find .claude -not -name settings.json -o -delete`,
		`find . -not -not -name settings.json -exec cp evil.json {} \\;`,
		`find . ! ! -name settings.json -delete`,
		`find . -not \\( -not -name settings.json \\) -delete`,
		`find .claude -not \\( -name settings.json -empty \\) -exec cp evil.json {} \\;`,
		`find .claude -not \\( -name settings.json -empty \\) | xargs -I{} cp evil.json {}`,
		`find . -not -regex '.*settings\\.json' -o -delete`,
		`find ~ -maxdepth 1 -not -name '.claude.j*' -o -exec cp evil.json {} \\;`,
		`find . -not -name settings.json -o -print | xargs -I{} cp evil.json {}`,
		`find ~/.claude -not -path '*/settings.json' -o -exec cp evil.json {} \\;`,
		`find . -not -path '*/.claude/settings*' -o -exec cp evil.json {} \\;`,
		`find . -not -path '*/settings.json' -o -delete`,
		`find . ! -name keep -delete`,
		`find . ! \\( -name ')' -name keep \\) -delete`,
		`find .claude -printf ! -name settings.json -print | xargs -I{} cp evil.json {}`,
		// find's actions are not read, so a negation there is not trusted to exclude, whatever the action runs.
		`find . ! -path './.git/*' -exec wc -l {} + && exit 0`,
		`find . -not \\( -path './.git/*' -o -path './node_modules/*' \\) -name '*.py' -exec wc -l {} + && exit 0`,
		// A proven command's output can still reach a script file through an enclosing redirect, an `exec` or an fd dup.
		`{ echo 'cp evil.json .claude/settings.json'; } > s.sh; sh s.sh`,
		`if true; then echo 'cp evil.json .claude/settings.json'; fi > s.sh && sh s.sh`,
		`exec 3>s.sh; echo 'cp evil.json .claude/settings.json' >&3; sh s.sh`,
		`exec > s.sh; echo 'cp evil.json .claude/settings.json'; sh s.sh`,
		`{ echo 'cp evil.json .claude/settings.json' | sort; } > s.sh; sh s.sh`,
		`sh <<'EOF'\ncp x .claude/settings.json\nEOF`,
		`cat <<'EOF' | sh\ncp x .claude/settings.json\nEOF`,
		`sh <<< 'cp x .claude/settings.json'`,
		`for f in .claude/settings.json; do mystery "$f"; done`,
		`case .claude/settings.json in *) mystery;; esac`,
		`cat .claude/settings.json; echo "unterminated`,
		`cat() { cp x "$1"; }; cat .claude/settings.json`,
		`alias cat=cp; cat .claude/settings.json`,
		`eval "$setup"; cat .claude/settings.json`,
		`source setup; cat .claude/settings.json`,
		`PATH=./bin; cat .claude/settings.json`,
		`printf -v PATH ./bin; cat .claude/settings.json`,
		`read PATH; cat .claude/settings.json`,
		`for PATH in ./bin; do true; done; cat .claude/settings.json`,
		`(( PATH = 0 )); cat .claude/settings.json`,
		`echo "$((PATH = 0))"; cat .claude/settings.json`,
		`PATH[0]=./bin; cat .claude/settings.json`,
		`echo "${'${PATH:=./bin}'}"; cat .claude/settings.json`,
		`case $((PATH=0)) in *) true;; esac; cat .claude/settings.json`,
		`echo x > "${'${PATH:=./bin}'}"; cat .claude/settings.json`,
		`cat <<< "${'${PATH:=./bin}'}"; cat .claude/settings.json`,
		// A later command can reuse an earlier one's words through $_.
		`echo .claude/settings.json; rm "$_"`,
		`echo .claude/settings.json; sed -i 's/x/y/' "$_"`,
		`ls ~/.claude/settings.json && cp /tmp/evil "$_"`,
		`echo .claude/settings.json; rm "${'${_}'}"`,
		`echo .claude/settings.json; rm "${'${_%.json}'}.json"`,
		`echo .claude/settings.json; sh <<EOF\nrm "$_"\nEOF`,
		// -regex/-iregex match the whole path, which a file-name glob cannot model.
		`find . -regex '.*settings.json' -delete`,
		`find . -iregex '.*SETTINGS.JSON' -delete`,
		`find . -regex '.*/\\.claude/.*' -exec rm {} +`,
		`find . -regex '.*\\.json' -delete`,
		`find . -regex '.*settings.json\\'"'"'' -delete`,
		`find . -regex '.*\\(orig\\|json\\)' -delete`,
		`find . -regextype posix-extended -regex '.*\\.orig' -delete`,
		`find . -regex "$pattern" -delete`,
		`find . -regex '.*' -delete`,
		`find . ! -regex '.*\\.orig' -delete`,
		`find . -not -regex '.*\\.orig' -delete`,
		`find . -regex '.*\\.orig' -o -delete`,
		`find . \\( -regex '.*\\.orig' -or -name x \\) -delete`,
		`find . -regex '.*\\.orig' , -delete`,
		`: {PATH}>/dev/null; cat .claude/settings.json && cp x y`,
		`{ :; } {PATH}>/dev/null; cat .claude/settings.json && cp x y`,
		`exec {PATH}>&2; cat .claude/settings.json && cp x y`,
		`coproc { :; }; cat .claude/settings.json && cp x y`,
		`coproc PATH { :; }; cat .claude/settings.json && cp x y`,
		`cat .claude/settings.json; wait -p PATH; cat .claude/settings.json && cp x y`,
		`cat() ((1)); cat .claude/settings.json; cp x y`,
	])("keeps writes and unproven commands on the floor: %s", (command) => {
		expect(check("bash", { command })).toBeDefined();
	});
});

describe("safetyControlWrite: relocated config dirs (distribution L2)", () => {
	const savedClaude = process.env.CLAUDE_CONFIG_DIR;
	const savedState = process.env.ONECODE_STATE_DIR;
	afterEach(() => {
		if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = savedClaude;
		if (savedState === undefined) delete process.env.ONECODE_STATE_DIR;
		else process.env.ONECODE_STATE_DIR = savedState;
	});

	it("floors the relocated .claude.json when CLAUDE_CONFIG_DIR is set", () => {
		const cfg = join(cwd, "cc-work");
		mkdirSync(cfg, { recursive: true });
		process.env.CLAUDE_CONFIG_DIR = cfg;
		expect(check("write", { path: claudeJsonPath(home) })).toBeDefined();
	});

	it("floors the per-repo One Code settings file for the current cwd", () => {
		const perRepo = oneCodeProjectSettingsPath(cwd, home);
		expect(check("write", { path: perRepo })).toBeDefined();
	});

	it("floors the per-repo One Code settings file under a relocated ONECODE_STATE_DIR", () => {
		const state = join(cwd, "state");
		process.env.ONECODE_STATE_DIR = state;
		const perRepo = oneCodeProjectSettingsPath(cwd, home);
		expect(perRepo.startsWith(state)).toBe(true);
		expect(check("write", { path: perRepo })).toBeDefined();
	});
});

describe("isSafetyControlTarget", () => {
	it("matches any .claude settings tail, wherever it lives", () => {
		expect(isSafetyControlTarget("/somewhere/else/.claude/settings.json", home)).toBe(true);
		expect(isSafetyControlTarget("/somewhere/else/.claude/settings.local.json", home)).toBe(true);
	});

	it("matches One Code's own settings files — global and per-repo — wherever they live", () => {
		// Both carry permissions.allow that bypasses the classifier, so a write to
		// either must hit the deterministic floor, not the auto-mode classifier.
		expect(isSafetyControlTarget("/home/u/.onecode/settings.json", home)).toBe(true);
		expect(isSafetyControlTarget("/home/u/.onecode/projects/-home-u-repo/settings.json", home)).toBe(true);
	});

	it("keeps Claude Code's relocated settings file on the floor in independent mode", () => {
		// Independent mode reads no Claude Code file, but a rule planted there takes
		// effect when the user switches back, so the floor guards it in both modes.
		const relocated = join(home, "cfg");
		process.env.CLAUDE_CONFIG_DIR = relocated;
		try {
			resetConfigModeForTest("independent");
			expect(isSafetyControlTarget(join(relocated, "settings.json"), home)).toBe(true);
		} finally {
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	it("does not match lookalikes", () => {
		expect(isSafetyControlTarget("/repo/.claude/settings.json.bak", home)).toBe(false);
		expect(isSafetyControlTarget("/repo/claude/settings.json", home)).toBe(false);
		expect(isSafetyControlTarget("/repo/.claude/worktrees/x/settings.json", home)).toBe(false);
		// One Code's plan files and other .onecode contents are not gate controls.
		expect(isSafetyControlTarget("/home/u/.onecode/plans/p.md", home)).toBe(false);
		expect(isSafetyControlTarget("/home/u/.onecode/settings.json.bak", home)).toBe(false);
	});
});

describe.skipIf(process.platform !== "win32")("safetyControlWrite: Git Bash path spellings on Windows", () => {
	it("floors a settings write spelled /c/…", () => {
		expect(check("bash", { command: `echo '{}' > ${toPosixPath(join(home, ".claude", "settings.json"))}` })).toBeDefined();
	});

	it("floors a settings write spelled /tmp/… (this home is under %TEMP%)", () => {
		const underTemp = forwardSlashes(relative(tmpdir(), join(home, ".claude", "settings.json")));
		expect(check("bash", { command: `echo '{}' > /tmp/${underTemp}` })).toBeDefined();
	});
});
