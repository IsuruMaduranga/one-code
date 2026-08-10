import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeShellCommand, hasUnmodelledSyntax, parseCommand } from "../../extensions/auto-mode/shell-analysis.ts";

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
