/**
 * Offline provider for the golden request snapshot (golden-requests.mjs): wraps
 * `globalThis.fetch` like dump-requests.ts, records every model request body to
 * `GOLDEN_DUMP`, and answers it with a canned streaming reply in the provider's
 * own wire format, so a whole pi session runs with no network and no cost.
 *
 * The reply is in the provider's wire format (Anthropic Messages or OpenAI
 * Chat Completions SSE, picked from the URL). When the newest user text says
 * GOLDEN_TOOLS and no tool result has come back yet, the reply makes the
 * scripted calls in TOOL_CALLS (successes, error paths, a command the auto-mode
 * classifier judges, a deferred-tool load, the user questions), plus a subagent when it also says
 * GOLDEN_AGENT, notebook edits under GOLDEN_NOTEBOOK and the task tools
 * steps under GOLDEN_TASKS, each in later rounds, then web_fetch under
 * GOLDEN_WEB_FETCH (against canned golden.example pages) and the worktree
 * tools under GOLDEN_WORKTREE after all of them. The auto-mode classifier gets a verdict instead: severity 60
 * at stage 1, so stage 2 runs too, and severity 10 at stage 2, so the call is
 * allowed and the subagent's own requests are recorded. Every other reply is a
 * fixed text shaped like a compaction summary, which serves every turn and
 * side call (session title, compaction) alike. A fetch of a golden.example
 * page gets the canned page (PAGES); any other fetch (a catalog refresh, an
 * update check) is refused with a 503, so a run never reaches the network and
 * never depends on what it would have returned.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRAPPED = Symbol.for("one-code.golden-fixture");

const REPLY_TEXT = "<analysis>Golden.</analysis>\n<summary>Golden summary.</summary>";
type ToolCall = { id: string; name: string; input: Record<string, unknown> };

const TOOL_CALLS: ToolCall[] = [
	{ id: "toolu_golden_1", name: "read", input: { path: "README.md" } },
	{ id: "toolu_golden_2", name: "read", input: { path: "missing.md" } },
	{ id: "toolu_golden_3", name: "bash", input: { command: "echo golden" } },
	{ id: "toolu_golden_4", name: "bash", input: { command: "false" } },
	// Writes outside the project, so auto mode asks its classifier (and the
	// classifier reply below allows it; the file is in the run's temp root).
	{ id: "toolu_golden_5", name: "bash", input: { command: "rm -f ../golden-outside.txt" } },
	{ id: "toolu_golden_6", name: "tool_search", input: { query: "select:notebook_edit" } },
];
/**
 * ask_user_question in every result shape: golden-requests.mjs answers the
 * session's dialogs by header (A picks the first option, B types its own
 * answer, C asks to chat, D cancels, E answers its first question and cancels
 * the second); a one-shot run has no UI and gets the no-dialog error.
 */
const ask = (header: string, question: string) => ({ header, question, options: [{ label: "Alpha", description: "the first" }, { label: "Beta" }] });
const ASK_CALLS: ToolCall[] = [
	{ questions: [ask("Golden A", "Pick one?")] },
	{ questions: [ask("Golden B", "Type one?")] },
	{ questions: [ask("Golden C", "Discuss?")] },
	{ questions: [ask("Golden D", "Cancel?")] },
	{ questions: [ask("Golden E1", "First?"), ask("Golden E2", "Second?")] },
].map((input, i) => ({ id: `toolu_golden_ask_${i}`, name: "ask_user_question", input }));

/** Round 1 also reads the notebooks when the user text says GOLDEN_NOTEBOOK (the edit guard wants a read first). */
const NOTEBOOK_READS: ToolCall[] = ["nb1", "nb2", "nb3", "nb4", "nb5", "notjupyter"].map((name, i) => ({ id: `toolu_golden_nbread_${i}`, name: "read", input: { path: `${name}.ipynb` } }));

/**
 * Round 2 under GOLDEN_NOTEBOOK, after round 1's results: each edit mode once,
 * each on its own notebook so parallel calls cannot race, and every failure
 * path the tool names. The notebooks are format 4.4, whose cells carry no
 * random ids (golden-requests.mjs writes them).
 */
