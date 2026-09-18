import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeShellCommand, hasUnmodelledSyntax, parseCommand } from "../../extensions/auto-mode/shell-analysis.ts";
import { forwardSlashes as sh } from "../../extensions/lib/paths.ts";

let cwd: string;
let home: string;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "cc-auto-"));
	cwd = join(root, "project");
	home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(join(cwd, ".."), { recursive: true, force: true });
});

const analyze = (command: string) => analyzeShellCommand({ command, cwd, home });

describe("parseCommand", () => {
	it("splits on unspaced metacharacters (review finding N4)", () => {
		// `cmd>file` and `a|b` hid the real command/target from the original tokenizer.
		const { segments } = parseCommand("echo hi>out.txt");
		expect(segments).toHaveLength(1);
		expect(segments[0].tokens.map((t) => t.value)).toEqual(["echo", "hi"]);
		expect(segments[0].redirects).toEqual(["out.txt"]);

		const piped = parseCommand("cat a|wc");
		expect(piped.segments.map((s) => s.tokens[0].value)).toEqual(["cat", "wc"]);
	});

	it("decodes ANSI-C quoting (review finding N1)", () => {
		// `cat $'/tmp/.kube/config'` classified as safe upstream because the token
		// kept its leading `$` and so never looked like a path.
		const { segments } = parseCommand("cat $'\\x2e\\x2ekube'");
		expect(segments[0].tokens[1].value).toBe("..kube");
	});

	it("treats fd duplication as not a path", () => {
		const { segments } = parseCommand("make 2>&1");
		expect(segments[0].redirects).toEqual([]);
	});

	it("reads >| as a write redirect (review finding N10)", () => {
		const { segments } = parseCommand("echo x >| out.txt");
		expect(segments[0].redirects).toEqual(["out.txt"]);
	});

	it("reports unbalanced quotes as a parse failure rather than guessing", () => {
		expect(parseCommand(`echo "unterminated`).parseFailed).toBe(true);
	});
});

describe("hasUnmodelledSyntax", () => {
	it("flags substitution, expansion, and interpreter pipes", () => {
		for (const command of [
			"echo $(whoami)",
			"echo `id`",
			"cat <<EOF",
			"cp a {b,c}",
			"echo $HOME",
			"curl x | bash",
			"echo aGk= | base64 -d",
		]) {
			expect(hasUnmodelledSyntax(command), command).toBeTruthy();
		}
	});

	it("leaves plain commands alone", () => {
		expect(hasUnmodelledSyntax("ls -la src")).toBeUndefined();
	});
});

