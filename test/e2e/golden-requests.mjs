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
 *   node test/e2e/golden-requests.mjs --jobs 2  runs at once (default: half the CPUs)
 *   node test/e2e/golden-requests.mjs --sweep   one turn per optional feature
 *       turned off (ONECODE_FEATURES_OFF), plus a tool-switch check
 *       (ONECODE_TOOLS_OFF): each run must finish and send a request, the
 *       turned-off tools must be missing from it, and no text may name one
 *       (lib/profile/live-tools.ts); a guard feature (hooks,
 *       the edit guard) turned off from the environment must stop pi at
 *       startup instead; with --dir, each run's requests are written there
 *
 * Each run gets a fresh HOME (so no real CLAUDE.md, settings or memory leaks
 * in), pi's agent dir under it with this repo as the only package and the
 * app's settings (pi's replaced built-ins off, the compaction keep window),
 * and a fixed project directory. The tier is forced through One Code's
 * `modelTiers` setting, so one model covers every register. Values that differ
 * per machine or per run (paths, dates, the OS release, the login, ids) are
 * replaced with placeholders before comparing. Runs share nothing, so they go
 * several at a time; results print in config order.
 *
 * Needs a real terminal-less pi run: from a sandboxed assistant shell, run it
 * inside tmux (findings §10).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { withCompactionKeepBackfilled } from "../../extensions/lib/app/compaction-keep.mjs";
import { FEATURE_IDS, FEATURES, isGuardFeature } from "../../extensions/lib/profile/features.ts";
import { projectSlug } from "../../extensions/lib/context/memory.ts";
import { withReplacedBuiltinsOff } from "../../extensions/lib/app/replaced-builtins.mjs";

const { values: opts } = parseArgs({
	options: {
		update: { type: "boolean", default: false },
		sweep: { type: "boolean", default: false },
		only: { type: "string" },
		dir: { type: "string" },
		jobs: { type: "string" },
	},
});

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piCli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const fixture = join(repo, "test/e2e/golden-fixture.ts");
const goldenDir = resolve(opts.dir ?? join(repo, "captures/golden-requests"));
const jobs = Math.max(1, Number(opts.jobs) || Math.floor(os.availableParallelism() / 2));
const RUN_TIMEOUT_MS = 180_000;

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
	// Instruction files without a CLAUDE.md (AGENTS.md loads under the default rule), and in independent mode.
	{ name: "agents-anthropic-frontier", model: ANTHROPIC, tier: "frontier", mode: "print", instructions: "agents" },
	{ name: "independent-anthropic-frontier", model: ANTHROPIC, tier: "frontier", mode: "print", instructions: "independent", env: { ONECODE_CONFIG_MODE: "independent" } },
	{ name: "tools-anthropic-frontier", model: ANTHROPIC, tier: "frontier", mode: "tools" },
	{ name: "tools-anthropic-tiny", model: ANTHROPIC, tier: "tiny", mode: "tools" },
	{ name: "tools-openrouter-cheap", model: OPENROUTER, tier: "cheap", mode: "tools" },
	{ name: "session-anthropic-frontier", model: ANTHROPIC, tier: "frontier", mode: "session" },
	{ name: "session-anthropic-tiny", model: ANTHROPIC, tier: "tiny", mode: "session" },
	{ name: "session-openrouter-cheap", model: OPENROUTER, tier: "cheap", mode: "session" },
];
const PROMPTS = { print: "Reply with OK.", tools: "GOLDEN_TOOLS GOLDEN_AGENT GOLDEN_NOTEBOOK GOLDEN_TASKS GOLDEN_WEB_FETCH GOLDEN_SEARCH GOLDEN_SKILL GOLDEN_MCP GOLDEN_LSP GOLDEN_HOOKS GOLDEN_MEMORY GOLDEN_CRON GOLDEN_MONITOR GOLDEN_LOOP GOLDEN_ARTIFACT GOLDEN_FILES GOLDEN_WORKFLOW GOLDEN_AUTOMODE GOLDEN_PERMISSIONS GOLDEN_SUBAGENTS GOLDEN_SHELL GOLDEN_RESULTS GOLDEN_TOOLSEARCH GOLDEN_INSTRUCTIONS GOLDEN_WORKTREE: make the scripted calls." };