const NOTEBOOK_CALLS: ToolCall[] = [
	{ path: "nb1.ipynb", cell_id: "cell-0", new_source: "print(2)" },
	{ path: "nb2.ipynb", edit_mode: "append", new_source: "x = 1", cell_type: "code" },
	{ path: "nb3.ipynb", edit_mode: "insert", cell_id: "cell-0", new_source: "# Notes", cell_type: "markdown" },
	{ path: "nb4.ipynb", edit_mode: "delete", cell_id: "cell-1" },
	{ path: "nb5.ipynb", edit_mode: "delete" },
	{ path: "nb5.ipynb", cell_id: "zzz", new_source: "x" },
	{ path: "nb5.ipynb", cell_id: "cell-0" },
	{ path: "nb5.ipynb", edit_mode: "append", new_source: "x" },
	{},
	{ path: "absent.ipynb", cell_id: "cell-0", new_source: "x" },
	{ path: "notjupyter.ipynb", cell_id: "cell-0", new_source: "x" },
].map((input, i) => ({ id: `toolu_golden_nb_${i}`, name: "notebook_edit", input }));

/**
 * The task tools under GOLDEN_TASKS, one dependent step per round (calls in a
 * round run in parallel): load them, create, update, read back with every
 * failure (none changes state), delete. Frontier withholds them (the model
 * gate), so there the calls record pi's unknown-tool result instead.
 */
const tc = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_task_${id}`, name, input });
const TASK_ROUNDS: ToolCall[][] = [
	[tc("load", "tool_search", { query: "select:task_create,task_get,task_list,task_update" })],
	[tc("create", "task_create", { subject: "Golden task", description: "A task for the golden run.", activeForm: "Running the golden task" })],
	[tc("start", "task_update", { taskId: "1", status: "in_progress", owner: "golden" })],
	[
		tc("get", "task_get", { taskId: "1" }),
		tc("get_missing", "task_get", { taskId: "42" }),
		tc("list", "task_list", {}),
		tc("self", "task_update", { taskId: "1", addBlocks: ["1"] }),
		tc("unknown_dep", "task_update", { taskId: "1", addBlockedBy: ["9"] }),
		tc("update_missing", "task_update", { taskId: "42", status: "completed" }),
	],
	[tc("delete", "task_update", { taskId: "1", status: "deleted" })],
];

/**
 * web_fetch under GOLDEN_WEB_FETCH, against the canned pages in PAGES: load it,
 * then every result in one parallel round (an article, a page with no article
 * structure, JSON, a windowed text page, a followed same-host redirect, a
 * cross-host redirect with and without a prompt, a redirect loop, a binary
 * file, a 404, each rejected URL form, an http upgrade, and a prompt the
 * reader answers after the server-side fetch falls back on Anthropic).
 */
const wf = (id: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_wf_${id}`, name: "web_fetch", input });
const WEB_FETCH_ROUNDS: ToolCall[][] = [
	[{ id: "toolu_golden_wf_load", name: "tool_search", input: { query: "select:web_fetch" } }],
	[
		wf("article", { url: "https://golden.example/article" }),
		wf("plain", { url: "https://golden.example/plain" }),
		wf("json", { url: "https://golden.example/data.json" }),
		wf("windowed", { url: "https://golden.example/notes.txt", max_chars: 1000 }),
		wf("next_window", { url: "https://golden.example/notes.txt", max_chars: 1000, offset: 1000 }),
		wf("hop", { url: "https://golden.example/hop" }),
		wf("away", { url: "https://golden.example/away" }),
		wf("away_prompt", { url: "https://golden.example/away", prompt: "What moved?" }),
		wf("loop", { url: "https://golden.example/loop" }),
		wf("pdf", { url: "https://golden.example/file.pdf" }),
		wf("missing", { url: "https://golden.example/missing" }),
		wf("invalid", { url: "not a url" }),
		wf("scheme", { url: "ftp://golden.example/file" }),
		wf("credentials", { url: "https://user:secret@golden.example/article" }),
		wf("localhost", { url: "http://localhost:3000/" }),
		wf("upgrade", { url: "http://golden.example/article" }),
		wf("prompt", { url: "https://golden.example/article", prompt: "What does the article say?" }),
	],
];

