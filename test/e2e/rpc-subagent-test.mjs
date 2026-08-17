#!/usr/bin/env node
/**
 * E2E: subagents run IN-PROCESS (Claude Code's Agent/SendMessage architecture),
 * not as nested `pi` processes — the claim from the 2026-08-17 in-process rewrite
 * (docs/decisions/subagents-workflows.md). Drives one persisted `--mode rpc`
 * main session through every subagent path and asserts, out-of-band, that:
 *
 *   1. NO nested `pi` process ever spawns — the main pi's descendant tree is
 *      sampled throughout; a `pi`-named descendant appearing means the runner
 *      regressed to spawning a child process. (The pre-rewrite design spawned
 *      one `pi` per run — the SIGKILL-OOM footprint the rewrite removed.)
 *   2. A subagent REUSES the parent's MCP connection — the count of MCP-server
 *      descendants never grows while subagents run (a reconnecting child would
 *      spawn its own server). No-op/graceful when no MCP server is configured.
 *
 * Functionally it exercises: foreground Agent, `fork`, `isolation:"worktree"`,
 * `run_in_background` + resident, and SendMessage to the resident child. Each
 * turn asks the subagent to echo a unique marker; the harness confirms the
 * marker reaches the main session's stream.
 *
 * Real model calls — run it manually (like the other rpc-*.mjs harnesses), not
 * in CI. From a sandboxed assistant shell, wrap in tmux (findings §10):
 *   tmux new-session -d "node test/e2e/rpc-subagent-test.mjs"
 *
 * Usage: node rpc-subagent-test.mjs [scratch-dir]
 * Env:   MODEL (default anthropic/claude-haiku-4-5)
 */

import { spawn, execFileSync } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = process.argv[2] ?? mkdtempSync(join(tmpdir(), "cc-subagent-e2e-"));
const MODEL = process.env.MODEL ?? "anthropic/claude-haiku-4-5";

const workdir = join(scratch, "work");
const sessionDir = join(scratch, "sessions");
mkdirSync(workdir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

// worktree isolation needs a git repo with at least one commit (a HEAD to branch from).
const git = (args) => execFileSync("git", args, { cwd: workdir, stdio: "ignore" });
git(["init", "-q"]);
git(["config", "user.email", "e2e@example.com"]);
git(["config", "user.name", "e2e"]);
execFileSync("sh", ["-c", "echo seed > seed.txt"], { cwd: workdir });
git(["add", "-A"]);
git(["commit", "-q", "-m", "seed"]);

// ---------------------------------------------------------------------------
// Out-of-band process sampler: walk the main pi's descendant tree and flag any
// nested `pi` process, and watch MCP-server descendant count for growth.
// ---------------------------------------------------------------------------
const descendants = (rootPid) => {
	// Map every pid -> ppid once, then walk down from rootPid.
	let out;
	try {
		out = execSync("ps -Ao pid=,ppid=,comm=,args=", { encoding: "utf8" });
	} catch {
		return [];
	}
	const rows = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/);
		if (!m) continue;
		rows.push({ pid: +m[1], ppid: +m[2], comm: m[3], args: m[4] });
	}
	const byParent = new Map();
	for (const r of rows) {
		if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
		byParent.get(r.ppid).push(r);
	}
	const acc = [];
	const stack = [rootPid];
	const seen = new Set();
	while (stack.length) {
		const pid = stack.pop();
		for (const child of byParent.get(pid) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			acc.push(child);
			stack.push(child.pid);
		}
	}
	return acc;
};

const isPi = (r) => r.comm === "pi" || /\/(bin\/)?pi(\.m?js)?\b/.test(r.args);
const isMcp = (r) => /(mcp|context7|modelcontextprotocol|deepwiki)/i.test(r.args);

