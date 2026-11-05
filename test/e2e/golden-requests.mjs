#!/usr/bin/env node
/**
 * Golden request snapshot: runs One Code offline (test/e2e/golden-fixture.ts
 * answers every model call) once per configuration, records every request body
 * the provider would have received, and compares them with
 * `captures/golden-requests/<config>.json` (or `--dir <path>`). It is the byte
 * reference for the profile split: moving text out of the base must leave
 * every recorded request unchanged. The snapshot is local working state, kept
 * out of the public repo; record it with `--update` before a change.
 *
 *   node test/e2e/golden-requests.mjs           compare; exit 1 on any difference
 *   node test/e2e/golden-requests.mjs --update  rewrite the snapshot files
 *   node test/e2e/golden-requests.mjs --only anthropic-tiny
 *   node test/e2e/golden-requests.mjs --dir /tmp/golden
 *   node test/e2e/golden-requests.mjs --sweep   one turn per optional feature
 *       turned off (ONECODE_FEATURES_OFF), plus a tool-switch check
 *       (ONECODE_TOOLS_OFF): each run must finish and send a request, and the
 *       turned-off tools must be missing from it
 *
 * Each run gets a fresh HOME (so no real CLAUDE.md, settings or memory leaks
 * in), pi's agent dir under it with this repo as the only package and the
 * app's settings (pi's replaced built-ins off, the compaction keep window),
 * and a fixed project directory. The tier is forced through One Code's
 * `modelTiers` setting, so one model covers every register. Values that differ
 * per machine or per run (paths, dates, the OS release, the login, ids) are replaced with
 * placeholders before comparing.
 *
 * Needs a real terminal-less pi run: from a sandboxed assistant shell, run it
 * inside tmux (findings §10).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withCompactionKeepBackfilled } from "../../extensions/lib/compaction-keep.mjs";
import { withReplacedBuiltinsOff } from "../../extensions/lib/replaced-builtins.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piCli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const fixture = join(repo, "test/e2e/golden-fixture.ts");
const goldenDir = resolve(process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : join(repo, "captures/golden-requests"));

const ANTHROPIC = "anthropic/claude-opus-5-5";
const OPENROUTER = "openrouter/deepseek/deepseek-v4-flash";
// `print`: one `-p` turn (the system prompt, every tool definition, message 1).
// `tools`: one `-p` turn that makes the scripted tool calls and a subagent run
// (blocking in a one-shot run), so the tool results, the classifier's two
// stages and the child session's own requests are recorded.
// `session`: an RPC session (runSession below) with the tool calls, a manual
// compaction and a turn after it, plus the side calls a UI session makes.
const CONFIGS = [
	{ name: "anthropic-frontier", model: ANTHROPIC, tier: "frontier", mode: "print" },
	{ name: "anthropic-workhorse", model: ANTHROPIC, tier: "workhorse", mode: "print" },
	{ name: "anthropic-cheap", model: ANTHROPIC, tier: "cheap", mode: "print" },
	{ name: "anthropic-tiny", model: ANTHROPIC, tier: "tiny", mode: "print" },
	{ name: "openrouter-cheap", model: OPENROUTER, tier: "cheap", mode: "print" },
	{ name: "tools-anthropic-frontier", model: ANTHROPIC, tier: "frontier", mode: "tools" },
	{ name: "tools-anthropic-tiny", model: ANTHROPIC, tier: "tiny", mode: "tools" },
	{ name: "tools-openrouter-cheap", model: OPENROUTER, tier: "cheap", mode: "tools" },
	{ name: "session-anthropic-frontier", model: ANTHROPIC, tier: "frontier", mode: "session" },
	{ name: "session-anthropic-tiny", model: ANTHROPIC, tier: "tiny", mode: "session" },
	{ name: "session-openrouter-cheap", model: OPENROUTER, tier: "cheap", mode: "session" },
];
const PROMPTS = { print: "Reply with OK.", tools: "GOLDEN_TOOLS GOLDEN_AGENT: make the scripted calls." };
const SESSION_PROMPTS = ["GOLDEN_TOOLS: read README.md and run echo golden.", "Reply with OK."];

const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

/** The parent's environment without anything that steers pi or One Code. */
function cleanEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(PI_|CC_|ONECODE_|ONE_CODE_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENROUTER_|OPEN_ROUTER_)/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