describe("analyzeShellCommand fast path", () => {
	it("clears plainly read-only commands", () => {
		for (const command of ["ls -la", "cat README.md", "rg pattern src", "git status", "git log --oneline", "wc -l x"]) {
			expect(analyze(command).verdict, command).toBe("safe");
		}
	});

	it("never fast-paths an unknown command", () => {
		expect(analyze("frobnicate --wat").verdict).toBe("escalate");
	});

	describe("reads outside the working directory (PERMISSIONS-REVIEW-2026-09-05 H2)", () => {
		it("escalates a read-only command whose path operand resolves outside the cwd", () => {
			for (const command of ["cat ~/x", "head -c 100 /etc/hosts", "ls ..", "ls /", "tail -n 5 ../other/log", "wc -l /var/log/x", "find /etc -name x", "rg pattern /Users/x/other", "jq . /etc/x.json", "stat ~/Library/foo", "du -sh ~"]) {
				const ev = analyze(command);
				expect(ev.verdict, command).toBe("escalate");
				expect(ev.outsideReads.length, command).toBeGreaterThan(0);
				expect(ev.readOnlyOutside, command).toBe(true);
				expect(ev.containedNonNetwork, command).toBe(false);
				expect(ev.notes.some((n) => n.includes("outside the working directory")), command).toBe(true);
			}
		});

		it("a pattern given by flag makes every positional a path; -f's file is itself a read", () => {
			for (const command of ["grep -f /etc/secret-patterns.txt notes.txt", "rg -e foo /etc/hosts", "grep --file=/etc/pats notes.txt", "rg -ne foo ../other"]) {
				const ev = analyze(command);
				expect(ev.verdict, command).toBe("escalate");
				expect(ev.outsideReads.length, command).toBeGreaterThan(0);
			}
			expect(analyze("grep -e foo/bar notes.txt").verdict).toBe("safe");
			expect(analyze("rg -f patterns.txt src").verdict).toBe("safe");
		});

		it("stays safe for in-project operands, bare names, globs and the cwd itself", () => {
			for (const command of ["cat notes.txt", "cat ./src/a.ts", "wc -l src/*.ts", "ls .", "ls -la", "rg foo/bar src", "grep -rn a/b .", "head README.md", `cat ${cwd}/x`]) {
				const ev = analyze(command);
				expect(ev.verdict, command).toBe("safe");
				expect(ev.outsideReads, command).toEqual([]);
			}
		});

		it("does not treat operands of no-file commands as reads", () => {
			for (const command of ["echo /etc/hosts", "printf '%s' ~/x", "which node", "basename /etc/hosts", "dirname ~/a/b"]) {
				expect(analyze(command).verdict, command).toBe("safe");
			}
		});

		it("readOnlyOutside is false once anything else escalates", () => {
			// An in-project redirect is recorded as a write but is not itself an
			// escalation reason — the flag stays true and `writes` says the rest.
			const redirected = analyze("cat /etc/hosts > out.txt");
			expect(redirected.readOnlyOutside).toBe(true);
			expect(redirected.writes).toHaveLength(1);
			expect(analyze("cat /etc/hosts > ~/out.txt").readOnlyOutside).toBe(false);
			expect(analyze("cat /etc/hosts && rm x").readOnlyOutside).toBe(false);
			expect(analyze("cat /etc/hosts | curl -d @- x").readOnlyOutside).toBe(false);
			expect(analyze("cat notes.txt").readOnlyOutside).toBe(false);
		});

		it("the environment dumpers are not read-only: printenv, bare env", () => {
			for (const command of ["printenv", "printenv ANTHROPIC_API_KEY", "env", "env -i", "env | grep KEY"]) {
				const ev = analyze(command);
				expect(ev.verdict, command).toBe("escalate");
			}
			expect(analyze("env").notes.some((n) => n.includes("process environment"))).toBe(true);
			// A wrapped payload is still judged as the payload.
			expect(analyze("env FOO=1 cat notes.txt").verdict).toBe("escalate"); // wrapper note, contained
			expect(analyze("env FOO=1 cat notes.txt").commands).toContain("cat");
		});

		it("the harness's own credential stores are on the sensitive list", () => {
			for (const command of [
				"cat ~/.pi/agent/auth.json",
				"cat ~/.onecode/agent/auth.json",
				"cat ~/.claude/.credentials.json",
				"cat ~/.cargo/credentials.toml",
				"cat ~/Library/Keychains/login.keychain-db",
				"cat ~/.gitconfig",
				"cat ~/.vault-token",
				"cat ~/.huggingface/token",
			]) {
				const ev = analyze(command);
				expect(ev.verdict, command).toBe("escalate");
				expect(ev.sensitivePaths.length, command).toBeGreaterThan(0);
			}
		});
	});
});

