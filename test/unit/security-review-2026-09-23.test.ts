/**
 * Regression tests for SECURITY-REVIEW-2026-09-23: every probe from the
 * review must reach the classifier (or the floor), and the everyday reads the
 * pre-gate exists to fast-path must stay "safe".
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOptions, READ_ONLY_SPECS } from "../../extensions/auto-mode/read-only-options.ts";
import { safetyControlWrite, shellNamesControlFile } from "../../extensions/auto-mode/safety-floor.ts";
import { analyzeShellCommand, parseCommand } from "../../extensions/auto-mode/shell-analysis.ts";
import { configRunsProgram } from "../../extensions/auto-mode/git-checkout-programs.ts";
import { gitStatusMeta, gitStatusMetaArgs } from "../../extensions/auto-mode/git-status-meta.ts";
import { gitStatusOutput, HARNESS_GIT_CONFIG } from "../../extensions/lib/git.ts";
import { createLspTrustGate, isLspRootTrusted, persistLspTrust } from "../../extensions/lsp/trust.ts";
import { powershellReadOnly } from "../../extensions/permissions/powershell-rules.ts";

let root: string;
let cwd: string;
let home: string;
const posixOnly = it.skipIf(process.platform === "win32");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cc-sec-"));
	cwd = join(root, "project");
	home = join(root, "home");
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(cwd, "a.txt"), "a\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const verdict = (command: string) => analyzeShellCommand({ command, cwd, home }).verdict;
const floor = (command: string, toolName = "bash") => safetyControlWrite({ toolName, input: { command }, cwd, home });

describe("H1: read-only commands are proved by their options, not their name", () => {
	it("escalates git subcommands carrying options that write, delete or run a program", () => {
		for (const command of [
			"git branch -D main",
			"git branch -m old new",
			"git branch feature",
			"git tag v2",
			"git tag -d v1",
			"git tag -v v1",
			"git diff --output=out.txt",
			"git show --output=o HEAD",
			"git log --output=o",
			"git diff --ext-diff",
			"git grep -O foo",
			"git grep --open-files-in-pager=x foo",
			"git cat-file --textconv HEAD:a",
			"git ls-remote https://example.com/x.git",
			"git log --show-signature",
			"git diff --no-index a b",
			"git blame --contents x a.txt",
		]) {
			expect(verdict(command), command).toBe("escalate");
		}
	});

	it("does not let a required value hide the next option (parser agreement)", () => {
		// `-S` takes the next word as its value whatever it is, so `--output=f`
		// after `--` is still an option to git, and must be to the check too.
		expect(verdict("git diff -S -- --output=f")).toBe("escalate");
		// `--contains` does not swallow a following option.
		expect(verdict("git branch -l --contains -D main")).toBe("escalate");
	});

	it("escalates other read-only commands with options that write or run a program", () => {
		for (const command of [
			"rg --pre=cat foo",
			"rg --hostname-bin=x foo",
			"ack --pager=cat foo",
			"ag foo",
			"tree -o out.txt",
			"uniq a.txt b.txt",
			"sort -uo out.txt a.txt",
			"sort --compress-program=gzip a.txt",
			"file -C -m x",
			"wc --files0-from=list",
			"find . -fprint out",
			"find -fprint out",
			"find . -delete",
			"find . -exec rm {} ;",
			"printf -v PATH ./bin",
			"hostname evil",
			"date 010100002030",
			"date -s 2020-01-01",
		]) {
			expect(verdict(command), command).toBe("escalate");
		}
	});

	it("keeps everyday reads fast-pathed", () => {
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "b.ts"), "");
		for (const command of [
			"ls -la",
			"cat a.txt",
			"head -n 5 a.txt",
			"tail -5 a.txt",
			"wc -l src/*.ts",
			"grep -rn foo .",
			"rg -n --hidden -g '*.ts' foo src",
			"jq .name a.txt",
			"find . -name '*.ts' -type f -maxdepth 2",
			"sort -u a.txt",
			"uniq -c a.txt",
			"diff -u a.txt src/b.ts",
			"date +%s",
			"git status -sb",
			"git log --oneline -5",
			"git log --stat --format='%h %s' -n 3",
			"git diff --stat HEAD~1",
			"git diff -S foo -- src",
			"git show HEAD --name-only",
			"git branch",
			"git branch -a -v",
			"git branch --list 'feat*'",
			"git tag",
			"git tag -l 'v*'",
			"git blame -L 1,5 a.txt",
			"git grep -n foo",
			"git rev-parse --abbrev-ref HEAD",
			"git --no-pager log -1",
			"LANG=C sort a.txt",
		]) {
			expect(verdict(command), command).toBe("safe");
		}
	});

	it("parses short clusters and attached values like getopt", () => {
		const grep = READ_ONLY_SPECS.grep;
		const ok = checkOptions(grep, [{ value: "-rnA3" }, { value: "pat" }, { value: "src" }]);
		expect(ok.ok && ok.parsed.positionals.map((w) => w.value)).toEqual(["pat", "src"]);
		const withFile = checkOptions(grep, [{ value: "-f" }, { value: "pats.txt" }, { value: "src" }]);
		expect(withFile.ok && withFile.parsed.fileValues.map((w) => w.value)).toEqual(["pats.txt"]);
		expect(checkOptions(grep, [{ value: "-rX" }]).ok).toBe(false);
	});
});

describe("H2: assignments and git's retargeting options escalate", () => {
	it("escalates a leading assignment that is not locale or display", () => {
		for (const command of ["GIT_DIR=x git status", "GIT_CONFIG_COUNT=1 git status", "RIPGREP_CONFIG_PATH=x rg foo", "FOO=1 cat a.txt"]) {
			expect(verdict(command), command).toBe("escalate");
		}
	});

	it("escalates a bare assignment segment that changes what later words run", () => {
		expect(verdict("PATH=./bin; ls")).toBe("escalate");
	});

	it("escalates every retargeting git global option, in-project or not", () => {
		mkdirSync(join(cwd, "sub"));
		for (const command of [
			"git --config-env=core.pager=X log",
			"git --git-dir=sub status",
			"git --work-tree=sub status",
			"git --exec-path=sub status",
			"git --namespace=x log",
			"git -p log",
		]) {
			expect(verdict(command), command).toBe("escalate");
		}
		expect(verdict("git -C sub status")).toBe("safe");
	});
});

describe("H3: unmodelled writes reach the floor", () => {
	it("records `>&word` as a write target, and fd duplication as none", () => {
		expect(parseCommand("echo x >&out.txt").segments[0].redirects).toEqual(["out.txt"]);
		expect(parseCommand("echo x >& out.txt").segments[0].redirects).toEqual(["out.txt"]);
		expect(parseCommand("echo x 2>&1").segments[0].redirects).toEqual([]);
		expect(parseCommand("echo x >&-").segments[0].redirects).toEqual([]);
	});

	it("floors every probe that named .claude/settings.local.json", () => {
		for (const command of [
			"echo x >&.claude/settings.local.json",
			"uniq a.txt .claude/settings.local.json",
			"sort -uo .claude/settings.local.json a.txt",
			"tree -o .claude/settings.local.json",
			"python3 -c 'open(\".claude/settings.local.json\",\"w\")'",
			"cd .claude && cp ../a.txt settings.local.json",
			"sh -c 'cp a.txt .claude/./settings.local.json'",
			"dd if=a.txt of=.claude/settings.local.json",
		]) {
			expect(floor(command), command).toBeDefined();
		}
	});

	it("floors monitor commands like bash (L1)", () => {
		expect(floor("tee .claude/settings.local.json < a.txt", "monitor")).toBeDefined();
	});

	it("does not floor a proven read of a control file", () => {
		expect(floor("cat .claude/settings.json")).toBeUndefined();
		expect(floor("jq .permissions .claude/settings.json")).toBeUndefined();
	});

	it("names the control file a nested script writes", () => {
		expect(shellNamesControlFile("bash -lc 'echo x > .claude/settings.json'", cwd, home)).toBe(".claude/settings.json");
	});
});

describe("M1/M2: operands are judged where bash resolves them", () => {
	posixOnly("escalates a bare name that is a symlink out of the project", () => {
		writeFileSync(join(root, "outside.txt"), "secret");
		symlinkSync(join(root, "outside.txt"), join(cwd, "notes"));
		expect(verdict("cat notes")).toBe("escalate");
		// …and a glob match that is one.
		symlinkSync(join(root, "outside.txt"), join(cwd, "z.log"));
		expect(verdict("cat *.log")).toBe("escalate");
	});

	posixOnly("escalates a bare name that resolves onto a credential path", () => {
		mkdirSync(join(cwd, "keys"));
		writeFileSync(join(cwd, "keys", "id_rsa"), "k");
		symlinkSync(join(cwd, "keys", "id_rsa"), join(cwd, "readme"));
		expect(analyzeShellCommand({ command: "cat readme", cwd, home }).sensitivePaths).toContain("readme");
	});

	it("escalates ~name, ~- and ~+ reads and writes", () => {
		for (const command of ["cat ~root/x", "cat ~-/x", "ls ~+/..", "echo x > ~nobody/Desktop/x", "git -C ~root/repo status"]) {
			expect(verdict(command), command).toBe("escalate");
		}
		expect(verdict("cat ~/x")).toBe("escalate"); // outside the project, as before
	});

	it("escalates globs that could reach .. or cannot be enumerated", () => {
		for (const command of ["cat .?/x", "ls .*", "cat src/*/index.ts", "echo x > *.txt"]) {
			expect(verdict(command), command).toBe("escalate");
		}
		// Quoted glob characters are literal: find sees the pattern, bash expands nothing.
		expect(verdict("find . -name '*.ts'")).toBe("safe");
	});
});

