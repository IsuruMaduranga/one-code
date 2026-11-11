/**
 * One Code's shell wording (profile/text/shell/) where the golden snapshot cannot
 * reach it: the sleep and polling-loop blocks (the permission gate stops
 * those calls first in a one-shot run), PowerShell's blocks, a background
 * start, a run ended by a signal or a timeout, and the marker for output cut
 * to its tail. The golden snapshot pins the other bash blocks and both
 * one-shot background results.
 */
import { describe, expect, it } from "vitest";
import { shellResultText } from "../../extensions/lib/shell-run/shell-text.ts";


describe("One Code's shell text", () => {
	it("words a standalone sleep and one with work after it", () => {
		const block = { kind: "sleep" as const, shown: "sleep 5", sleepName: "sleep", untilExample: "until <check>; do sleep 2; done" };
		expect(shellResultText().blocked(block)).toMatch(/^Blocked: standalone `sleep 5`\. A foreground sleep stalls the whole session/);
		expect(shellResultText().blocked({ ...block, rest: "echo done" })).toMatch(/^Blocked: `sleep 5` followed by: echo done\./);
		expect(shellResultText().blocked({ kind: "pollingLoop", command: "while true; do sleep 1; done" })).toContain("Blocked: a foreground polling loop (`while true; do sleep 1; done`).");
	});

	it("gives PowerShell its own rebase recipe and console-prompt block", () => {
		expect(shellResultText().blocked({ kind: "rebaseInteractive", shell: "powershell" })).toContain("`$env:GIT_SEQUENCE_EDITOR = ':'; git rebase …`");
		expect(shellResultText().blocked({ kind: "consolePrompt", command: "read-host" })).toMatch(/^Blocked: `read-host` waits on a console or GUI prompt/);
	});

	it("says a background run's completion arrives on its own", () => {
		expect(shellResultText().backgroundStarted({ label: "Bash", id: "b1234567", description: "build", logPath: "/l/out.log" })).toBe(
			"⏳ Bash task b1234567 running in background (build).\n\nCompletion will arrive as a task notification on its own naming the output file — you do not need to wait for it or poll; keep working. To check interim output, read /l/out.log. If your next step cannot proceed without the result, task_output with block=true waits for it. Stop with task_stop.",
		);
	});

	it("words how a run ended", () => {
		expect(shellResultText().finish({ kind: "exitCode", code: 2 })).toBe("failed (exit code 2)");
		expect(shellResultText().finish({ kind: "signal", signal: "SIGKILL" })).toBe("failed (terminated by SIGKILL)");
		expect(shellResultText().failureDetail({ kind: "completed" })).toBeUndefined();
		expect(shellResultText().exitCode({ code: 3, output: "" })).toBe("Exit code 3");
	});

	it("says a timed-out background run failed, naming the timeout", () => {
		const text = shellResultText().ranToEnd({
			label: "Bash",
			id: "b1",
			description: "sleep",
			end: { kind: "timedOut", seconds: 0.2 },
			note: "",
			logPath: "/tmp/out.log",
			output: "",
		} as never);
		expect(text).toContain("failed (timed out after 0.2s)");
	});

	it("says a background shell's earlier output was truncated when its output is cut to the tail", () => {
		expect(shellResultText().earlierTruncated).toContain("earlier output truncated");
	});
});
