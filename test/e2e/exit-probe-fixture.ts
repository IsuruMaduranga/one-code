/**
 * Offline model for the exit probe (exit-probe.mjs): the golden replay's
 * scripted model (golden-fixture.ts installScriptedModel) with the probe's own
 * script, plus a `/probe-crash` command that throws outside every handler.
 *
 * A user message saying PROBE_TOOLS starts every long-lived kind of process
 * One Code runs, each a stand-in from exit-probe-proc.mjs or a stub server
 * whose command line carries `EXIT_PROBE_TAG`:
 *
 *   round 1  load the monitor tool; write a Go file (the language server
 *            starts); a background bash whose program forks a worker and
 *            exits (bg-daemon), and one whose worker ignores SIGTERM
 *            (bg-noterm); a background bash still running at the end
 *            (bg-running); a subagent whose own background bash leaves a
 *            worker (sub-daemon)
 *   round 2  a monitor with the longest deadline, 30 minutes (monitor)
 *
 * PROBE_PRINT (a one-shot run) drops the monitor, and the still-running
 * background bash unless PROBE_BLOCK asks for it (a one-shot run blocks on it:
 * that run is ended by a signal mid-turn). The MCP server and the
 * SessionStart hook's worker start from the settings exit-probe.mjs writes.
 * `EXIT_PROBE_HOLD_SIGINT=1` adds a SIGINT listener that does nothing, as
 * any library's listener would: pi then survives a SIGINT.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { installScriptedModel, type ToolCall } from "./golden-fixture.ts";

/** A path for a bash command line on every platform (Git Bash reads forward slashes). */
const shellPath = (path: string) => `"${path.replace(/\\/g, "/")}"`;

function procCommand(mode: "sleep" | "fork" | "fork-noterm", role: string): string {
	const tag = process.env.EXIT_PROBE_TAG;
	const proc = process.env.EXIT_PROBE_PROC;
	if (!tag || !proc) throw new Error("exit-probe-fixture: set EXIT_PROBE_TAG and EXIT_PROBE_PROC");
	return `${shellPath(process.execPath)} ${shellPath(proc)} ${mode} ${tag}:${role}`;
}

const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_probe_${id}`, name, input });
const background = (id: string, command: string, extra: Record<string, unknown> = {}) =>
	call(id, "bash", { command, run_in_background: true, description: `probe ${id}`, ...extra });

function roundsFor(text: string): ToolCall[][] {
	if (text.includes("PROBE_CHILD")) return [[background("sub_daemon", procCommand("fork", "sub-daemon"))]];
	const print = text.includes("PROBE_PRINT");
	const first: ToolCall[] = [
		call("write", "write", { path: "main.go", content: "package main\n\nfunc main() {\n\tprobe\n}\n" }),
		background("bg_daemon", procCommand("fork", "bg-daemon")),
		background("bg_noterm", procCommand("fork-noterm", "bg-noterm")),
		call("agent", "Agent", { description: "Probe child", task: "PROBE_TOOLS PROBE_CHILD: make the scripted calls.", subagent_type: "general-purpose" }),
	];
	// A one-shot run holds the turn on it, so only the run that is ended mid-turn starts it.
	if (!print || text.includes("PROBE_BLOCK")) first.push(background("bg_running", procCommand("sleep", "bg-running"), { timeout: 600_000 }));
	if (print) return [first];
	return [
		[call("load", "tool_search", { query: "select:monitor" }), ...first],
		[call("monitor", "monitor", { command: procCommand("sleep", "monitor"), description: "probe monitor", timeout_ms: 1_800_000 })],
		// A foreground command that holds the turn until the probe presses ctrl+b (PROBE_FG, interactive runs).
		...(text.includes("PROBE_FG") ? [[call("fg_detached", "bash", { command: procCommand("sleep", "fg-detached"), description: "probe fg", timeout: 600_000 })]] : []),
	];
}

export default function exitProbeFixture(pi: ExtensionAPI) {
	if (process.env.EXIT_PROBE_HOLD_SIGINT) process.on("SIGINT", () => {});
	installScriptedModel({
		marker: "PROBE_TOOLS",
		roundsFor,
		// A background bash that finishes at once is steered in mid-script; the script reads past it.
		ignore: (message) => message.role === "user" && JSON.stringify(message.content).includes("<task-notification>"),
	});
	// The probe waits for this file: proof that the key sent the foreground command to the background.
	pi.on("tool_result", (event) => {
		const file = process.env.EXIT_PROBE_DETACHED;
		if (file && JSON.stringify(event.content).includes("manually backgrounded")) writeFileSync(file, "");
	});
	pi.registerCommand("probe-crash", {
		description: "Throw outside every handler (the exit probe's crash ending)",
		handler: async () => {
			setTimeout(() => {
				throw new Error("exit-probe: deliberate crash");
			}, 0);
		},
	});
}