/** A format 4.4 notebook (no cell ids, so nothing random) with the given code cells. */
const notebook = (...sources) =>
	`${JSON.stringify({ nbformat: 4, nbformat_minor: 4, metadata: {}, cells: sources.map((source) => ({ cell_type: "code", metadata: {}, source: [source], outputs: [], execution_count: null })) }, null, 1)}\n`;
/** The files the tools scenario's notebook round edits (golden-fixture.ts NOTEBOOK_CALLS). */
const NOTEBOOK_FILES = {
	"nb1.ipynb": notebook("print(1)"),
	"nb2.ipynb": notebook("print(1)"),
	"nb3.ipynb": notebook("print(1)"),
	"nb4.ipynb": notebook("print(1)", "print(2)"),
	"nb5.ipynb": notebook("print(1)", "print(2)"),
	"notjupyter.ipynb": "{}\n",
};
/**
 * Makes the tools scenario's project a git repository for the worktree rounds
 * (golden-fixture.ts WORKTREE_ROUNDS): one commit at a fixed date, so every
 * hash is stable; a worktree `kept`; a listed worktree `gone` whose directory
 * is deleted; and a branch `dup` that a new worktree's branch collides with.
 */
function makeGitProject(project, home) {
	const date = "2026-01-01T00:00:00Z";
	const env = { ...cleanEnv(), HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, TZ: "UTC" };
	const git = (...args) => execFileSync("git", args, { cwd: project, env, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Golden");
	git("config", "user.email", "golden@example.com");
	git("config", "commit.gpgsign", "false");
	mkdirSync(join(project, ".claude", "worktrees"), { recursive: true });
	writeFileSync(join(project, ".claude", "worktrees", ".gitignore"), "*\n");
	git("add", "-A");
	git("commit", "-q", "-m", "Golden project");
	git("branch", "dup");
	git("worktree", "add", "-q", "-b", "kept", ".claude/worktrees/kept");
	git("worktree", "add", "-q", "-b", "gone", ".claude/worktrees/gone");
	rmSync(join(project, ".claude", "worktrees", "gone"), { recursive: true, force: true });
}

/**
 * Instruction files of every kind the agent, its children and the classifier
 * read. `tools` (golden-fixture.ts INSTRUCTION_ROUNDS): the global and project
 * CLAUDE.md with an import, CLAUDE.local.md, an unconditional and a
 * path-conditional rule, an AGENTS.md beside the CLAUDE.md, and a nested
 * CLAUDE.md. `agents`: AGENTS.md files and no CLAUDE.md. `independent`: both
 * kinds, of which independent mode reads only AGENTS.md. Every kind also has
 * the global AGENTS.md files (pi's agent dir and ~/.agents).
 */
function writeInstructionFiles(kind, project, home, agentDir) {
	const write = (path, content) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	};
	write(join(agentDir, "AGENTS.md"), "Golden pi global AGENTS.md.\n");
	write(join(home, ".agents", "AGENTS.md"), "Golden user AGENTS.md.\n");
	write(join(project, "AGENTS.md"), "Golden project AGENTS.md.\n");
	write(join(project, "sub", "AGENTS.md"), "Golden nested AGENTS.md.\n");
	if (kind === "agents") return;
	write(join(project, "ONECODE.md"), "Golden One Code instructions: reply plainly.\n");
	write(join(home, ".claude", "CLAUDE.md"), "Golden global CLAUDE.md.\n");
	write(join(project, "CLAUDE.md"), "Golden project CLAUDE.md.\n\n@docs/conventions.md\n");
	write(join(project, "docs", "conventions.md"), "Golden imported conventions.\n");
	write(join(project, "CLAUDE.local.md"), "Golden local CLAUDE.md.\n");
	write(join(project, ".claude", "rules", "style.md"), "Golden style rule.\n");
	write(join(project, ".claude", "rules", "go.md"), "---\npaths: \"**/*.go\"\n---\n\nGolden Go rule.\n");
	write(join(project, "sub", "CLAUDE.md"), "Golden nested CLAUDE.md.\n");
	write(join(project, "sub", "code.go"), "package sub\n");
	write(join(project, "sub", "notes.txt"), "Golden nested notes.\n");
}

/** The tools scenario's project skills (golden-fixture.ts SKILL_ROUNDS), by name: frontmatter lines and body. */
const PROJECT_SKILLS = {
	"golden-echo": ["description: Echo a word for the golden snapshot.", 'argument-hint: "<word>"', "Echo this word back: $ARGUMENTS"],
	"golden-manual": ["description: A skill only the user may start.", "disable-model-invocation: true", "Manual steps."],
	"golden-off": ["description: A skill turned off.", "Off steps."],
	"golden-hidden": ["description: A user-only skill.", "Hidden steps."],
};

/** Writes the project skills, and turns golden-off off and golden-hidden user-only (lib/plugins/skill-overrides.ts). */
function writeProjectSkills(project, agentDir) {
	for (const [name, lines] of Object.entries(PROJECT_SKILLS)) {
		const dir = join(project, ".claude", "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n${lines.slice(0, -1).join("\n")}\n---\n\n${lines.at(-1)}\n`);
	}
	mkdirSync(join(agentDir, "plugins"), { recursive: true });
	writeFileSync(join(agentDir, "plugins", "skill-overrides.json"), `${JSON.stringify({ "project:golden-off": "off", "project:golden-hidden": "user-only" }, null, 2)}\n`);
}

/**
 * The tools scenario's user-scope MCP servers (golden-fixture.ts MCP_ROUNDS):
 * `golden`, the stub server, and `broken`, which exits before it answers.
 */
function writeMcpServers(home) {
	const mcpServers = {
		golden: { command: process.execPath, args: [join(repo, "test/e2e/golden-mcp-server.mjs")] },
		broken: { command: process.execPath, args: ["-e", "process.exit(1)"] },
	};
	writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
}

/**
 * User-scope hooks (no consent dialog) running golden-hook.mjs: the tool hooks
 * and SessionStart, UserPromptSubmit and Stop in the tools scenario
 * (golden-fixture.ts HOOK_ROUNDS), the compaction hooks in the session
 * scenario. The tools scenario's settings also carry a deny rule.
 */
function writeHooks(home, mode) {
	const hook = (kind, extra = {}) => ({ hooks: [{ type: "command", command: `"${process.execPath}" "${join(repo, "test/e2e/golden-hook.mjs")}" ${kind}`, ...extra }] });
	const hooks =
		mode === "tools"
			? {
					PreToolUse: [{ matcher: "Bash", ...hook("pre") }, { matcher: "Bash", hooks: [{ ...hook("slow").hooks[0], timeout: 1 }] }],
					PostToolUse: [{ matcher: "Bash|Write", ...hook("post") }],
					SessionStart: [hook("session")],
					UserPromptSubmit: [hook("prompt")],
					Stop: [hook("stop")],
				}
			: { PreCompact: [hook("precompact")], PostCompact: [hook("postcompact")] };
	mkdirSync(join(home, ".claude"), { recursive: true });
	// The tools scenario's deny rule (golden-fixture.ts PERMISSION_ROUNDS).
	const permissions = mode === "tools" ? { permissions: { deny: ["Bash(golden-denied:*)"] } } : {};
	writeFileSync(join(home, ".claude", "settings.json"), `${JSON.stringify({ hooks, ...permissions }, null, 2)}\n`);
}

/** The tools scenario's `gopls`: a wrapper that runs the stub language server (golden-fixture.ts LSP_ROUNDS). */
function writeLanguageServer(bin) {
	mkdirSync(bin, { recursive: true });
	const script = join(repo, "test/e2e/golden-lsp-server.mjs");
	writeFileSync(join(bin, "gopls"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
}

const SESSION_PROMPTS = ["GOLDEN_TOOLS GOLDEN_BIGFILE GOLDEN_DENY: read README.md and run echo golden.", "Reply with OK."];

/** The parent's environment without anything that steers pi or One Code. */
function cleanEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(PI_|CC_|ONECODE_|ONE_CODE_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENROUTER_|OPEN_ROUTER_|BRAVE_|TAVILY_|EXA_)/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

/** Run one config in a fresh temp root; resolves with its normalized `{ dialogs, requests }` or throws. */
async function runConfig(config) {
	const root = realpathSync(mkdtempSync(join(os.tmpdir(), "golden-")));
	try {
		const home = join(root, "home");
		const bin = join(root, "bin");
		const project = join(root, "project");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(home, ".onecode"), { recursive: true });
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "README.md"), "# Golden project\n\nA fixed project for the golden request snapshot.\n");
		if (config.mode === "tools") {
			for (const [name, content] of Object.entries(NOTEBOOK_FILES)) writeFileSync(join(project, name), content);
			writeProjectSkills(project, agentDir);
			writeMcpServers(home);
			writeLanguageServer(bin);
			writeInstructionFiles("tools", project, home, agentDir);
			makeGitProject(project, home);
		}
		if (config.instructions) writeInstructionFiles(config.instructions, project, home, agentDir);
		if (config.mode !== "print") writeHooks(home, config.mode);
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
			// Keys for the canned Brave and Tavily replies (golden-fixture.ts SEARCH_ROUNDS),
			// and the stub language server first on PATH (LSP_ROUNDS).
			// SSH_CONNECTION keeps the artifact tool from opening a real browser (ARTIFACT_ROUNDS).
			...(config.mode === "tools"
				? { BRAVE_SEARCH_API_KEY: "golden-brave", TAVILY_API_KEY: "golden-tavily", PATH: `${bin}:${process.env.PATH}`, SSH_CONNECTION: "golden 22 golden 22" }
				: {}),
			...config.env,
		};
		const outcome = config.mode === "session" ? await runSession(config, { cwd: project, env }) : await runPrint(config, { cwd: project, env });
		if (outcome.problem) throw new Error(outcome.problem);
		if (!existsSync(dump)) throw new Error("no request was recorded");
		const normalize = makeNormalizer({ home, project, root });
		const requests = readFileSync(dump, "utf8").trim().split("\n").map((line) => normalize(JSON.parse(line)));
		// Side calls (the session title, the classifier, a subagent) run alongside
		// the turn, so their place in the dump varies; sorting on the serialized
		// body makes the order stable.
		const ordered = config.mode === "print" ? requests : requests.map((r) => [JSON.stringify(r), r]).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r]) => r);
		// Parallel tool calls open their dialogs in any order: sort them too.
		const dialogs = normalize(outcome.dialogs).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
		return { dialogs, requests: ordered };
	} catch (error) {
		throw new Error(`${config.name}: ${error.message ?? error}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** One `-p` turn in JSON mode. Resolves with `{ problem }` or `{ dialogs: [] }`. */
function runPrint(config, { cwd, env }) {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [piCli, "--mode", "json", "--model", config.model, "-e", fixture, "-p", PROMPTS[config.mode]], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun(code === 0 ? { dialogs: [] } : { problem: `pi exited ${code}\n${stderr.slice(-4000)}\n${stdout.slice(-2000)}` });
		});
	});
}

/**
 * Drive one RPC session: each prompt in SESSION_PROMPTS, with a manual
 * compaction between them, then a /btw side question (its answer notice is
 * recorded), /init, plan mode end to end (its approval dialog is approved)
 * with a compaction after it, ultracode switched on and off with a turn
 * after each, and a prompt refused as too long for the context window (pi
 * compacts for the overflow and retries, so that step waits for
 * `agent_settled`: pi sends `agent_end` before it decides to retry). The fixture's ask_user_question dialogs are
 * answered by their header (dialogAnswer); every other dialog is cancelled,
 * so nothing is ever approved by accident. Each dialog is recorded, so a
 * change in what asks the user shows up in the snapshot too. Resolves with
 * `{ problem }` or `{ dialogs }`.
 */
function runSession(config, { cwd, env }) {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--model", config.model, "-e", fixture], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		// A /btw answers through a notice, not a turn, so its step waits for that notice.
		const steps = [
			{ type: "prompt", message: SESSION_PROMPTS[0] },
			{ type: "compact" },
			{ type: "prompt", message: SESSION_PROMPTS[1] },
			{ type: "prompt", message: "/btw What is the golden project?", until: "notify" },
			{ type: "prompt", message: "/init" },
			// Plan mode end to end, then a compaction, after which the plan file is re-attached.
			{ type: "prompt", message: "GOLDEN_TOOLS GOLDEN_PLAN: make the scripted calls." },
			{ type: "compact" },
			{ type: "prompt", message: SESSION_PROMPTS[1] },
			// Ultracode on, a turn with its standing reminder, off, a turn with the off notice.
			{ type: "prompt", message: "/effort ultracode", until: "notify" },
			{ type: "prompt", message: SESSION_PROMPTS[1] },
			{ type: "prompt", message: "/effort high", until: "notify" },
			{ type: "prompt", message: SESSION_PROMPTS[1] },
			// Refused as too long (golden-fixture.ts overflowReply): pi compacts for the overflow and retries.
			{ type: "prompt", message: "GOLDEN_OVERFLOW: reply after the overflow.", until: "settled" },
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
		const timer = setTimeout(() => finish(`timed out at step ${step}\n${stderr.slice(-3000)}`), RUN_TIMEOUT_MS);
		// Whether the current step's run has started: the previous step's
		// `agent_settled` can arrive after this step's prompt went out.
		let started = false;
		const next = () => {
			step += 1;
			started = false;
			if (step >= steps.length) return finish();
			const { until: _until, ...command } = steps[step];
			child.stdin.write(`${JSON.stringify({ id: `step-${step}`, ...command })}\n`);
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
					const title = event.title ?? event.message ?? "";
					const answer = dialogAnswer(event.method, title, event.options);
					dialogs.push({ method: event.method, title, answer: answer ?? "(cancelled)" });
					const response = answer === undefined ? { cancelled: true } : { value: answer };
					child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, ...response })}\n`);
				} else if (event.type === "extension_ui_request" && event.method === "notify" && steps[step]?.until === "notify") {
					dialogs.push({ method: "notify", title: event.message ?? "" });
					next();
				} else if (event.type === "response" && event.success === false) {
					finish(`command ${event.command} failed: ${event.error ?? JSON.stringify(event)}`);
				} else if (event.type === "response" && event.command === "compact") {
					next();
				} else if (event.type === "agent_end" && steps[step]?.until !== "settled") {
					next();
				} else if (event.type === "agent_start") {
					started = true;
				} else if (event.type === "agent_settled" && steps[step]?.until === "settled" && started) {
					next();
				}
			}
		});
		next();
	});
}

