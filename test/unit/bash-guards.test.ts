import { describe, expect, it } from "vitest";
import { parseCommand } from "../../extensions/auto-mode/shell-analysis.ts";
import { bashGuardReason } from "../../extensions/bash/guards.ts";
import type { ShellBlock } from "../../extensions/lib/shell-text.ts";
import { requireText } from "../../extensions/lib/profile.ts";

/**
 * Which shell calls the guards block, and what they tell the profile about
 * each block. The words themselves are the profile's (One Code's:
 * profile/test/bash-guards-wording.test.ts).
 */
const blocked = (block: ShellBlock) => requireText("shell").blocked(block);
/** The bash tool's sleep command and until-loop, as it passes them. */
const sleepBlock = (shown: string, rest?: string): ShellBlock => ({ kind: "sleep", shown, ...(rest ? { rest } : {}), sleepName: "sleep", untilExample: "until <check>; do sleep 2; done" });

const fg = (command: string) => bashGuardReason(command, { background: false });
const bg = (command: string) => bashGuardReason(command, { background: true });

describe("wait guard", () => {
	it("blocks a leading sleep of 2s or more", () => {
		expect(fg("sleep 25")).toBe(blocked(sleepBlock("sleep 25")));
		expect(fg("sleep 2")).toBeDefined();
		expect(fg("sleep 5m")).toBeDefined();
	});

	it("echoes the chained commands the sleep leads into", () => {
		const reason = fg("sleep 25 && tmux has-session -t cc2-net; tail -c 600 /tmp/out") ?? "";
		expect(reason).toBe(blocked(sleepBlock("sleep 25", "tmux has-session -t cc2-net; tail -c 600 /tmp/out")));
	});

	it("does not leak the split operator into the echo", () => {
		expect(fg("sleep 30 && echo done")).toBe(blocked(sleepBlock("sleep 30", "echo done")));
	});

	it("lets a provably short sleep through as pacing", () => {
		expect(fg("sleep 0.5")).toBeUndefined();
		expect(fg("sleep .5")).toBeUndefined();
		expect(fg("sleep 1")).toBeUndefined();
		expect(fg("sleep 1 && curl localhost/health")).toBeUndefined();
	});

	it("blocks a chain of short sleeps and summed multi-arg sleeps", () => {
		expect(fg("sleep 1 && sleep 1 && sleep 1")).toBe(blocked(sleepBlock("sleep 1 && sleep 1 && sleep 1")));
		expect(fg("sleep 1 600")).toBeDefined();
	});

	it("blocks a sleep whose duration cannot be verified", () => {
		expect(fg('sleep "$DELAY"')).toBeDefined();
	});

	it("leaves a sleep inside a larger command alone", () => {
		expect(fg("npm run build && sleep 300 && npm run smoke")).toBeUndefined();
	});

	it("does not block commands that merely mention sleep", () => {
		expect(fg("grep sleep app.log")).toBeUndefined();
		expect(fg("./sleepy-server --start")).toBeUndefined();
	});

	it("sees through wrappers and subshell parens", () => {
		expect(fg("env sleep 30")).toBeDefined();
		expect(fg("(sleep 30)")).toBeDefined();
	});

	it("never fires on a background run", () => {
		expect(bg("sleep 600")).toBeUndefined();
	});

	it("lets an unparseable command through", () => {
		expect(fg('sleep "unterminated')).toBeUndefined();
	});
});

describe("poll-loop guard", () => {
	it("blocks foreground while/until/for loops that sleep", () => {
		expect(fg("while true; do sleep 2; done")).toBe(blocked({ kind: "pollingLoop", command: "while true; do sleep 2; done" }));
		// Wherever the loop sits in the line (PR #12 review).
		expect(fg("echo start; while true; do sleep 5; done")).toBe(blocked({ kind: "pollingLoop", command: "echo start; while true; do sleep 5; done" }));
		expect(fg("until curl -sf localhost/health; do sleep 2; done")).toBeDefined();
		expect(fg("for i in 1 2 3; do check; sleep 5; done")).toBeDefined();
	});

	it("leaves loops without a sleep alone", () => {
		expect(fg("for f in *.ts; do wc -l $f; done")).toBeUndefined();
		expect(fg("while read line; do echo $line; done < input.txt")).toBeUndefined();
	});

	it("does not treat sleep as data", () => {
		expect(fg("while true; do echo sleep; done")).toBeUndefined();
	});

	it("never fires on a background run", () => {
		expect(bg("while true; do sleep 2; done")).toBeUndefined();
	});
});

