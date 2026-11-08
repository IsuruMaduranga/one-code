/**
 * One Code's shell wording (profile/text/shell/) where the golden snapshot cannot
 * reach it: the sleep and polling-loop blocks (the permission gate stops
 * those calls first in a one-shot run), PowerShell's blocks, a background
 * start, a run ended by a signal or a timeout, and the marker for output cut
 * to its tail. The golden snapshot pins the other bash blocks and both
 * one-shot background results.
 */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";
import { shellText } from "../text/shell/index.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";

const shell = shellText(ALL_LIVE);

describe("One Code's shell text", () => {
	it("words a standalone sleep and one with work after it", () => {
		const block = { kind: "sleep" as const, shown: "sleep 5", sleepName: "sleep", untilExample: "until <check>; do sleep 2; done" };
		expect(shell.blocked(block)).toMatch(/^Blocked: standalone `sleep 5`\. A foreground sleep stalls the whole session/);
		expect(shell.blocked({ ...block, rest: "echo done" })).toMatch(/^Blocked: `sleep 5` followed by: echo done\./);
		expect(shell.blocked({ kind: "pollingLoop", command: "while true; do sleep 1; done" })).toContain("Blocked: a foreground polling loop (`while true; do sleep 1; done`).");
	});

	it("gives PowerShell its own rebase recipe and console-prompt block", () => {
		expect(shell.blocked({ kind: "rebaseInteractive", shell: "powershell" })).toContain("`$env:GIT_SEQUENCE_EDITOR = ':'; git rebase …`");
		expect(shell.blocked({ kind: "consolePrompt", command: "read-host" })).toMatch(/^Blocked: `read-host` waits on a console or GUI prompt/);
	});

	it("says a background run's completion arrives on its own", () => {
		expect(shell.backgroundStarted({ label: "Bash", id: "b1234567", description: "build", logPath: "/l/out.log" })).toBe(
			"⏳ Bash task b1234567 running in background (build).\n\nCompletion will arrive as a task notification on its own naming the output file — you do not need to wait for it or poll; keep working. To check interim output, read /l/out.log. If your next step cannot proceed without the result, task_output with block=true waits for it. Stop with task_stop.",
		);
	});

	it("words how a run ended", () => {
		expect(shell.finish({ kind: "exitCode", code: 2 })).toBe("failed (exit code 2)");
		expect(shell.finish({ kind: "signal", signal: "SIGKILL" })).toBe("failed (terminated by SIGKILL)");
		expect(shell.failureDetail({ kind: "completed" })).toBeUndefined();
		expect(shell.exitCode({ code: 3, output: "" })).toBe("Exit code 3");
	});

	it("says a timed-out background run failed, naming the timeout", () => {
		const text = requireText("shell").ranToEnd({
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
		expect(requireText("shell").earlierTruncated).toContain("earlier output truncated");
	});
});