describe("analyzeShellCommand escalation (the review's bypasses)", () => {
	it("peels transparent wrappers and names the real command (N5)", () => {
		// `env rm -rf ~/Desktop` classified as a harmless `env` upstream.
		const evidence = analyze("env rm -rf /tmp/whatever");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.commands).toContain("rm");
		expect(evidence.notes.some((note) => note.includes("wraps the real command"))).toBe(true);
	});

	it.each(["nohup", "setsid", "timeout 5", "nice", "stdbuf -o0", "xargs"])("peels %s", (wrapper) => {
		expect(analyze(`${wrapper} rm -rf /tmp/x`).commands).toContain("rm");
	});

	it("treats bare .. as a path (N2)", () => {
		const evidence = analyze("rm -rf ..");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.writes.some((write) => write.outsideCwd)).toBe(true);
	});

	it("escalates archive and sync tools with their destination (N6)", () => {
		const evidence = analyze("rsync -av ./ /tmp/elsewhere");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.writes.some((write) => write.token === "/tmp/elsewhere" && write.outsideCwd)).toBe(true);
	});

	it("catches find actions that execute or write (N7)", () => {
		for (const action of ["-delete", "-exec rm {} ;", "-ok rm {} ;", "-fprintf out %p"]) {
			expect(analyze(`find . -name x ${action}`).verdict, action).toBe("escalate");
		}
	});

	it("escalates script interpreters, whose programs it cannot read (N8)", () => {
		expect(analyze("awk 'BEGIN{print > \"/tmp/x\"}'").verdict).toBe("escalate");
		expect(analyze("sed -i s/a/b/ file").verdict).toBe("escalate");
	});

	it("defaults git to deny by subcommand (N11)", () => {
		// The upstream list enumerated mutating subcommands and allowed the rest,
		// so git rm / mv / archive / config all passed unchecked.
		for (const subcommand of ["rm secret.yaml", "mv a b", "archive HEAD", "config user.name x", "update-ref HEAD x"]) {
			expect(analyze(`git ${subcommand}`).verdict, subcommand).toBe("escalate");
		}
	});

	it("escalates git -c, which can turn a read into code execution (F1)", () => {
		const evidence = analyze("git -c protocol.ext.allow=always clone ext::sh x");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.notes.some((note) => note.includes("code execution"))).toBe(true);
	});

	it("finds credential paths named by any token, sliced or not (N12, N13)", () => {
		for (const command of ["cat ~/.aws/credentials", "cat ~/.m2/settings.xml", "cd .kube", "cat /proc/self/environ"]) {
			const evidence = analyze(command);
			expect(evidence.verdict, command).toBe("escalate");
			expect(evidence.sensitivePaths.length, command).toBeGreaterThan(0);
		}
	});

	it("tracks cd, so later relative paths are not read against the original cwd (F6)", () => {
		const evidence = analyze("cd /tmp && cat x");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.notes.some((note) => note.includes("changes directory"))).toBe(true);
	});

	it("reports the original token, never an expanded value (N18)", () => {
		// The upstream PowerShell path echoed expanded $env: values into its block
		// message, leaking the secret the block existed to protect.
		const evidence = analyze("cat $SECRET_PATH/.ssh/id_rsa");
		expect(evidence.notes.join(" ")).not.toContain(home);
		expect(evidence.verdict).toBe("escalate");
	});

	it("flags in-project paths whose contents execute later (N20)", () => {
		const evidence = analyze("echo x > .git/hooks/pre-commit");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.executionPrimitives.length).toBeGreaterThan(0);
	});

	it("resolves a dangling symlink leaf instead of trusting its literal path (N9)", () => {
		// Turn 1 creates an in-project link to somewhere outside; turn 2 writes
		// through it. Upstream resolved the write to <project>/link and allowed it.
		const outside = join(cwd, "..", "outside-target");
		writeFileSync(outside, "");
		symlinkSync(outside, join(cwd, "link"));
		const evidence = analyze("echo pwned > link");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.writes[0].outsideCwd).toBe(true);
	});

	it("escalates a write it cannot resolve rather than assuming containment", () => {
		const evidence = analyze("echo x > /nonexistent-root-dir/deep/file");
		expect(evidence.verdict).toBe("escalate");
	});

	it("notes network-capable commands", () => {
		const evidence = analyze("curl https://example.com");
		expect(evidence.network).toContain("curl");
		expect(evidence.verdict).toBe("escalate");
	});

	it("allows a contained in-project write to be judged with its resolved target", () => {
		const evidence = analyze("echo hi > notes.txt");
		expect(evidence.writes).toHaveLength(1);
		expect(evidence.writes[0].outsideCwd).toBe(false);
	});

	it("ignores /dev/null as a write target", () => {
		expect(analyze("ls > /dev/null").writes).toHaveLength(0);
	});

	it("escalates every segment of a compound command, not just the first (N14)", () => {
		// The PowerShell analogue short-circuited its catch-all once any segment
		// looked like a benign tmp write, letting a later segment launch anything.
		const evidence = analyze("touch /tmp/x; frobnicate --launch");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.commands).toContain("frobnicate");
	});
});

