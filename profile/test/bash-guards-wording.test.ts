/**
 * One Code's words for the bash tool's guard blocks: each names what was
 * blocked and the alternative (a background run, the monitor tool, the
 * non-interactive form), and a sleep block forbids the chained-sleep
 * workaround.
 */
import { describe, expect, it } from "vitest";
import { bashGuardReason } from "../../extensions/bash/guards.ts";

const fg = (command: string) => bashGuardReason(command, { background: false });

describe("wait guard wording", () => {
	it("quotes the sleep and what it leads into", () => {
		expect(fg("sleep 25")).toContain("Blocked: standalone `sleep 25`");
		expect(fg("sleep 25 && tmux has-session -t cc2-net; tail -c 600 /tmp/out")).toContain(
			"`sleep 25` followed by: tmux has-session -t cc2-net; tail -c 600 /tmp/out",
		);
		expect(fg("sleep 30 && echo done")).toContain("followed by: echo done");
		expect(fg("sleep 1 && sleep 1 && sleep 1")).toContain("Blocked");
	});

	it("names the alternatives and the anti-workaround clause", () => {
		const reason = fg("sleep 30") ?? "";
		expect(reason).toContain("run_in_background: true");
		expect(reason).toContain("until <check>; do sleep 2; done");
		expect(reason).toContain("Do not chain shorter sleeps");
	});
});

describe("poll-loop, orphan and interactive guard wording", () => {
	it("names a polling loop and steers to the monitor tool", () => {
		expect(fg("while true; do sleep 2; done")).toContain("polling loop");
		expect(fg("while true; do sleep 2; done")).toContain("monitor");
	});

	it("steers a detached process to a background run", () => {
		expect(fg("nohup ./server --port 8080")).toContain("run_in_background: true");
		expect(fg("./server --port 8080 &")).toContain("run_in_background: true");
	});

	it("explains interactive editors, watch and interactive git", () => {
		expect(fg("vim notes.txt")).toContain("no TTY");
		expect(fg("vim notes.txt <<EOF\nx\nEOF")).toMatch(/interactive editor/);
		expect(fg("watch -n 5 kubectl get pods")).toContain("monitor");
		expect(fg("git rebase -i HEAD~3")).toContain("GIT_SEQUENCE_EDITOR");
		expect(fg("git add -p")).toContain("stage nothing");
	});

	it("tells the model monitor is deferred and how to load it", () => {
		expect(fg("sleep 30")).toContain("tool_search select:monitor");
		expect(fg("while true; do sleep 5; done")).toContain("tool_search select:monitor");
	});
});