/** The canned site web_fetch reads under GOLDEN_WEB_FETCH, by path. */
const PAGES: Record<string, { status?: number; type?: string; body?: string; location?: string }> = {
	"/article": {
		type: "text/html; charset=utf-8",
		body: "<html><head><title>Golden article</title></head><body><nav>Home | About</nav><article><h1>Golden article</h1><p>The golden article has one paragraph of real content, long enough for the reader to keep as the article body.</p><p>A second paragraph says the snapshot is stable.</p></article><footer>Footer</footer></body></html>",
	},
	"/plain": { type: "text/html", body: "<html><body><div>Just a line.</div></body></html>" },
	"/data.json": { type: "application/json", body: '{"golden": true, "items": [1, 2, 3]}\n' },
	"/notes.txt": { type: "text/plain", body: Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the golden notes, padded to fifty characters.`).join("\n") },
	"/hop": { status: 302, location: "/article" },
	"/away": { status: 301, location: "https://elsewhere.example/page" },
	"/loop": { status: 302, location: "/loop" },
	"/file.pdf": { type: "application/pdf", body: "%PDF-1.4" },
};

/** A canned response for a golden.example page; every other page is a 404. */
function page(url: string): Response {
	const found = PAGES[new URL(url).pathname];
	if (!found) return new Response("Not here", { status: 404, statusText: "Not Found", headers: { "content-type": "text/plain" } });
	if (found.location) return new Response(null, { status: found.status, headers: { location: found.location } });
	return new Response(found.body, { status: 200, headers: { "content-type": found.type ?? "text/plain" } });
}

/**
 * The worktree tools under GOLDEN_WORKTREE, after every other round (inside a
 * worktree, relative paths and commands move there). golden-requests.mjs makes
 * the project a git repository with a worktree `kept`, a listed worktree
 * `gone` whose directory is deleted, and a branch `dup`. Each round is one
 * dependent step: every early failure; switch into `kept`; the in-session
 * failures; keep it; create `golden`; the two shell guards, a dirty file and a
 * commit; the refused removal; the forced one.
 */
const wt = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_wt_${id}`, name, input });
const WORKTREE_ROUNDS: ToolCall[][] = [
	[wt("load", "tool_search", { query: "select:enter_worktree,exit_worktree" })],
	[
		wt("exit_none", "exit_worktree", { action: "keep" }),
		wt("both", "enter_worktree", { name: "a", path: ".claude/worktrees/kept" }),
		wt("empty_path", "enter_worktree", { path: "" }),
		wt("unlisted", "enter_worktree", { path: "README.md" }),
		wt("gone", "enter_worktree", { path: ".claude/worktrees/gone" }),
		wt("bad_name", "enter_worktree", { name: "bad name" }),
		wt("exists", "enter_worktree", { name: "kept" }),
		wt("git_fails", "enter_worktree", { name: "dup" }),
	],
	[wt("switch", "enter_worktree", { path: ".claude/worktrees/kept" })],
	[wt("remove_foreign", "exit_worktree", { action: "remove" }), wt("again", "enter_worktree", { name: "second" })],
	[wt("keep", "exit_worktree", { action: "keep" })],
	[wt("create", "enter_worktree", { name: "golden" })],
	[
		wt("git_shared", "bash", { command: "git -C ../../.. status" }),
		wt("stash", "bash", { command: "git stash" }),
		wt("dirty", "write", { path: "dirty.txt", content: "dirty\n" }),
		wt("commit", "bash", { command: "git commit --allow-empty -q -m wip" }),
	],
	[wt("remove_dirty", "exit_worktree", { action: "remove" })],
	[wt("remove", "exit_worktree", { action: "remove", discard_changes: true })],
];

/** Added when the user text also says GOLDEN_AGENT: a subagent run (blocking only in one-shot modes). */
const AGENT_CALL: ToolCall = { id: "toolu_golden_7", name: "Agent", input: { description: "Golden check", task: "Reply with OK.", subagent_type: "general-purpose" } };

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const STAGE1_VERDICT = "<severity>60</severity>";
const STAGE2_VERDICT = "<thinking>Golden.</thinking>\n<severity>10</severity>";

/** The classifier's verdict for a classifier request, or undefined for any other request. */
function classifierVerdict(raw: string): string | undefined {
	if (!raw.includes("You are a security monitor")) return undefined;
	return raw.includes("Stage 1 does NOT apply user intent") ? STAGE1_VERDICT : STAGE2_VERDICT;
}