describe("analyzeShellCommand write-target gaps (whole-codebase review)", () => {
	it("escalates a bare redirect with no command word", () => {
		// `> /etc/hosts` truncates the file with no command at all; the loop used to
		// `continue` past the redirect check whenever there was no command name.
		for (const command of ["> /etc/hosts", "> ../outside.txt"]) {
			expect(analyze(command).verdict, command).toBe("escalate");
		}
	});

	it("checks a redirect target even for a read-only command", () => {
		// `git log > file` writes the file; git's read-only fast path used to
		// `continue` before the redirect was ever inspected.
		expect(analyze("git log > ../escapes.txt").verdict).toBe("escalate");
	});

	it("validates the target of git -C, not just the subcommand", () => {
		const evidence = analyze("git -C /etc status");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.notes.some((note) => note.includes("outside the working directory"))).toBe(true);
	});

	it("still fast-paths git -C into an in-project subdirectory", () => {
		mkdirSync(join(cwd, "pkg"), { recursive: true });
		expect(analyze("git -C pkg status").verdict).toBe("safe");
	});

	it("escalates sort -o, which writes despite being read-only", () => {
		for (const command of ["sort -o /tmp/x input.txt", "sort --output=/tmp/x input.txt", "sort -o/tmp/x input.txt"]) {
			expect(analyze(command).verdict, command).toBe("escalate");
		}
	});

	it("still fast-paths plain sort", () => {
		expect(analyze("sort input.txt").verdict).toBe("safe");
	});
});