describe("M3: jq's env builtin", () => {
	it("escalates a jq program that reads the environment", () => {
		expect(verdict("jq -n env")).toBe("escalate");
		expect(verdict("jq -n 'env.HOME'")).toBe("escalate");
		expect(verdict("jq .environment a.txt")).toBe("safe");
	});
});

describe("H5: PowerShell colon-bound values", () => {
	const opts = () => ({ cwd, home, readableRoots: [] });
	it("checks a -Param:value path like a positional", () => {
		for (const command of [
			"Get-Content -Path:/etc/hosts",
			"Get-Content -Path:~/.ssh/id_rsa",
			"Get-Content -LiteralPath:\\\\host\\share\\x",
			"Get-Content -Path:..\\x",
		]) {
			expect(powershellReadOnly(command, opts()).readOnly, command).toBe(false);
		}
		expect(powershellReadOnly("Get-Content -Path:a.txt", opts()).readOnly).toBe(true);
	});

	it("refuses credential paths and remote computers", () => {
		expect(powershellReadOnly("Get-Content .env", opts()).readOnly).toBe(false);
		expect(powershellReadOnly("Get-Process -ComputerName host", opts()).readOnly).toBe(false);
		expect(powershellReadOnly("Get-Service -Comp host", opts()).readOnly).toBe(false);
		expect(powershellReadOnly("Get-Service -Cn:host", opts()).readOnly).toBe(false);
		expect(powershellReadOnly("Get-Process -Name node", opts()).readOnly).toBe(true);
	});
});