const sampler = {
	mainPid: null,
	nestedPiSeen: [], // { pid, args } for any pi-named descendant ever seen
	mcpBaseline: 0,
	mcpMax: 0,
	timer: null,
	baselineTaken: false,
	start(mainPid) {
		this.mainPid = mainPid;
		this.timer = setInterval(() => this.tick(), 500);
	},
	tick() {
		if (!this.mainPid) return;
		const kids = descendants(this.mainPid);
		for (const r of kids) {
			if (isPi(r) && !this.nestedPiSeen.some((n) => n.pid === r.pid)) {
				this.nestedPiSeen.push({ pid: r.pid, args: r.args.slice(0, 120) });
			}
		}
		const mcpCount = kids.filter(isMcp).length;
		this.mcpMax = Math.max(this.mcpMax, mcpCount);
	},
	takeBaseline() {
		// After MCP servers have had time to connect, freeze the parent's count.
		const kids = descendants(this.mainPid);
		this.mcpBaseline = kids.filter(isMcp).length;
		this.mcpMax = this.mcpBaseline;
		this.baselineTaken = true;
	},
	stop() {
		if (this.timer) clearInterval(this.timer);
	},
};

// ---------------------------------------------------------------------------
// RPC driver
// ---------------------------------------------------------------------------
const child = spawn("pi", ["--mode", "rpc", "--session-dir", sessionDir, "--model", MODEL, "--dangerously-skip-permissions"], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
	env: { ...process.env },
});
sampler.start(child.pid);

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let rawStdout = "";
let buffer = "";
const seenMarkers = new Set();
const MARKERS = ["FG-MARK-42", "FORK-MARK-5", "WT-MARK-3", "BG-MARK-7", "MSG-MARK-9"];

const waiters = []; // { needle, resolve }
const noteMarkers = () => {
	for (const m of MARKERS) if (rawStdout.includes(m)) seenMarkers.add(m);
	for (let i = waiters.length - 1; i >= 0; i--) {
		if (rawStdout.includes(waiters[i].needle)) {
			waiters[i].resolve();
			waiters.splice(i, 1);
		}
	}
};

let turnEnds = 0; // count of agent_end events (top-level turns and follow-up turns)
const turnWaiters = [];

