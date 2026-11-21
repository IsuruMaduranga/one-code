/**
 * The exit probe's policy table and parsing (test/e2e/exit-probe-policy.mjs):
 * the cells that encode a decision, and how a process is tied to its spawner.
 */
import { describe, expect, it } from "vitest";
import { cellOutcome, DAEMONS, ENDINGS, endingsFor, expectation, keptOutcome, parsePs, SPAWNERS, spawnerOf } from "../e2e/exit-probe-policy.mjs";

const TAG = "xp0123456789abcdef";

describe("the exit probe's expectations", () => {
	it("requires every spawner but a hook's leftovers to be gone when the process ends", () => {
		for (const ending of ENDINGS.filter((e) => !e.alive)) {
			for (const { id } of SPAWNERS) {
				const { verdict } = expectation(id, ending.id, "darwin");
				expect(verdict, `${id} / ${ending.id}`).toBe(id === "hook" ? "may survive" : "gone");
			}
		}
	});

	it("does not wait for a finished command's workers under the Linux sandbox, which ends them with the command", () => {
		expect(endingsFor({ sandbox: false, platform: "linux" })).toBe(ENDINGS);
		expect(endingsFor({ sandbox: true, platform: "darwin" })).toBe(ENDINGS);
		const sandboxed = endingsFor({ sandbox: true, platform: "linux" });
		expect(sandboxed.map((ending) => ending.id)).toEqual(ENDINGS.map((ending) => ending.id));
		for (const ending of sandboxed) expect(ending.starts.some((id) => DAEMONS.has(id)), ending.id).toBe(false);
		expect(sandboxed.find((ending) => ending.id === "rpc-sigterm")?.starts).toContain("bg-running");
	});

	it("lets a hook's and a background shell's leftovers outlive a session switch, and nothing else", () => {
		for (const ending of ["new", "resume"]) {
			const allowed = SPAWNERS.map((s) => s.id).filter((id) => expectation(id, ending, "linux").verdict === "may survive");
			expect(allowed).toEqual(["hook", "bg-daemon", "bg-noterm", "sub-daemon"]);
		}
	});

	it("lets a background shell's leftovers survive on Windows, where no group reaches them", () => {
		expect(expectation("bg-daemon", "rpc-stdin", "win32").verdict).toBe("may survive");
		expect(expectation("lsp", "rpc-stdin", "win32").verdict).toBe("gone");
	});

	it("fails an unknown tagged process", () => {
		expect(expectation("unknown", "rpc-stdin").verdict).toBe("gone");
	});
});

describe("tying a process to its spawner", () => {
	it("reads the role a fixture puts on its command line", () => {
		expect(spawnerOf(`node exit-probe-proc.mjs sleep ${TAG}:bg-daemon`, TAG)).toBe("bg-daemon");
		expect(spawnerOf(`/bin/bash -c "node proc.mjs fork ${TAG}:hook"`, TAG)).toBe("hook");
		expect(spawnerOf(`node x.mjs ${TAG}:nonsense`, TAG)).toBe("unknown");
	});

	it("names a launcher by its script", () => {
		expect(spawnerOf(`/bin/sh /tmp/exit-probe-${TAG}/bin/gopls serve`, TAG)).toBe("lsp");
		expect(spawnerOf(`C:\\Temp\\exit-probe-${TAG}\\bin\\probe-mcp.cmd`, TAG)).toBe("mcp");
		expect(spawnerOf("pi", TAG)).toBe("unknown");
	});

	it("keeps the ps lines that carry the tag, in the command or the environment", () => {
		const out = [`  101     1 node a.mjs sleep ${TAG}:hook`, `  102   101 pi EXIT_PROBE_TAG=${TAG} HOME=/x`, "  103     1 node other.mjs"].join("\n");
		expect(parsePs(out, TAG).map((p) => [p.pid, p.ppid])).toEqual([
			[101, 1],
			[102, 101],
		]);
	});
});

describe("a cell's outcome", () => {
	const survivor = { pid: 1, ppid: 1, command: "x" };
	it("fails a survivor that must be gone, and a fixture that never started", () => {
		expect(cellOutcome({ verdict: "gone" }, { seen: true, survivors: [survivor] })).toMatchObject({ status: "LEAK", fails: true });
		expect(cellOutcome({ verdict: "gone" }, { seen: false, survivors: [] })).toMatchObject({ status: "NOT STARTED", fails: true });
		expect(cellOutcome({ verdict: "gone" }, { seen: true, survivors: [] })).toMatchObject({ status: "gone", fails: false });
	});

	it("allows a survivor that may survive or whose policy is open", () => {
		expect(cellOutcome({ verdict: "may survive" }, { seen: true, survivors: [survivor] }).fails).toBe(false);
		expect(cellOutcome({ verdict: "open" }, { seen: true, survivors: [survivor] })).toMatchObject({ status: "open: survived", fails: false });
	});

	it("fails a process ended while pi keeps running", () => {
		const before = [survivor, { pid: 2, ppid: 1, command: "y" }];
		expect(keptOutcome({ seen: true, before, after: [survivor] })).toMatchObject({ status: "ENDED (pi lives)", fails: true });
		expect(keptOutcome({ seen: true, before, after: before })).toMatchObject({ status: "kept", fails: false });
	});

	it("fails a kept cell whose fixture had nothing alive when the signal came", () => {
		expect(keptOutcome({ seen: true, before: [], after: [] })).toMatchObject({ status: "NOT STARTED", fails: true });
	});
});