function anthropicReply(calls: ToolCall[] | undefined, text: string): string {
	const withTools = calls !== undefined;
	const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const blocks = withTools
		? calls.flatMap((call, index) => [
				{ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } },
				{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } },
				{ type: "content_block_stop", index },
			])
		: [
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
				{ type: "content_block_stop", index: 0 },
			];
	return sse([
		{ type: "message_start", message: { id: "msg_golden", type: "message", role: "assistant", model: "golden", content: [], stop_reason: null, stop_sequence: null, usage } },
		...blocks,
		{ type: "message_delta", delta: { stop_reason: withTools ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function chatReply(calls: ToolCall[] | undefined, text: string): string {
	const withTools = calls !== undefined;
	const chunk = (delta: object, finish: string | null, extra: object = {}) =>
		`data: ${JSON.stringify({ id: "golden", object: "chat.completion.chunk", created: 0, model: "golden", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
	const body = withTools
		? calls.map((call, index) =>
				chunk({ role: "assistant", tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }, null),
			).join("")
		: chunk({ role: "assistant", content: text }, null);
	const usage = { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
	return `${body}${chunk({}, withTools ? "tool_calls" : "stop", usage)}data: [DONE]\n\n`;
}

/** The rounds a GOLDEN_TOOLS message scripts, from its flags; round n answers the n-th reply's results. */
function roundsFor(text: string): ToolCall[][] {
	const has = (flag: string) => text.includes(flag);
	const tasks = has("GOLDEN_TASKS") ? TASK_ROUNDS : [];
	const rounds: ToolCall[][] = [
		[...TOOL_CALLS, ...ASK_CALLS, ...(has("GOLDEN_NOTEBOOK") ? NOTEBOOK_READS : []), ...(tasks[0] ?? []), ...(has("GOLDEN_AGENT") ? [AGENT_CALL] : [])],
	];
	const later = [has("GOLDEN_NOTEBOOK") ? NOTEBOOK_CALLS : [], ...tasks.slice(1).map(() => [] as ToolCall[])];
	tasks.slice(1).forEach((round, i) => {
		later[i] = [...(later[i] ?? []), ...round];
	});
	for (const round of later) if (round.length > 0) rounds.push(round);
	if (has("GOLDEN_WEB_FETCH")) rounds.push(...WEB_FETCH_ROUNDS);
	if (has("GOLDEN_WORKTREE")) rounds.push(...WORKTREE_ROUNDS);
	return rounds;
}

/**
 * The scripted calls for this request, else undefined. Round 1 answers the
 * GOLDEN_TOOLS user message itself (no assistant reply after it yet); each
 * later round answers the previous round's results (n assistant replies after
 * it, and the newest turn is tool results). Mid-conversation `system`
 * messages may sit anywhere after it, so the search skips them.
 */
function scriptedCalls(messages: Array<{ role?: string; content?: unknown }>): ToolCall[] | undefined {
	const isResults = (m: { role?: string; content?: unknown }) => m.role === "tool" || (m.role === "user" && JSON.stringify(m.content).includes("tool_result"));
	const goldenAt = messages.findLastIndex((m) => m.role === "user" && !isResults(m) && JSON.stringify(m.content).includes("GOLDEN_TOOLS"));
	if (goldenAt < 0 || messages.slice(goldenAt + 1).some((m) => m.role === "user" && !isResults(m))) return undefined;
	const rounds = roundsFor(JSON.stringify(messages[goldenAt].content));
	const after = messages.slice(goldenAt + 1).filter((m) => m.role !== "system");
	const replies = after.filter((m) => m.role === "assistant").length;
	if (replies === 0) return rounds[0];
	const last = after.at(-1);
	return last && isResults(last) ? rounds[replies] : undefined;
}

export default function goldenFixture(_pi: ExtensionAPI) {
	if ((globalThis.fetch as { [WRAPPED]?: true })[WRAPPED]) return;
	const out = process.env.GOLDEN_DUMP;
	if (!out) throw new Error("golden-fixture: set GOLDEN_DUMP to the file the request bodies go to");
	const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const offline = () => new Response("golden fixture: offline", { status: 503 });
		if (new URL(url).hostname === "golden.example") return page(url);
		const raw = init?.body;
		if (typeof raw !== "string") return offline();
		let body: { messages?: unknown };
		try {
			body = JSON.parse(raw);
		} catch {
			return offline();
		}
		if (!Array.isArray(body.messages)) return offline();
		appendFileSync(out, `${JSON.stringify({ url, body })}\n`);
		const anthropic = url.includes("anthropic.com");
		const verdict = classifierVerdict(raw);
		const calls = verdict === undefined ? scriptedCalls(body.messages as Array<{ role?: string; content?: unknown }>) : undefined;
		const text = verdict ?? REPLY_TEXT;
		return new Response(anthropic ? anthropicReply(calls, text) : chatReply(calls, text), {
			status: 200,
			headers: { "content-type": "text/event-stream", ...(anthropic ? { "request-id": "req_golden" } : {}) },
		});
	}) as typeof fetch & { [WRAPPED]?: true };
	wrapped[WRAPPED] = true;
	globalThis.fetch = wrapped;
}
