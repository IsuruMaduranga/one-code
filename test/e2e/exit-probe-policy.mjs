/**
 * The exit probe's policy (test/e2e/exit-probe.mjs): which processes One Code
 * starts, how a run can end, and for each pair whether the process must be
 * gone afterwards. Pure, so test/unit/exit-probe-policy.test.ts checks it
 * without running pi.
 *
 * The table encodes the intended policy as the code and the decisions state
 * it (decisions/tools.md "Nothing outlives its session",
 * lib/shell-run/process-tree.ts); it does not set policy. A cell whose policy
 * is unclear is "open": allowed, and listed in the summary.
 */

/** The spawners the probe exercises, with the fixture that stands in for each. */
export const SPAWNERS = [
	{ id: "lsp", what: "language server behind a launcher that does not exec it" },
	{ id: "mcp", what: "stdio MCP server behind a launcher that does not exec it" },
	{ id: "hook", what: "worker a SessionStart hook leaves running" },
	{ id: "bg-daemon", what: "worker a finished background bash leaves" },
	{ id: "bg-noterm", what: "worker a finished background bash leaves, ignoring SIGTERM" },
	{ id: "bg-running", what: "background bash still running" },
	{ id: "monitor", what: "persistent monitor still running" },
	{ id: "sub-daemon", what: "worker a subagent's background bash leaves" },
];

/**
 * How a run ends. `alive`: pi keeps running after it, and only the processes
 * the old session started are judged. `posix`: needs signals or a pty.
 * `starts`: the spawners the run's script exercises.
 */
const ALL = SPAWNERS.map((s) => s.id);
const PRINT = ["lsp", "mcp", "hook", "bg-daemon", "bg-noterm", "sub-daemon"];
export const ENDINGS = [
	{ id: "print-done", label: "one-shot -p run finishes", starts: PRINT },
	{ id: "print-sigterm", label: "SIGTERM to a one-shot run mid-turn", posix: true, starts: [...PRINT, "bg-running"] },
	{ id: "rpc-stdin", label: "RPC stdin closed", starts: ALL },
	{ id: "rpc-sigterm", label: "SIGTERM to pi", posix: true, starts: ALL },
	{ id: "rpc-sighup", label: "SIGHUP to pi", posix: true, starts: ALL },
	{ id: "rpc-sigint", label: "SIGINT twice to pi's process group (ctrl+c)", posix: true, starts: ALL },
	{ id: "rpc-crash", label: "uncaught exception in RPC mode (Node's default exit)", starts: ALL },
	{ id: "tui-crash", label: "uncaught exception in interactive mode (pi's crash handler)", posix: true, tui: true, starts: ALL },
	{ id: "tui-ctrlc", label: "ctrl+c twice in interactive mode", posix: true, tui: true, starts: ALL },
	{
		id: "rpc-sigint-held",
		label: "SIGINT to pi while another listener holds it (pi keeps running: nothing may be ended)",
		posix: true,
		alive: true,
		keeps: true,
		starts: ALL,
	},
	{ id: "new", label: "/new with pi still running (old session's processes)", alive: true, starts: ALL },
	{ id: "resume", label: "resume another session with pi still running (old session's processes)", alive: true, starts: ALL },
];

const DAEMONS = new Set(["bg-daemon", "bg-noterm", "sub-daemon"]);

/**
 * Whether `spawner`'s process may outlive `ending` on `platform`:
 * `{ verdict: "gone" | "may survive" | "open", reason }`.
 */
export function expectation(spawner, ending, platform = process.platform) {
	if (spawner === "unknown") return { verdict: "gone", reason: "a tagged process no fixture names: something One Code started" };
	if (spawner === "hook") {
		return {
			verdict: "may survive",
			reason: "a hook may start a long-lived process on purpose (a SessionStart dev server), as Claude Code allows; only a timeout, abort or output overflow ends its group (safety/hooks/executor.ts, decisions/hooks.md)",
		};
	}
	if (DAEMONS.has(spawner) && platform === "win32") {
		return {
			verdict: "may survive",
			reason: "Windows has no process groups: a tree is reached only through its live leader (process-tree.ts rememberedGroupAlive)",
		};
	}
	if (DAEMONS.has(spawner) && (ending === "new" || ending === "resume")) {
		return { verdict: "may survive", reason: "session replacement keeps a background shell's leftovers until the process exits (process-tree.ts header)" };
	}
	return { verdict: "gone", reason: "nothing outlives its session (decisions/tools.md)" };
}

/** The spawner a tagged process belongs to, read from its command line. */
export function spawnerOf(commandLine, tag) {
	const labelled = new RegExp(`${tag}:([a-z-]+)`).exec(commandLine)?.[1];
	if (labelled) return SPAWNERS.some((s) => s.id === labelled) ? labelled : "unknown";
	// A launcher's own command line names its script, which lives under the run's root.
	if (/[\\/]gopls(\.cmd)?\b/.test(commandLine)) return "lsp";
	if (/[\\/]probe-mcp(\.cmd)?\b/.test(commandLine)) return "mcp";
	return "unknown";
}

/**
 * The tagged processes in `ps [-E] -ww -ax -o pid=,ppid=,command=` output
 * (macOS `-E` appends the environment to the command, except a platform
 * binary's, so its command line must carry the tag instead). An empty tag
 * keeps every line.
 */
export function parsePs(output, tag) {
	const found = [];
	for (const line of output.split("\n")) {
		if (!line.includes(tag)) continue;
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (match) found.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
	}
	return found;
}

/**
 * A cell where pi keeps running and nothing may be ended: `before` the old
 * session's processes of this spawner, `after` those still alive.
 */
export function keptOutcome({ seen, before, after }) {
	if (!seen) return { status: "NOT STARTED", fails: true };
	const ended = before.filter((p) => !after.some((q) => q.pid === p.pid));
	return ended.length > 0 ? { status: "ENDED (pi lives)", fails: true, ended } : { status: "kept", fails: false };
}

/**
 * One cell's outcome. `seen`: the spawner's process was observed before the
 * ending (else the cell was not exercised); `survivors`: its processes alive
 * after the ending plus the grace period.
 */
export function cellOutcome({ verdict }, { seen, survivors }) {
	if (survivors.length > 0) {
		if (verdict === "gone") return { status: "LEAK", fails: true };
		return { status: verdict === "open" ? "open: survived" : "kept (allowed)", fails: false };
	}
	if (!seen) return { status: "NOT STARTED", fails: true };
	return { status: verdict === "open" ? "open: gone" : "gone", fails: false };
}