describe("M4: project-code language servers need project trust", () => {
	it("trusts a root and everything under it, nothing beside it", () => {
		const store = join(root, "trust.json");
		expect(isLspRootTrusted(join(cwd, "crate"), store)).toBe(false);
		persistLspTrust(cwd, store);
		expect(isLspRootTrusted(join(cwd, "crate"), store)).toBe(true);
		expect(isLspRootTrusted(join(root, "other"), store)).toBe(false);
	});
});

describe("M5: harness git ignores the checkout's fsmonitor", () => {
	posixOnly("does not run core.fsmonitor from the checkout's config", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		const marker = join(root, "fsmonitor-ran");
		const hook = join(root, "hook.sh");
		writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		execFileSync("git", ["config", "core.fsmonitor", hook], { cwd });
		expect(HARNESS_GIT_CONFIG).toEqual(["-c", "core.fsmonitor=false", "--no-optional-locks"]);
		await gitStatusOutput(cwd, ["status", "--porcelain"]);
		expect(existsSync(marker)).toBe(false);
	});

	posixOnly("does not run the checkout's post-index-change hook", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["add", "a.txt"], { cwd });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd });
		const marker = join(root, "hook-ran");
		writeFileSync(join(cwd, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		// A touched file makes status refresh the index, which would write it.
		writeFileSync(join(cwd, "a.txt"), "a\n");
		await gitStatusOutput(cwd, ["status", "--porcelain"]);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("M5: every harness git call carries HARNESS_GIT_CONFIG", () => {
	it("finds no git spawn in extensions/ without the hardening", async () => {
		const { readdirSync, readFileSync, statSync } = await import("node:fs");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (path.endsWith(".ts")) files.push(path);
			}
		};
		walk(join(process.cwd(), "extensions"));
		// A spawn of the git binary whose argument list does not start with the
		// harness config. Marketplace fetches keep their own GIT_BASE_ARGS: they
		// run only in directories the harness cloned itself.
		const spawn = /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync|run|probe)\(\s*"git",(?!\s*\[\s*\.\.\.(?:HARNESS_GIT_CONFIG|GIT_BASE_ARGS)\b)/;
		const offenders = files.flatMap((file) =>
			readFileSync(file, "utf-8")
				.split("\n")
				.map((line, index) => ({ line, index }))
				.filter(({ line }) => spawn.test(line))
				.map(({ index }) => `${file.slice(process.cwd().length + 1)}:${index + 1}`),
		);
		expect(offenders).toEqual([]);
	});
});

describe("PR #8 review follow-ups", () => {
	it("escalates a glob with a bracket range JavaScript cannot compile, instead of throwing", () => {
		expect(verdict("cat [z-a]")).toBe("escalate");
		expect(verdict("ls .claude/[b-a]*")).toBe("escalate");
	});

	it("floors glob redirects and operands that expand onto a control file", () => {
		writeFileSync(join(cwd, ".claude", "settings.json"), "{}");
		for (const command of [
			"echo x > .claude/settings.*",
			"echo x > .claude/s*.json",
			"echo x > .claude/settings.loc?l.json",
			"echo x > .c*/settings.json",
			"cp evil.json .claude/settings.[jl]*",
		]) {
			expect(floor(command), command).toBeDefined();
		}
		expect(floor("Set-Content .claude/settings.* x", "powershell")).toBeDefined();
		// Globs that cannot spell a control file name stay with the classifier.
		expect(floor("echo x > .claude/notes.*")).toBeUndefined();
		expect(floor("echo x > build/*.log")).toBeUndefined();
		expect(floor("echo x > .claude/[z-a]")).toBeUndefined();
	});

	it("refuses the -C abbreviation of -ComputerName", () => {
		const opts = { cwd, home, readableRoots: [] };
		expect(powershellReadOnly("Get-Process -C host", opts).readOnly).toBe(false);
		expect(powershellReadOnly("Get-Service -C:host", opts).readOnly).toBe(false);
		expect(powershellReadOnly("Get-Process -Name node", opts).readOnly).toBe(true);
	});

	it("keys LSP session trust by the server's project, not the session's cwd", async () => {
		const other = join(root, "other");
		const store = join(root, "trust.json");
		const gate = createLspTrustGate({
			projectRoot: (dir) => (dir.startsWith(other) ? other : cwd),
			isTrusted: (serverRoot) => isLspRootTrusted(serverRoot, store),
			persist: (projectRoot) => persistLspTrust(projectRoot, store),
		});
		const asked: string[] = [];
		const yes = async (projectRoot: string) => {
			asked.push(projectRoot);
			return true;
		};
		expect(await gate.allowed(join(cwd, "crate"), yes)).toBe(true);
		// Trusting the current repository does not start a server in another one.
		expect(await gate.allowed(join(other, "crate"))).toBe(false);
		expect(await gate.allowed(join(other, "crate"), async () => false)).toBe(false);
		expect(asked).toEqual([cwd]);
		expect(isLspRootTrusted(join(other, "crate"), store)).toBe(false);
		// /lsp trust grants the cwd's project only.
		expect(gate.trust(join(cwd, "src"))).toBe(cwd);
	});

	it("honours a project's stored trust in a linked worktree outside it", async () => {
		const store = join(root, "trust.json");
		const worktree = join(root, "worktree");
		persistLspTrust(cwd, store);
		// A later session: nothing in memory, the worktree maps to its main checkout.
		const gate = createLspTrustGate({
			projectRoot: (dir) => (dir.startsWith(worktree) ? cwd : dir),
			isTrusted: (serverRoot) => isLspRootTrusted(serverRoot, store),
			persist: (projectRoot) => persistLspTrust(projectRoot, store),
		});
		expect(await gate.allowed(join(worktree, "crate"))).toBe(true);
	});

	posixOnly("lists ignored files and dirty submodules so a clean line is not claimed over them", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, ".gitignore"), ".env\n");
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		execFileSync("git", ["add", ".gitignore", "a.txt"], { cwd });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd });
		const wide = await gitStatusOutput(cwd, gitStatusMetaArgs(true));
		expect(wide).toContain("!! .env");
		expect(gitStatusMeta(wide ?? "")).toBeUndefined();
		expect(gitStatusMeta((await gitStatusOutput(cwd, gitStatusMetaArgs(false))) ?? "")).toEqual({ clean: true });
	});
});