child.stdout.on("data", (chunk) => {
	rawStdout += chunk.toString();
	buffer += chunk.toString();
	let idx;
	while ((idx = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		// Auto-answer any UI request (skip-permissions should prevent these, but be safe).
		if (event.type === "extension_ui_request") {
			send({ type: "extension_ui_response", id: event.id, cancelled: true, confirmed: false });
		} else if (event.type === "agent_end") {
			turnEnds += 1;
			for (const w of turnWaiters.splice(0)) w();
		}
	}
	noteMarkers();
});

const waitFor = (needle, ms, label) =>
	new Promise((resolve, reject) => {
		if (rawStdout.includes(needle)) return resolve();
		const w = { needle, resolve };
		waiters.push(w);
		setTimeout(() => {
			const i = waiters.indexOf(w);
			if (i !== -1) waiters.splice(i, 1);
			reject(new Error(`timeout waiting for "${needle}"${label ? ` (${label})` : ""}`));
		}, ms);
	});

let reqN = 0;
// Send a prompt and resolve when THIS turn settles (the next agent_end). Rejects
// on timeout so a wedged turn fails its own scenario rather than the whole run.
const promptTurn = (message, ms, label) =>
	new Promise((resolve, reject) => {
		const before = turnEnds;
		const to = setTimeout(() => reject(new Error(`turn did not settle${label ? ` (${label})` : ""}`)), ms);
		turnWaiters.push(function settle() {
			if (turnEnds <= before) {
				turnWaiters.push(settle); // an earlier turn's end; keep waiting for ours
				return;
			}
			clearTimeout(to);
			resolve();
		});
		send({ id: `req-${++reqN}`, type: "prompt", message });
	});

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
const results = [];
const check = (name, passed, detail = "") => {
	results.push({ name, passed });
	console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const overall = setTimeout(() => {
	console.error("OVERALL TIMEOUT");
	sampler.stop();
	try { child.kill(); } catch {}
	process.exit(1);
}, 480_000);

// Run one scenario in isolation: a timeout or error fails just this check and
// the run continues to the next scenario (they are independent top-level turns).
const step = async (name, fn) => {
	try {
		await fn();
		check(name, true);
	} catch (e) {
		check(name, false, e.message);
	}
};

const run = async () => {
	// Give the session (and any MCP servers) time to boot, then freeze the MCP baseline.
	await new Promise((r) => setTimeout(r, 8000));
	sampler.takeBaseline();
	console.log(`MCP baseline (parent's servers): ${sampler.mcpBaseline}`);

	// 1. Foreground Agent.
	await step("foreground: subagent marker relayed", async () => {
		await promptTurn(
			"Use the Agent tool with subagent_type 'general-purpose' and task: \"Reply with exactly the single token FG-MARK-42 and nothing else.\" Do NOT do the work yourself. When the agent returns, tell me the token.",
			150_000,
			"foreground",
		);
		if (!seenMarkers.has("FG-MARK-42")) throw new Error("FG-MARK-42 not seen");
	});

	// 2. fork (inherits this conversation; needs a persisted session).
	await step("fork: subagent marker relayed", async () => {
		await promptTurn(
			"Use the Agent tool with subagent_type 'fork' and task: \"Reply with exactly the single token FORK-MARK-5 and nothing else.\" When it returns, tell me the token.",
			150_000,
			"fork",
		);
		if (!seenMarkers.has("FORK-MARK-5")) throw new Error("FORK-MARK-5 not seen");
	});

	// 3. worktree isolation.
	await step("worktree: subagent marker relayed", async () => {
		await promptTurn(
			"Use the Agent tool with subagent_type 'general-purpose', isolation 'worktree', and task: \"Reply with exactly the single token WT-MARK-3 and nothing else.\" When it returns, tell me the token.",
			150_000,
			"worktree",
		);
		if (!seenMarkers.has("WT-MARK-3")) throw new Error("WT-MARK-3 not seen");
	});

	// 4. Background / resident: dispatch returns immediately; completion arrives
	// asynchronously as a notification (its own follow-up turn).
	await step("background: resident completion relayed", async () => {
		await promptTurn(
			"Use the Agent tool with run_in_background true, subagent_type 'general-purpose', name 'bg1', and task: \"Reply with exactly the single token BG-MARK-7 and nothing else.\" Then immediately, without waiting for it, tell me you started it.",
			120_000,
			"background dispatch",
		);
		await waitFor("BG-MARK-7", 150_000, "background completion notification");
	});

	// 5. SendMessage to the resident child.
	await step("SendMessage: resident reply relayed", async () => {
		await promptTurn(
			"Use the SendMessage tool with to 'bg1' and message: \"Reply with exactly the single token MSG-MARK-9 and nothing else.\" Then tell me you sent it.",
			120_000,
			"SendMessage dispatch",
		);
		await waitFor("MSG-MARK-9", 150_000, "SendMessage reply notification");
	});
};

run()
	.catch((e) => {
		console.error(`SCENARIO ERROR: ${e.message}`);
	})
	.finally(async () => {
		// Let the sampler catch any late process, then assert the architectural claims.
		await new Promise((r) => setTimeout(r, 1000));
		sampler.stop();
		clearTimeout(overall);

		check(
			"architecture: no nested pi process ever spawned",
			sampler.nestedPiSeen.length === 0,
			sampler.nestedPiSeen.length ? sampler.nestedPiSeen.map((n) => `${n.pid}:${n.args}`).join(" | ") : "descendant tree stayed pi-free",
		);
		check(
			"architecture: MCP connection reused (no extra server spawned)",
			sampler.mcpMax <= sampler.mcpBaseline,
			`baseline=${sampler.mcpBaseline} max=${sampler.mcpMax}`,
		);

		try { child.kill(); } catch {}
		// Raw stream kept for diagnosis when a marker/turn assertion fails.
		try {
			writeFileSync(join(scratch, "raw-stdout.txt"), rawStdout);
		} catch {}
		const ok = results.every((r) => r.passed);
		console.log(`\n${ok ? "ALL PASS" : "SOME FAILED"} (${results.filter((r) => r.passed).length}/${results.length})`);
		console.log(`scratch: ${scratch}`);
		process.exit(ok ? 0 : 2);
	});