async function runConfig(config) {
	const root = realpathSync(mkdtempSync(join(os.tmpdir(), "golden-")));
	const home = join(root, "home");
	const project = join(root, "project");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(home, ".onecode"), { recursive: true });
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "README.md"), "# Golden project\n\nA fixed project for the golden request snapshot.\n");

	const settings = withCompactionKeepBackfilled({
		quietStartup: true,
		packages: [repo],
		extensions: withReplacedBuiltinsOff(undefined).extensions,
	}).settings;
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	writeFileSync(join(home, ".onecode", "settings.json"), `${JSON.stringify({ modelTiers: { [config.model]: config.tier } }, null, 2)}\n`);

	const dump = join(root, "requests.jsonl");
	const env = {
		...cleanEnv(),
		HOME: home,
		GOLDEN_DUMP: dump,
		ANTHROPIC_API_KEY: "sk-ant-golden",
		OPENROUTER_API_KEY: "sk-or-golden",
		ONECODE_NO_UPDATE_CHECK: "1",
		SHELL: "/bin/zsh",
		TZ: "UTC",
		...config.env,
	};
	const fail = (message) => {
		rmSync(root, { recursive: true, force: true });
		throw new Error(`${config.name}: ${message}`);
	};
	let dialogs = [];
	if (config.mode !== "session") {
		const result = spawnSync(process.execPath, [piCli, "--mode", "json", "--model", config.model, "-e", fixture, "-p", PROMPTS[config.mode]], {
			cwd: project,
			env,
			encoding: "utf8",
			timeout: 120_000,
		});
		if (result.status !== 0) fail(`pi exited ${result.status}\n${result.stderr?.slice(-4000)}\n${result.stdout?.slice(-2000)}`);
	} else {
		const outcome = await runSession(config, { cwd: project, env });
		if (outcome.problem) fail(outcome.problem);
		dialogs = outcome.dialogs;
	}
	if (!existsSync(dump)) fail("no request was recorded");
	const requests = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	// Side calls (the session title, the classifier, a subagent) run alongside
	// the turn, so their place in the dump varies; sorting on the serialized
	// body makes the order stable.
	const normalized = requests.map((request) => normalize(request, { home, project, root }));
	if (config.mode !== "print") normalized.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
	rmSync(root, { recursive: true, force: true });
	return { dialogs: normalize(dialogs, { home, project, root }), requests: normalized };
}

/**
 * Drive one RPC session: each prompt in SESSION_PROMPTS, with a manual
 * compaction between them. Every dialog is cancelled and its title recorded,
 * so a change in what asks the user shows up in the snapshot too. Resolves
 * with `{ problem }` or `{ dialogs }`.
 */
function runSession(config, { cwd, env }) {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--model", config.model, "-e", fixture], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const steps = [
			{ type: "prompt", message: SESSION_PROMPTS[0] },
			{ type: "compact" },
			{ type: "prompt", message: SESSION_PROMPTS[1] },
		];
		let step = -1;
		const dialogs = [];
		let stderr = "";
		let buffer = "";
		let settled = false;
		const finish = (problem) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			resolveRun(problem ? { problem } : { dialogs });
		};
		const timer = setTimeout(() => finish(`timed out at step ${step}\n${stderr.slice(-3000)}`), 120_000);
		const next = () => {
			step += 1;
			if (step >= steps.length) return finish();
			child.stdin.write(`${JSON.stringify({ id: `step-${step}`, ...steps[step] })}\n`);
		};
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("exit", (code) => finish(`pi exited ${code} at step ${step}\n${stderr.slice(-3000)}`));
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let at;
			while ((at = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
					dialogs.push({ method: event.method, title: event.title ?? event.message ?? "" });
					child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
				} else if (event.type === "response" && event.success === false) {
					finish(`command ${event.command} failed: ${event.error ?? JSON.stringify(event)}`);
				} else if (event.type === "response" && event.command === "compact") {
					next();
				} else if (event.type === "agent_end") {
					next();
				}
			}
		});
		next();
	});
}