describe("containment signal for the recoverability gate (Phase 2)", () => {
	it("marks an in-project rm of a bare-name file as contained, capturing the target", () => {
		const ev = analyze("rm notes.txt");
		expect(ev.verdict).toBe("escalate");
		expect(ev.containedNonNetwork).toBe(true);
		expect(ev.wholeTree).toBe(false);
		expect(ev.writes.some((w) => w.token === "notes.txt" && !w.outsideCwd)).toBe(true);
	});

	it("marks git reset --hard as a contained whole-tree op", () => {
		const ev = analyze("git reset --hard HEAD");
		expect(ev.verdict).toBe("escalate");
		expect(ev.containedNonNetwork).toBe(true);
		expect(ev.wholeTree).toBe(true);
	});

	it("does NOT mark an rm outside the project as contained", () => {
		const ev = analyze("rm ~/secret.txt");
		expect(ev.containedNonNetwork).toBe(false);
	});

	it("does NOT mark a glob rm as contained (cannot enumerate targets)", () => {
		const ev = analyze("rm build/*.log");
		expect(ev.containedNonNetwork).toBe(false);
	});

	it("does NOT mark rm piped from xargs as contained (targets from stdin)", () => {
		const ev = analyze("find . -name '*.tmp' | xargs rm");
		expect(ev.containedNonNetwork).toBe(false);
	});

	it("does NOT mark a non-delete mutation (cp) as contained", () => {
		const ev = analyze("cp a.txt b.txt");
		expect(ev.verdict).toBe("escalate");
		expect(ev.containedNonNetwork).toBe(false);
	});

	it("does NOT mark rm as contained when the command also reaches the network", () => {
		const ev = analyze("curl http://x/ && rm notes.txt");
		expect(ev.containedNonNetwork).toBe(false);
	});

	it("does NOT mark rm of a credential path as contained", () => {
		const ev = analyze("rm .env");
		expect(ev.containedNonNetwork).toBe(false);
	});

	it("leaves containedNonNetwork false for a provably-safe (non-escalating) command", () => {
		const ev = analyze("cat notes.txt");
		expect(ev.verdict).toBe("safe");
		expect(ev.containedNonNetwork).toBe(false);
	});

	it("does not treat a reset --hard aimed at another tree as a contained whole-tree op", () => {
		for (const cmd of [
			"git --work-tree=/other --git-dir=/other/.git reset --hard",
			"git --work-tree /other reset --hard HEAD",
			"git -C /other reset --hard",
			"git -C pkg reset --hard",
		]) {
			const ev = analyze(cmd);
			expect(ev.verdict, cmd).toBe("escalate");
			expect(ev.wholeTree, cmd).toBe(false);
			expect(ev.containedNonNetwork, cmd).toBe(false);
		}
	});

	it("escalates git --git-dir=/x (the = spelling) pointing outside the working directory", () => {
		expect(analyze("git --git-dir=/etc status").verdict).toBe("escalate");
		expect(analyze("git --work-tree=/etc status").verdict).toBe("escalate");
	});

	it("escalates in-project writes to protected tooling/agent config paths (P3)", () => {
		for (const cmd of [
			"echo x > .cargo/config.toml",
			"echo x > .pre-commit-config.yaml",
			"echo x >> lefthook.yml",
			"echo x > .idea/workspace.xml",
			"echo x > .devcontainer/devcontainer.json",
			"echo x > .claude/agents/evil.md",
			"echo x > .claude/commands/deploy.md",
			"cp a.json .claude/settings.json",
			"rm .claude/settings.local.json",
			"echo x > .onecode/settings.json",
		]) {
			const ev = analyze(cmd);
			expect(ev.verdict, cmd).toBe("escalate");
			expect(ev.protectedPaths.length, cmd).toBeGreaterThan(0);
			expect(ev.containedNonNetwork, cmd).toBe(false);
		}
	});

	it("keeps in-project writes to the protected-dir exceptions on the fast path", () => {
		// .claude/worktrees is the agent's own working space, not configuration.
		const ev = analyze("echo x > .claude/worktrees/fix/notes.txt");
		expect(ev.protectedPaths).toEqual([]);
		expect(ev.verdict).toBe("safe");
	});

	it("still marks a bare git reset --hard (no ref) as whole-tree contained", () => {
		const ev = analyze("git reset --hard");
		expect(ev.containedNonNetwork).toBe(true);
		expect(ev.wholeTree).toBe(true);
	});

	// A delete target the classifier's fast path cannot enumerate must never be
	// treated as a concrete in-project literal — otherwise `rm -rf "$VAR"` would
	// resolve to a nonexistent `cwd/$VAR`, the recoverability check would find
	// nothing to lose, and it would auto-approve while $VAR expands to anything at
	// runtime. These must stay uncontained so the classifier judges them.
	it("does NOT mark rm of a dynamic/unenumerable target as contained", () => {
		for (const command of ['rm -rf "$VAR"', "rm -rf ${DIR:-fallback}", "rm -rf $HOME/x", "rm -rf {a,b}.txt"]) {
			const ev = analyze(command);
			expect(ev.containedNonNetwork, command).toBe(false);
		}
	});
});

describe("runtime protected dirs (PERMISSIONS-REVIEW-2026-09-05 M7)", () => {
	it("escalates a redirect into pi's agent dir when the caller passes it, and stays safe otherwise", () => {
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		// Spelled with forward slashes, as a path is inside a bash command line.
		const command = `echo evil > ${sh(agentDir)}/extensions/x.ts`;
		const plain = analyzeShellCommand({ command, cwd, home });
		expect(plain.protectedPaths).toEqual([]);
		const guarded = analyzeShellCommand({ command, cwd, home, protectedDirs: [agentDir] });
		expect(guarded.verdict).toBe("escalate");
		expect(guarded.protectedPaths).toHaveLength(1);
		expect(guarded.notes.join(" ")).toContain("protected tooling or agent configuration path");
		// A redirect elsewhere under ~/.pi is not covered by the dir.
		expect(analyzeShellCommand({ command: `echo x > ${sh(home)}/.pi/notes.txt`, cwd, home, protectedDirs: [agentDir] }).protectedPaths).toEqual([]);
	});
});