describe("PR #8 review: a checkout's git config can make a git read run a program", () => {
	it("finds the program-valued keys a read runs, and nothing else", () => {
		for (const [text, key] of [
			["[core]\n\tfsmonitor = ./hook.sh\n", "core.fsmonitor"],
			["[core] fsmonitor = ./hook.sh\n", "core.fsmonitor"],
			['[diff "bin"]\n\ttextconv = ./conv\n', "diff.textconv"],
			["[diff]\n\texternal = ./ext\n", "diff.external"],
			['[filter "x"]\n\tclean = ./clean\n', "filter.clean"],
			["[pager]\n\tlog = ./page\n", "pager.log"],
			["[gpg]\n\tprogram = ./sign\n", "gpg.program"],
			["[core]\n\tpager = ./page\n", "core.pager"],
			["[include]\n\tpath = ../x.cfg\n", "include.path"],
		] as const) {
			expect(configRunsProgram(text).program, text).toBe(key);
		}
		for (const text of [
			"[core]\n\tfsmonitor = true\n\tbare = false\n",
			'[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n',
			"[pager]\n\tstatus = false\n",
			'[remote "origin"]\n\turl = https://example.com/x.git\n# [diff] external = ./x\n',
		]) {
			expect(configRunsProgram(text).program, text).toBeUndefined();
		}
		expect(configRunsProgram("[core]\n\thooksPath = .husky/_\n")).toEqual({ hooksPaths: [".husky/_"] });
	});

	posixOnly("escalates a git read in a checkout whose config or hooks run a program", () => {
		execFileSync("git", ["init", "-q"], { cwd });
		expect(verdict("git status")).toBe("safe");
		expect(verdict("git log --oneline")).toBe("safe");

		execFileSync("git", ["config", "core.fsmonitor", "./hook.sh"], { cwd });
		expect(verdict("git status")).toBe("escalate");
		expect(verdict("git diff")).toBe("escalate");
		execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd });

		execFileSync("git", ["config", "filter.x.clean", "./clean.sh"], { cwd });
		expect(verdict("git status")).toBe("escalate");
		execFileSync("git", ["config", "--remove-section", "filter.x"], { cwd });
		expect(verdict("git status")).toBe("safe");

		// husky's hooks path is fine until it holds the hook status runs.
		execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd });
		mkdirSync(join(cwd, ".husky", "_"), { recursive: true });
		writeFileSync(join(cwd, ".husky", "_", "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
		expect(verdict("git status")).toBe("safe");
		writeFileSync(join(cwd, ".husky", "_", "post-index-change"), "#!/bin/sh\n", { mode: 0o755 });
		expect(verdict("git status")).toBe("escalate");
	});

	posixOnly("judges the checkout git runs in: after cd and -C, and a nested repository's own", () => {
		execFileSync("git", ["init", "-q"], { cwd });
		const nested = join(cwd, "vendor", "lib");
		mkdirSync(nested, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: nested });
		writeFileSync(join(nested, ".git", "hooks", "post-index-change"), "#!/bin/sh\n", { mode: 0o755 });
		expect(verdict("git status")).toBe("safe");
		expect(verdict("git -C vendor/lib status")).toBe("escalate");
		expect(verdict("git -C vendor -C lib status")).toBe("escalate");
		expect(verdict("cd vendor/lib && git status")).toBe("escalate");
	});

	posixOnly("reads every submodule's config: nested, and wherever a .gitmodules path's .git points", () => {
		execFileSync("git", ["init", "-q"], { cwd });
		const nested = join(cwd, ".git", "modules", "libs", "a", "modules", "b");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(nested, "config"), "[core]\n\tbare = false\n");
		expect(verdict("git status")).toBe("safe");
		writeFileSync(join(nested, "config"), "[core]\n\tfsmonitor = ./hook\n");
		expect(verdict("git status")).toBe("escalate");
		rmSync(join(cwd, ".git", "modules"), { recursive: true });

		// A submodule whose .git file points outside .git/modules.
		const elsewhere = join(root, "elsewhere.git");
		mkdirSync(elsewhere);
		writeFileSync(join(elsewhere, "config"), '[filter "x"]\n\tclean = ./clean\n');
		mkdirSync(join(cwd, "sub"));
		writeFileSync(join(cwd, "sub", ".git"), `gitdir: ${elsewhere}\n`);
		writeFileSync(join(cwd, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = https://example.com/sub.git\n');
		expect(verdict("git status")).toBe("escalate");
	});

	posixOnly("treats a config it cannot read as naming a program", () => {
		if (process.getuid?.() === 0) return; // root reads a mode-000 file
		execFileSync("git", ["init", "-q"], { cwd });
		const config = join(cwd, ".git", "config");
		chmodSync(config, 0o000);
		try {
			expect(verdict("git status")).toBe("escalate");
		} finally {
			chmodSync(config, 0o644);
		}
	});

	posixOnly("reads a ] first in a negated bracket set as a member", () => {
		writeFileSync(join(root, "outside.txt"), "secret");
		symlinkSync(join(root, "outside.txt"), join(cwd, "z"));
		// bash expands `[!]abc]` to `z`, a symlink out of the project.
		expect(verdict("cat [!]abc]")).toBe("escalate");
	});
});