/** Replace every per-machine and per-run value with a placeholder. */
function normalize(value, { home, project, root }) {
	const today = new Date().toISOString().slice(0, 10);
	const replacements = [
		// The project as a folder name (memory and scratchpad dirs): every non-alphanumeric becomes "-".
		[project.replace(/[^a-zA-Z0-9]/g, "-"), "<PROJECT_SLUG>"],
		[project, "<PROJECT>"],
		[home, "<HOME>"],
		[root, "<ROOT>"],
		[os.release(), "<OS_RELEASE>"],
		// The auto-mode classifier names the login (its "User identity" line).
		[`\`${os.userInfo().username}\``, "`<USER>`"],
		[`${os.userInfo().username}/`, "<USER>/"],
		[today, "<DATE>"],
	];
	const text = (s) => {
		let out = s;
		for (const [from, to] of replacements) out = out.split(from).join(to);
		// The scratchpad (lib/scratchpad.ts): <tmp>/onecode-<uid>/<project slug>/<session>/scratchpad.
		out = out.replace(/\/[^\s`'"]*\/onecode-\d+\/[^/\s]+\/[^/\s]+\/scratchpad/g, "<SCRATCHPAD>");
		// Background task ids (background/registry.ts generateTaskId): "b" and 7 hex digits.
		out = out.replace(/\b(task |subagents\/|tasks\/)b[0-9a-f]{7}\b/g, "$1<TASK_ID>");
		// pi's session file names carry the start time: <DATE>T05-01-26-326Z.
		out = out.replace(/<DATE>T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "<DATE>T<TIME>Z");
		return out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>");
	};
	const walk = (v) => {
		if (typeof v === "string") return text(v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return walk(value);
}

/** The first path where two JSON values differ, with both sides. */
function firstDifference(a, b, path = "$") {
	if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return { path, expected: b, actual: a };
	if (a && typeof a === "object") {
		const keys = new Set([...Object.keys(a), ...Object.keys(b ?? {})]);
		for (const key of keys) {
			const diff = firstDifference(a[key], b?.[key], `${path}.${key}`);
			if (diff) return diff;
		}
		return undefined;
	}
	return a === b ? undefined : { path, expected: b, actual: a };
}

/** Both sides of a difference, cut to the text around the first character that differs. */
function showSides(expected, actual) {
	const e = typeof expected === "string" ? expected : JSON.stringify(expected);
	const a = typeof actual === "string" ? actual : JSON.stringify(actual);
	if (e === undefined || a === undefined) return { e: e ?? "(missing)", a: a ?? "(missing)" };
	let i = 0;
	while (i < e.length && e[i] === a[i]) i++;
	const cut = (s) => `${i > 200 ? "…" : ""}${s.slice(Math.max(0, i - 200), i + 300)}${s.length > i + 300 ? "…" : ""}`;
	return { e: cut(e), a: cut(a) };
}

/** --sweep: see the header. Exits the process with the outcome. */
async function sweep() {
	const { FEATURE_IDS, FEATURES } = await import("../../extensions/lib/features.ts");
	const optional = FEATURE_IDS.filter((id) => !FEATURES[id].required);
	const runs = optional.map((id) => ({ label: `${id} off`, config: { name: `sweep-${id}`, model: ANTHROPIC, tier: "frontier", mode: "print", env: { ONECODE_FEATURES_OFF: id } } }));
	const toolsOff = ["notebook_edit", "edit", "web_fetch"];
	runs.push({ label: `tools ${toolsOff.join(", ")} off`, toolsOff, config: { name: "sweep-tools", model: ANTHROPIC, tier: "frontier", mode: "print", env: { ONECODE_TOOLS_OFF: toolsOff.join(",") } } });
	let bad = 0;
	for (const run of runs) {
		try {
			const { requests } = await runConfig(run.config);
			const main = requests.find((r) => Array.isArray(r.body.tools) && r.body.tools.length > 0) ?? requests[0];
			const names = (main?.body.tools ?? []).map((t) => t.name ?? t.function?.name);
			const leaked = (run.toolsOff ?? []).filter((name) => names.includes(name));
			if (leaked.length > 0) throw new Error(`turned-off tools still sent: ${leaked.join(", ")}`);
			console.log(`ok    ${run.label} (${requests.length} request(s), ${names.length} tools)`);
		} catch (error) {
			bad += 1;
			console.log(`FAIL  ${run.label}: ${String(error.message ?? error).slice(0, 1500)}`);
		}
	}
	console.log(`${runs.length - bad}/${runs.length} sweep runs ok`);
	process.exit(bad > 0 ? 1 : 0);
}
if (args.includes("--sweep")) await sweep();

mkdirSync(goldenDir, { recursive: true });
let failed = false;
for (const config of CONFIGS.filter((c) => !only || c.name === only)) {
	const actual = await runConfig(config);
	const file = join(goldenDir, `${config.name}.json`);
	if (update) {
		writeFileSync(file, `${JSON.stringify(actual, null, 1)}\n`);
		console.log(`${config.name}: wrote ${actual.requests.length} request(s), ${actual.dialogs.length} dialog(s)`);
		continue;
	}
	if (!existsSync(file)) {
		console.log(`${config.name}: no snapshot (run with --update)`);
		failed = true;
		continue;
	}
	const expected = JSON.parse(readFileSync(file, "utf8"));
	const diff = firstDifference(actual, expected);
	if (diff) {
		failed = true;
		const { e, a } = showSides(diff.expected, diff.actual);
		console.log(`${config.name}: DIFFERS at ${diff.path}\n  expected: ${e}\n  actual:   ${a}`);
	} else {
		console.log(`${config.name}: identical (${actual.requests.length} request(s), ${actual.dialogs.length} dialog(s))`);
	}
}
process.exit(failed ? 1 : 0);