describe("orphan guard", () => {
	it("blocks nohup and setsid", () => {
		expect(fg("nohup ./server --port 8080")).toBe(blocked({ kind: "detach", via: "`nohup`" }));
		expect(fg("cd app && nohup npm start")).toBeDefined();
		expect(fg("setsid ./daemon")).toBeDefined();
	});

	it("blocks a top-level trailing &", () => {
		expect(fg("./server --port 8080 &")).toBe(blocked({ kind: "detach", via: "`&`" }));
		expect(fg("python -m http.server & echo started")).toBeDefined();
	});

	it("does not confuse redirection and logical operators with &", () => {
		expect(fg("make test 2>&1")).toBeUndefined();
		expect(fg("cmd &> out.log")).toBeUndefined();
		expect(fg("a && b")).toBeUndefined();
		expect(fg("git log |& head")).toBeUndefined();
	});

	it("allows parallel children reaped by wait", () => {
		expect(fg("job1 & job2 & wait")).toBeUndefined();
	});

	it("only exempts a wait that comes last", () => {
		expect(fg("wait; ./server --port 8080 &")).toBeDefined();
	});

	it("ignores & inside quotes and heredocs", () => {
		expect(fg("echo 'a & b'")).toBeUndefined();
		expect(fg('grep "&" file.xml')).toBeUndefined();
		expect(fg("cat <<EOF > s.sh\n./run &\nEOF")).toBeUndefined();
	});

	it("tracks ANSI-C quoting when scanning for &", () => {
		expect(fg("echo $'a & b' & sleep 999")).toBeDefined();
		expect(fg("echo $'a & b'")).toBeUndefined();
		// A backslash-escaped quote inside $'…' does not end the string.
		expect(fg("echo $'it\\'s fine' & sleep 999")).toBeDefined();
		expect(fg("echo $'it\\'s & fine'")).toBeUndefined();
	});

	it("never fires on a background run", () => {
		expect(bg("nohup ./server")).toBeUndefined();
		expect(bg("./server &")).toBeUndefined();
	});
});

describe("parseCommand background", () => {
	it("detects only the shell background operator", () => {
		const background = (command: string) => parseCommand(command).background;
		expect(background("cmd &")).toBe(true);
		expect(background("a & b")).toBe(true);
		expect(background("(a &) ; b")).toBe(true);
		expect(background("a && b")).toBe(false);
		expect(background("make 2>&1")).toBe(false);
		expect(background("cmd &>log")).toBe(false);
		expect(background("a |& b")).toBe(false);
		expect(background("echo 'a & b'")).toBe(false);
	});
});

describe("interactive guard", () => {
	it("blocks interactive editors, foreground and background", () => {
		expect(fg("vim notes.txt")).toBe(blocked({ kind: "editor", command: "vim" }));
		expect(fg("git log | vi -")).toBeDefined();
		expect(bg("nvim config.lua")).toBeDefined();
		expect(fg("(vim)")).toBeDefined();
		expect(fg("(git add -p)")).toBeDefined();
	});

	it("does not misfire on heredoc body text", () => {
		expect(fg("cat <<EOF > notes.txt\nwhile true; do sleep 2; done\nEOF")).toBeUndefined();
		expect(fg("cat <<EOF > notes.txt\nvim is my editor\nEOF")).toBeUndefined();
	});

	it("allows batch emacs", () => {
		expect(fg("emacs --batch -l script.el")).toBeUndefined();
	});

	it("blocks watch", () => {
		expect(fg("watch -n 5 kubectl get pods")).toBe(blocked({ kind: "watch" }));
	});

	it("blocks interactive git forms", () => {
		expect(fg("git rebase -i HEAD~3")).toBe(blocked({ kind: "rebaseInteractive", shell: "bash" }));
		expect(fg("git rebase --interactive main")).toBeDefined();
		expect(fg("git add -p")).toBe(blocked({ kind: "addInteractive" }));
		expect(fg("git add -i")).toBeDefined();
		expect(fg("git -C sub add --patch file.ts")).toBeDefined();
	});

	it("does not confuse flags that only look interactive", () => {
		expect(fg("git log -p")).toBeUndefined();
		expect(fg("git rebase --continue")).toBeUndefined();
		expect(fg("git add -A")).toBeUndefined();
		expect(fg("grep -i pattern file")).toBeUndefined();
	});
});

describe("heredoc handling (T14)", () => {
	it("judges the command before a heredoc/here-string and ignores the body", () => {
		expect(bashGuardReason('sleep 600 <<< ""', { background: false })).toBe(blocked(sleepBlock('sleep 600 <<< ""')));
		expect(bashGuardReason("vim notes.txt <<EOF\nx\nEOF", { background: false })).toBe(blocked({ kind: "editor", command: "vim" }));
		expect(bashGuardReason("cat <<EOF\nsleep 600\nvim x\nEOF", { background: false })).toBeUndefined();
		expect(bashGuardReason("<<EOF\nsleep 5\nEOF", { background: false })).toBeUndefined();
	});
});