/**
 * The answer to one of the fixture's ask_user_question dialogs, picked by its
 * header (golden-fixture.ts ASK_CALLS), or undefined to cancel: every dialog
 * that is not one of those is cancelled.
 */
function dialogAnswer(method, title, options = []) {
	// The plan approval dialog (plan-mode/viewer.ts): approve with the first choice.
	if (method === "select" && title.startsWith("Plan (")) return options.find((option) => option.startsWith("Approve"));
	const header = /^Golden (A|B|C|E1)\b/.exec(title)?.[1];
	if (!header) return undefined;
	if (method === "input") return header === "B" ? "a typed golden answer" : undefined;
	if (method !== "select") return undefined;
	if (header === "A" || header === "E1") return options[0];
	if (header === "B") return options.find((option) => option === "Type my own answer");
	return options.find((option) => option === "Chat about this");
}

/** A function that replaces every per-machine and per-run value of one run with a placeholder. */
function makeNormalizer({ home, project, root }) {
	const user = os.userInfo().username;
	const replacements = [
		// The project as a folder name (memory and scratchpad dirs).
		[projectSlug(project), "<PROJECT_SLUG>"],
		[project, "<PROJECT>"],
		[home, "<HOME>"],
		[root, "<ROOT>"],
		[os.release(), "<OS_RELEASE>"],
		// The auto-mode classifier names the login (its "User identity" line).
		[`\`${user}\``, "`<USER>`"],
		[`${user}/`, "<USER>/"],
		[new Date().toISOString().slice(0, 10), "<DATE>"],
	];
	const text = (s) => {
		let out = s;
		for (const [from, to] of replacements) out = out.split(from).join(to);
		// The scratchpad (lib/core/scratchpad.ts): <tmp>/onecode-<uid>/<project slug>/<session>/scratchpad.
		out = out.replace(/\/[^\s`'"]*\/onecode-\d+\/[^/\s]+\/[^/\s]+\/scratchpad/g, "<SCRATCHPAD>");
		// Cron job ids (lib/agents/cron.ts, 8 hex digits) where results name them,
		// and as cron_delete's input (Anthropic's object, OpenAI's JSON string).
		out = out.replace(/\b(recurring job |one-shot task |Cancelled job |with id ')[0-9a-f]{8}\b/g, "$1<JOB_ID>");
		out = out.replace(/^[0-9a-f]{8}( — )/gm, "<JOB_ID>$1");
		out = out.replace(/^[0-9a-f]{8}$/, "<JOB_ID>").replace(/("id":")[0-9a-f]{8}"/g, '$1<JOB_ID>"');
		// An artifact id's random suffix (artifacts/store.ts) and its list line's update time.
		out = out.replace(/\b(golden-report-)[0-9a-f]{6}\b/g, "$1<SUFFIX>");
		out = out.replace(/(updated <DATE> )\d{2}:\d{2}( UTC)/g, "$1<HH:MM>$2");
		// The wakeup's clock time (background/wakeup.ts formatScheduled).
		out = out.replace(/(Next wakeup scheduled for )\d{2}:\d{2}:\d{2}/g, "$1<CLOCK>");
		// Background task ids (lib/agents/task-registry.ts generateTaskId): "b" and 7 hex digits.
		out = out.replace(/\b(task |Monitor |subagents\/|tasks\/|bash\/)b[0-9a-f]{7}\b/g, "$1<TASK_ID>");
		// pi names a spilled bash output with a random suffix.
		out = out.replace(/\bpi-bash-[0-9a-f]{16}\.log\b/g, "pi-bash-<SPILL>.log");
		// A workflow run's id (workflow/run-manager.ts) and the seconds it took.
		out = out.replace(/\bwf_[0-9a-f]{10}\b/g, "wf_<RUN_ID>");
		out = out.replace(/(output tokens, \$\d+\.\d{4}, )\d+s\b/g, "$1<SECS>s");
		// Plan files get a random three-word name (plan-mode/slug.ts).
		out = out.replace(/(\/plans\/)[a-z]+-[a-z]+-[a-z]+\.md/g, "$1<PLAN_SLUG>.md");
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
	return walk;
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

/** Run `task(item)` over `items`, `jobs` at a time; resolves with the outcomes in input order. */
async function pool(items, task) {
	const results = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			try {
				results[index] = { ok: true, value: await task(items[index]) };
			} catch (error) {
				results[index] = { ok: false, error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
	return results;
}

const toolNames = (body) => (body?.tools ?? []).map((t) => t.name ?? t.function?.name);
const mainBody = (requests) => (requests.find((r) => Array.isArray(r.body.tools) && r.body.tools.length > 0) ?? requests[0])?.body;

/** --sweep: see the header. Exits the process with the outcome. */
/**
 * Phrases where a tool's name is an English word, not the tool (the same list
 * as test/unit/profile-live-tools.test.ts ENGLISH, plus the frontier request's
 * catalog and tool descriptions).
 */
const ENGLISH = {
	edit: [/about to edit \(an edit needs a read first\)/g, /a shell edit/g, /edit that file/g],
	monitor: [/monitor for regressions/g],
	skill: [/a skill or slash command/g, /re-enters the skill/g, /with a skill, agent/g],
	workflow: [/repo-specific workflow/g, /git workflow/g],
};

/** Whether a request's text names `tool` (a hyphenated word such as a skill name is not the tool). */
function namesTool(text, tool) {
	let rest = text;
	for (const phrase of ENGLISH[tool] ?? []) rest = rest.replace(phrase, "");
	return new RegExp(`(^|[^A-Za-z_-])${tool}([^A-Za-z_-]|$)`).test(rest);
}

async function sweep() {
	const optional = FEATURE_IDS.filter((id) => !FEATURES[id].required);
	const runs = optional.map((id) => ({
		label: `${id} off`,
		// Only a profile may turn a guard feature off: from the environment it must fail closed.
		mustFail: isGuardFeature(id) ? "it guards tool calls" : undefined,
		config: { name: `sweep-${id}`, model: ANTHROPIC, tier: "frontier", mode: "print", env: { ONECODE_FEATURES_OFF: id } },
	}));
	const toolsOff = ["notebook_edit", "edit", "web_fetch"];
	runs.push({ label: `tools ${toolsOff.join(", ")} off`, toolsOff, config: { name: "sweep-tools", model: ANTHROPIC, tier: "frontier", mode: "print", env: { ONECODE_TOOLS_OFF: toolsOff.join(",") } } });
	// The all-on baseline runs in the same pool; the tools a run loses against
	// it, and which of them the request's text still names (a whole-word match,
	// so a plain English word like "edit" can be a false hit), are text that
	// should follow the switches.
	const baselineRun = { label: "baseline", config: { name: "sweep-baseline", model: ANTHROPIC, tier: "frontier", mode: "print" } };
	const [baselineOutcome, ...outcomes] = await pool([baselineRun, ...runs], (run) => runConfig(run.config));
	if (!baselineOutcome.ok) {
		console.log(`FAIL  baseline: ${baselineOutcome.error.message}`);
		process.exit(1);
	}
	const baseline = toolNames(mainBody(baselineOutcome.value.requests));
	let bad = 0;
	outcomes.forEach((outcome, index) => {
		const run = runs[index];
		if (run.mustFail) {
			const message = outcome.ok ? "" : String(outcome.error.message ?? outcome.error);
			if (message.includes(run.mustFail)) {
				console.log(`ok    ${run.label} (refused at startup, as it must be)`);
			} else {
				bad += 1;
				console.log(`FAIL  ${run.label}: expected a refusal naming "${run.mustFail}"${outcome.ok ? ", but it ran" : `: ${message.slice(0, 600)}`}`);
			}
			return;
		}
		if (!outcome.ok) {
			bad += 1;
			console.log(`FAIL  ${run.label}: ${String(outcome.error.message ?? outcome.error).slice(0, 1500)}`);
			return;
		}
		const { requests } = outcome.value;
		if (opts.dir) {
			mkdirSync(goldenDir, { recursive: true });
			writeFileSync(join(goldenDir, `${run.config.name}.json`), `${JSON.stringify(requests, null, 1)}\n`);
		}
		const body = mainBody(requests);
		const names = toolNames(body);
		const leaked = (run.toolsOff ?? []).filter((name) => names.includes(name));
		if (leaked.length > 0) {
			bad += 1;
			console.log(`FAIL  ${run.label}: turned-off tools still sent: ${leaked.join(", ")}`);
			return;
		}
		const text = JSON.stringify({ system: body?.system, messages: body?.messages, tools: body?.tools });
		const named = baseline.filter((name) => !names.includes(name) && namesTool(text, name));
		if (named.length > 0) {
			bad += 1;
			console.log(`FAIL  ${run.label}: text still names a tool that is off: ${named.join(", ")}`);
			return;
		}
		console.log(`ok    ${run.label} (${requests.length} request(s), ${names.length} tools)`);
	});
	console.log(`${runs.length - bad}/${runs.length} sweep runs ok`);
	process.exit(bad > 0 ? 1 : 0);
}
if (opts.sweep) await sweep();

mkdirSync(goldenDir, { recursive: true });
const selected = CONFIGS.filter((c) => !opts.only || opts.only.split(",").includes(c.name));
const outcomes = await pool(selected, runConfig);
let failed = false;
outcomes.forEach((outcome, index) => {
	const config = selected[index];
	if (!outcome.ok) {
		failed = true;
		console.log(`FAIL  ${outcome.error.message}`);
		return;
	}
	const actual = outcome.value;
	const file = join(goldenDir, `${config.name}.json`);
	if (opts.update) {
		writeFileSync(file, `${JSON.stringify(actual, null, 1)}\n`);
		console.log(`${config.name}: wrote ${actual.requests.length} request(s), ${actual.dialogs.length} dialog(s)`);
		return;
	}
	if (!existsSync(file)) {
		console.log(`${config.name}: no snapshot (run with --update)`);
		failed = true;
		return;
	}
	const diff = firstDifference(actual, JSON.parse(readFileSync(file, "utf8")));
	if (diff) {
		failed = true;
		const { e, a } = showSides(diff.expected, diff.actual);
		console.log(`${config.name}: DIFFERS at ${diff.path}\n  expected: ${e}\n  actual:   ${a}`);
	} else {
		console.log(`${config.name}: identical (${actual.requests.length} request(s), ${actual.dialogs.length} dialog(s))`);
	}
});
process.exit(failed ? 1 : 0);
