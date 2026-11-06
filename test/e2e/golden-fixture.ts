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
 * GOLDEN_WEB_FETCH (against canned golden.example pages), web_search under
 * GOLDEN_SEARCH (against canned search backends), the skill tool under
 * GOLDEN_SKILL, the MCP tools under GOLDEN_MCP (golden-mcp-server.mjs),
 * lsp_diagnostics under GOLDEN_LSP (golden-lsp-server.mjs), the hooks under
 * GOLDEN_HOOKS (golden-hook.mjs), MEMORY.md near and over its limit under
 * GOLDEN_MEMORY, the cron tools and schedule_wakeup under GOLDEN_CRON, the
 * monitor and task tools under GOLDEN_MONITOR, the /loop skill under
 * GOLDEN_LOOP, the artifact tool under GOLDEN_ARTIFACT, the file tracker's
 * refusals and change notices under GOLDEN_FILES, a file too large to
 * restore after compaction under GOLDEN_BIGFILE (the session scenario), the
 * workflow tool under GOLDEN_WORKFLOW, auto mode's blocks under
 * GOLDEN_AUTOMODE, the bash guards and background runs under GOLDEN_SHELL
 * and the worktree tools under GOLDEN_WORKTREE after all of them. The auto-mode classifier gets a verdict instead: severity 60
 * at stage 1, so stage 2 runs too, and severity 10 at stage 2, so the call is
 * allowed and the subagent's own requests are recorded. Every other reply is a
 * fixed text shaped like a compaction summary, which serves every turn and
 * side call (session title, compaction) alike. A fetch of a golden.example
 * page or a search backend gets its canned reply (PAGES, searchReply); any other fetch (a catalog refresh, an
 * update check) is refused with a 503, so a run never reaches the network and
 * never depends on what it would have returned.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";

const WRAPPED = Symbol.for("one-code.golden-fixture");

const REPLY_TEXT = "<analysis>Golden.</analysis>\n<summary>Golden summary.</summary>";
type Messages = Array<{ role?: string; content?: unknown }>;
/** A scripted call; an input computed from the conversation so far reads what an earlier result said. */
type ToolCall = { id: string; name: string; input: Record<string, unknown> | ((messages: Messages) => Record<string, unknown>) };

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
		wf("native", { url: "https://golden.example/article", prompt: "native: what does it say?" }),
		wf("native_error", { url: "https://golden.example/article", prompt: "native-error: what does it say?" }),
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
 * web_search under GOLDEN_SEARCH, against canned Brave, Tavily and Exa replies
 * (searchReply): the query's last word picks what each backend does. On an
 * Anthropic session each search first tries the server-side search and then
 * the provider's own search, and both fall back here; the call with both
 * domain lists skips the server-side one.
 */
const ws = (id: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_ws_${id}`, name: "web_search", input });
const SEARCH_ROUNDS: ToolCall[][] = [
	[{ id: "toolu_golden_ws_load", name: "tool_search", input: { query: "select:web_search" } }],
	[
		ws("results", { query: "golden results" }),
		ws("empty", { query: "golden empty" }),
		ws("brave_down", { query: "golden brave-down" }),
		ws("keyless", { query: "golden keyless" }),
		ws("all_down", { query: "golden all-down" }),
		ws("allowed", { query: "golden allowed", allowed_domains: ["golden.example"] }),
		ws("both_filters", { query: "golden filters", allowed_domains: ["golden.example"], blocked_domains: ["elsewhere.example"] }),
		ws("native", { query: "golden native", allowed_domains: ["golden.example"] }),
		ws("native_error", { query: "golden native-error" }),
	],
];

const SEARCH_HITS = [
	{ title: "Golden article", url: "https://golden.example/article", snippet: "The golden article." },
	{ title: "Elsewhere", url: "https://elsewhere.example/page", snippet: "A page on another host." },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A canned search backend reply, by the query's last word: `empty` (Brave has
 * no results), `brave-down` (Brave 401, Tavily answers), `keyless` (both keyed
 * backends 500, Exa answers over SSE), `all-down` (Brave 500, Tavily 401, Exa
 * 429); anything else, Brave answers.
 */
function searchReply(url: string, raw: string | undefined): Response | undefined {
	const host = new URL(url).hostname;
	if (host === "api.search.brave.com") {
		const query = new URL(url).searchParams.get("q") ?? "";
		if (query.includes("brave-down")) return json({ error: "golden: bad key" }, 401);
		if (query.includes("keyless") || query.includes("all-down")) return new Response("golden: brave unavailable", { status: 500 });
		return json({ web: { results: query.includes("empty") ? [] : SEARCH_HITS.map(({ snippet, ...hit }) => ({ ...hit, description: snippet })) } });
	}
	if (host === "api.tavily.com") {
		const query = String((JSON.parse(raw ?? "{}") as { query?: string }).query);
		if (query.includes("all-down")) return json({ detail: "golden: unauthorized" }, 401);
		if (query.includes("keyless")) return new Response("golden: tavily unavailable", { status: 500 });
		return json({ results: SEARCH_HITS.map(({ snippet, ...hit }) => ({ ...hit, content: snippet })) });
	}
	if (host === "mcp.exa.ai") {
		const request = JSON.parse(raw ?? "{}") as { id?: number; params?: { arguments?: { query?: string } } };
		if (String(request.params?.arguments?.query).includes("all-down")) return new Response("golden: slow down", { status: 429 });
		const text = SEARCH_HITS.map((hit) => `Title: ${hit.title}\nURL: ${hit.url}\nHighlights:\n${hit.snippet}`).join("\n---\n");
		const message = { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } };
		return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	return undefined;
}

/**
 * Anthropic's server-side web search or fetch, for a nested call whose
 * question says `native`: a successful search (two hits) or fetch, then a
 * short answer; `native-error` gets the tool's error instead, so the caller
 * falls back. Undefined for any other request.
 */
function serverToolReply(raw: string): string | undefined {
	const body = JSON.parse(raw) as { tools?: Array<{ type?: string }>; messages?: unknown };
	const tool = body.tools?.find((t) => t.type === "web_search_20260209" || t.type === "web_fetch_20260209")?.type;
	const asked = JSON.stringify(body.messages ?? []);
	if (!tool || !asked.includes("native")) return undefined;
	const search = tool.startsWith("web_search");
	const failed = asked.includes("native-error");
	const result = search
		? {
				type: "web_search_tool_result",
				tool_use_id: "srvtoolu_golden",
				content: failed
					? { type: "web_search_tool_result_error", error_code: "too_many_requests" }
					: SEARCH_HITS.map((hit) => ({ type: "web_search_result", title: hit.title, url: hit.url, page_age: "1 day ago" })),
			}
		: {
				type: "web_fetch_tool_result",
				tool_use_id: "srvtoolu_golden",
				content: failed ? { type: "web_fetch_tool_result_error", error_code: "url_not_allowed" } : { type: "web_fetch_result", url: "https://golden.example/article" },
			};
	const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	return sse([
		{ type: "message_start", message: { id: "msg_golden", type: "message", role: "assistant", model: "golden", content: [], stop_reason: null, stop_sequence: null, usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_golden", name: search ? "web_search" : "web_fetch", input: {} } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: result },
		{ type: "content_block_stop", index: 1 },
		{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Golden native answer." } },
		{ type: "content_block_stop", index: 2 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
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

/**
 * The skill tool under GOLDEN_SKILL, against the project skills
 * golden-requests.mjs writes: list, a call that forgot the name, an unknown
 * name, golden-echo with its argument and without (the missing-argument
 * note), and each refusal (manual-only, off, user-only).
 */
const sk = (id: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_skill_${id}`, name: "skill", input });
const SKILL_ROUNDS: ToolCall[][] = [
	[
		sk("list", { list: true }),
		sk("no_name", { args: "golden" }),
		sk("unknown", { skill: "nope" }),
		sk("echo", { skill: "/golden-echo", args: "golden" }),
		sk("echo_bare", { skill: "golden-echo" }),
		sk("manual", { skill: "golden-manual" }),
		sk("off", { skill: "golden-off" }),
		sk("hidden", { skill: "golden-hidden" }),
	],
];

/**
 * The MCP tools under GOLDEN_MCP, against golden-mcp-server.mjs (server
 * `golden`; golden-requests.mjs also configures a server `broken` that exits
 * at once): load them; every result of a connected server (tools, the
 * resource tools, their failures and an unknown server); mutate the tool
 * list; the removed and the changed tool; quit mid-call; a tool and the
 * resource tools after the server is gone.
 */
const mcp = (id: string, name: string, input: Record<string, unknown> = {}): ToolCall => ({ id: `toolu_golden_mcp_${id}`, name, input });
const MCP_ROUNDS: ToolCall[][] = [
	[
		mcp("load", "tool_search", {
			query: "select:mcp__golden__echo,mcp__golden__nodesc,mcp__golden__fail,mcp__golden__mutate,mcp__golden__quit,list_mcp_resources,read_mcp_resource,read_mcp_resource_dir",
		}),
	],
	[
		mcp("echo", "mcp__golden__echo", { text: "golden" }),
		mcp("nodesc", "mcp__golden__nodesc"),
		mcp("fail", "mcp__golden__fail"),
		mcp("list", "list_mcp_resources"),
		mcp("list_unknown", "list_mcp_resources", { server: "nope" }),
		mcp("read", "read_mcp_resource", { server: "golden", uri: "golden://notes" }),
		mcp("read_blob", "read_mcp_resource", { server: "golden", uri: "golden://logo" }),
		mcp("read_missing", "read_mcp_resource", { server: "golden", uri: "golden://missing" }),
		mcp("read_unknown", "read_mcp_resource", { server: "nope", uri: "golden://notes" }),
		mcp("dir", "read_mcp_resource_dir", { server: "golden", uri: "golden://dir" }),
		mcp("dir_empty", "read_mcp_resource_dir", { server: "golden", uri: "golden://empty" }),
		mcp("dir_missing", "read_mcp_resource_dir", { server: "golden", uri: "golden://notes" }),
	],
	[mcp("mutate", "mcp__golden__mutate")],
	[mcp("removed", "mcp__golden__echo", { text: "golden" }), mcp("changed", "mcp__golden__nodesc")],
	[mcp("quit", "mcp__golden__quit")],
	[mcp("gone", "mcp__golden__fail"), mcp("list_gone", "list_mcp_resources"), mcp("read_gone", "read_mcp_resource", { server: "golden", uri: "golden://notes" })],
];

/**
 * The language-server tool under GOLDEN_LSP, against golden-lsp-server.mjs
 * (on PATH as `gopls`): a write that brings new diagnostics, a clean file,
 * then lsp_diagnostics on the file (all and errors only), on the clean file,
 * on a file no server handles, on a Rust file (rust-analyzer runs project
 * code, so it waits for a trust this run never gives) and on a TypeScript
 * file with no TypeScript in the project. One write per round: two writes
 * in one round could split the new-diagnostics block either way.
 */
const ls = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_lsp_${id}`, name, input });
const LSP_ROUNDS: ToolCall[][] = [
	[ls("write", "write", { path: "main.go", content: "package main\n\nfunc main() {\n\tgolden\n}\n" })],
	[ls("write_clean", "write", { path: "clean.go", content: "package clean\n" })],
	[
		ls("load", "tool_search", { query: "select:lsp_diagnostics" }),
	],
	[
		ls("all", "lsp_diagnostics", { path: "main.go" }),
		ls("errors", "lsp_diagnostics", { path: "main.go", severity: "error" }),
		ls("clean", "lsp_diagnostics", { path: "clean.go" }),
		ls("none", "lsp_diagnostics", { path: "README.md" }),
		ls("untrusted", "lsp_diagnostics", { path: "src/lib.rs" }),
		ls("typescript", "lsp_diagnostics", { path: "app.ts" }),
	],
];

/**
 * The hooks under GOLDEN_HOOKS, against golden-hook.mjs (golden-requests.mjs
 * configures it as user-scope hooks): Bash commands whose marker picks the
 * PreToolUse answer (each block reason, the timeout, the output limit, added
 * context) or the PostToolUse one (a block, added context, an empty
 * replacement), then a write the PostToolUse hook rewrites like a formatter.
 */
const hk = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_hook_${id}`, name, input });
const hookCommand = (marker: string) => hk(marker.replace(/-/g, "_"), "bash", { command: `echo ${marker}` });
const HOOK_ROUNDS: ToolCall[][] = [
	["hook-reason", "hook-exit2", "hook-deny", "hook-ask", "hook-halt", "hook-block", "hook-flood", "hook-context", "hook-timeout"].map(hookCommand),
	["hook-post-block", "hook-post-context", "hook-post-empty"].map(hookCommand),
	[hk("format", "write", { path: "hooked.txt", content: "as the model wrote it\n" })],
];

/**
 * The memory index under GOLDEN_MEMORY: MEMORY.md in the project's memory
 * directory written near its load limit (the near-limit reminder), then over
 * it (the over-limit error). One write per round.
 */
const memoryIndex = (lines: number) => () => ({
	path: join(projectMemoryDir(process.cwd()), "MEMORY.md"),
	content: Array.from({ length: lines }, (_, i) => `- [Golden ${i + 1}](golden-${i + 1}.md) — one line`).join("\n"),
});
const MEMORY_ROUNDS: ToolCall[][] = [
	[{ id: "toolu_golden_memory_near", name: "write", input: memoryIndex(185) }],
	[{ id: "toolu_golden_memory_over", name: "write", input: memoryIndex(205) }],
];

/**
 * The cron tools and schedule_wakeup under GOLDEN_CRON: load the cron tools;
 * an unparsable and an impossible expression, a recurring job and a one-shot
 * one; the list and an unknown id; delete both jobs (their ids read from the
 * results); then schedule_wakeup missing each required field, a wakeup (it
 * never fires in a one-shot run), and stop. golden-requests.mjs replaces the
 * random job ids and the wakeup's clock time.
 */
const cr = (id: string, name: string, input: ToolCall["input"]): ToolCall => ({ id: `toolu_golden_cron_${id}`, name, input });
const jobId = (kind: string) => (messages: Messages) => ({ id: new RegExp(`Scheduled ${kind} ([0-9a-f]{8})`).exec(JSON.stringify(messages))?.[1] ?? "missing" });
const CRON_ROUNDS: ToolCall[][] = [
	[cr("load", "tool_search", { query: "select:cron_create,cron_list,cron_delete" })],
	[
		cr("bad", "cron_create", { cron: "bogus", prompt: "golden" }),
		cr("never", "cron_create", { cron: "0 0 31 2 *", prompt: "golden" }),
		cr("hourly", "cron_create", { cron: "7 * * * *", prompt: "Check the golden build." }),
		cr("once", "cron_create", { cron: "3 9 28 12 *", prompt: "Golden reminder\nsecond line", recurring: false }),
	],
	[cr("list", "cron_list", {}), cr("unknown", "cron_delete", { id: "nope" })],
	[cr("delete_hourly", "cron_delete", jobId("recurring job")), cr("delete_once", "cron_delete", jobId("one-shot task"))],
	[
		cr("wake_none", "schedule_wakeup", {}),
		cr("wake_prompt", "schedule_wakeup", { delaySeconds: 600, reason: "golden" }),
		cr("wake_noop", "schedule_wakeup", { delaySeconds: 600, reason: "golden", prompt: "/loop check" }),
	],
	[cr("wake", "schedule_wakeup", { delaySeconds: 30, reason: "golden", prompt: "/loop check", noop: false })],
	[cr("stop", "schedule_wakeup", { stop: true })],
];

/**
 * monitor, task_output and task_stop under GOLDEN_MONITOR. The tools scenario
 * is a one-shot run, so a monitor runs to its end and returns inline: events
 * and an exit, nothing seen, a deadline, the persistent flag a one-shot run
 * cannot honour, a WebSocket URL that cannot open, and neither or both of
 * command and ws; then task_output and task_stop on an unknown id.
 */
const mo = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_monitor_${id}`, name, input });
const MONITOR_ROUNDS: ToolCall[][] = [
	[mo("load", "tool_search", { query: "select:monitor,task_output,task_stop" })],
	[
		mo("events", "monitor", { command: "printf 'one\\ntwo\\n'; exit 3", description: "golden events" }),
		mo("quiet", "monitor", { command: "true", description: "golden quiet" }),
		mo("deadline", "monitor", { command: "sleep 30", description: "golden deadline", timeout_ms: 1000 }),
		mo("persistent", "monitor", { command: "sleep 30", description: "golden persistent", persistent: true, timeout_ms: 1000 }),
		mo("ws_bad", "monitor", { ws: { url: "not a url" }, description: "golden socket" }),
		mo("neither", "monitor", { description: "golden neither" }),
		mo("both", "monitor", { command: "true", ws: { url: "ws://golden.example" }, description: "golden both" }),
		mo("output_unknown", "task_output", { task_id: "nope" }),
		mo("stop_unknown", "task_stop", { task_id: "nope" }),
	],
];

/**
 * The /loop skill's body under GOLDEN_LOOP, in each form: a prompt with an
 * interval, no prompt (self-paced), an interval alone, a trailing "every"
 * clause; then the same no-prompt forms once a loop-tasks file exists. A
 * fire needs time to pass, so the tick texts are not reached here.
 */
const lp = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id: `toolu_golden_loop_${id}`, name, input });
const LOOP_ROUNDS: ToolCall[][] = [
	[
		lp("explicit", "skill", { skill: "loop", args: "check the deploy every 20m" }),
		lp("bare", "skill", { skill: "loop" }),
		lp("interval", "skill", { skill: "loop", args: "5m" }),
		lp("every", "skill", { skill: "loop", args: "every 2 hours" }),
	],
	[lp("tasks", "write", { path: ".claude/loop.md", content: "- golden task one\n- golden task two\n" })],
	[lp("bare_file", "skill", { skill: "loop" }), lp("interval_file", "skill", { skill: "loop", args: "10m" })],
];

/**
 * The artifact tool under GOLDEN_ARTIFACT (golden-requests.mjs sets
 * SSH_CONNECTION, so no browser opens and the result says so): load it; an
 * empty store's list, every publish refusal, an unknown id and a delete with
 * none; publish a page and an empty one; publish the page again (a new
 * version) and list; open the gallery and the page, and a delete this
 * one-shot run cannot confirm. golden-requests.mjs replaces the id's random
 * suffix and the update time.
 */
const ar = (id: string, input: ToolCall["input"], name = "artifact"): ToolCall => ({ id: `toolu_golden_artifact_${id}`, name, input });
const artifactId = (messages: Messages) => /artifact (golden-report-[0-9a-f]{6})/.exec(JSON.stringify(messages))?.[1] ?? "missing";
const ARTIFACT_ROUNDS: ToolCall[][] = [
	[ar("load", { query: "select:artifact" }, "tool_search")],
	[
		ar("page", { path: "golden.html", content: "<!doctype html>\n<title>Golden report</title>\n<p>Golden.</p>\n" }, "write"),
		ar("empty_page", { path: "empty.html", content: "" }, "write"),
		ar("list_empty", { action: "list" }),
		ar("no_path", {}),
		ar("not_html", { file_path: "README.md" }),
		ar("missing", { file_path: "missing.html" }),
		ar("directory", { file_path: ".claude" }),
		ar("unknown", { action: "open", id: "nope" }),
		ar("delete_none", { action: "delete" }),
	],
	[ar("publish", { file_path: "golden.html", description: "A golden page." }), ar("publish_empty", { file_path: "empty.html" })],
	[ar("update", { file_path: "golden.html" })],
	[ar("list", { action: "list" })],
	[ar("gallery", { action: "open" }), ar("open", (messages) => ({ action: "open", id: artifactId(messages) })), ar("delete", (messages) => ({ action: "delete", id: artifactId(messages) }))],
];

/**
 * The file tracker under GOLDEN_FILES: make files with a shell command (so
 * none counts as read); write one unread (refused), read an empty one and a
 * directory; read six more one per round (the order the change notices name
 * them in); change all six with a shell command, which sends five detailed
 * notices (the first with more changed lines than an excerpt shows) and one
 * that lists the rest; edit a changed file without reading it again
 * (refused as stale); and a subagent (GOLDEN_CHILD) that reads and rewrites
 * a file the session read, which the session then hears was changed by it.
 */
const fl = (id: string, name: string, input: ToolCall["input"]): ToolCall => ({ id: `toolu_golden_file_${id}`, name, input });
const MANY = ["m1", "m2", "m3", "m4", "m5"];
const FILE_ROUNDS: ToolCall[][] = [
	[fl("setup", "bash", { command: `mkdir -p ft/dir && printf 'unread\n' > ft/unread.txt && : > ft/empty.txt && seq 1 60 > ft/long.txt && printf 'child\n' > ft/child.txt && for f in ${MANY.join(" ")}; do echo one > ft/$f.txt; done` })],
	[
		fl("unread", "write", { path: "ft/unread.txt", content: "overwritten\n" }),
		fl("empty", "read", { path: "ft/empty.txt" }),
		fl("dir", "read", { path: "ft/dir" }),
		fl("long", "read", { path: "ft/long.txt" }),
		fl("child_read", "read", { path: "ft/child.txt" }),
	],
	...MANY.map((f) => [fl(f, "read", { path: `ft/${f}.txt` })]),
	[fl("change", "bash", { command: `seq 101 160 > ft/long.txt && for f in ${MANY.join(" ")}; do echo two > ft/$f.txt; done` })],
	[fl("stale", "edit", { path: "ft/long.txt", edits: [{ oldText: "101", newText: "one hundred and one" }] })],
	[fl("agent", "Agent", { description: "Golden child write", task: "GOLDEN_TOOLS GOLDEN_CHILD: make the scripted calls.", subagent_type: "general-purpose" })],
];
/** The subagent GOLDEN_FILES starts: read the file, then rewrite it. */
const CHILD_ROUNDS: ToolCall[][] = [[fl("child_own_read", "read", { path: "ft/child.txt" })], [fl("child_write", "write", { path: "ft/child.txt", content: "changed by the child\n" })]];

/**
 * The workflow tool under GOLDEN_WORKFLOW, all in one round (a one-shot run
 * runs each to its end): every refusal before a run starts, a meta that is
 * not a pure literal, a script that breaks the determinism rules, and a run
 * whose agents reply as asked, never call structured_output (the nudge,
 * then the failure), and name an agent type that does not exist.
 * golden-requests.mjs replaces the run id and the run's seconds.
 */
const wkf = (id: string, input: ToolCall["input"]): ToolCall => ({ id: `toolu_golden_workflow_${id}`, name: "workflow", input });
const WORKFLOW_META = "export const meta = { name: 'golden-run', description: 'A golden workflow', phases: [{ title: 'Ask' }] }";
const WORKFLOW_SCRIPT = [
	WORKFLOW_META,
	"phase('Ask')",
	"log('asking')",
	"const plain = await agent('Reply with OK.', { label: 'plain', phase: 'Ask' })",
	"const errors = []",
	"try { await agent('Give the data.', { label: 'shaped', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }) } catch (e) { errors.push(e.message) }",
	"try { await agent('Reply.', { label: 'typed', agentType: 'golden-nope' }) } catch (e) { errors.push(e.message) }",
	"return { plain, errors }",
].join("\n");
const WORKFLOW_ROUNDS: ToolCall[][] = [
	[
		wkf("none", {}),
		wkf("missing_path", { scriptPath: "missing-workflow.js" }),
		wkf("unknown_name", { name: "golden-nope" }),
		wkf("unknown_run", { resumeFromRunId: "wf_0000000000" }),
		wkf("no_meta", { script: "await agent('Reply with OK.')" }),
		wkf("impure_meta", { script: "export const meta = { name: `golden-${1}`, description: 'x' }\nreturn 1" }),
		wkf("random", { script: "export const meta = { name: 'golden-random', description: 'Breaks determinism' }\nreturn Math.random()" }),
		wkf("run", { script: WORKFLOW_SCRIPT }),
	],
];

/**
 * Auto mode under GOLDEN_AUTOMODE, all in one round: shell writes outside
 * the project (so the classifier is asked) that it blocks without a rule, answers without a severity, and blocks
 * under a rule that does not exist (MARKED_VERDICTS), then a write of the
 * project's settings file and a removal whose wildcard can select it, which
 * the safety floor blocks without asking the classifier.
 */
const am = (id: string, name: string, input: ToolCall["input"]): ToolCall => ({ id: `toolu_golden_automode_${id}`, name, input });
const AUTOMODE_ROUNDS: ToolCall[][] = [
	[
		am("block", "bash", { command: "echo golden-classifier-block > ../golden-block.txt" }),
		am("silent", "bash", { command: "echo golden-classifier-silent > ../golden-silent.txt" }),
		am("unknown", "bash", { command: "echo golden-classifier-unknown > ../golden-unknown.txt" }),
		am("floor_write", "write", { path: ".claude/settings.json", content: "{}\n" }),
		am("floor_glob", "bash", { command: "rm -f .claude/settings*.bak" }),
	],
];

/**
 * The permission gate's own refusals under GOLDEN_PERMISSIONS, in one round:
 * a command a user deny rule names (golden-requests.mjs writes
 * `Bash(golden-denied:*)` into the tools scenario's user settings), and a
 * read that names its target in two path fields with different values.
 */
const pm = (id: string, name: string, input: ToolCall["input"]): ToolCall => ({ id: `toolu_golden_permissions_${id}`, name, input });
const PERMISSION_ROUNDS: ToolCall[][] = [
	[pm("rule", "bash", { command: "golden-denied --now" }), pm("conflict", "read", { path: "README.md", file_path: "golden-other.md" })],
];

/**
 * The subagent tools under GOLDEN_SUBAGENTS: an unknown agent type, an
 * unknown model and the spawned-agents list, then a message to a run that
 * does not exist, a message that resumes the round-1 agent (one-shot, so it
 * runs inline) and a fork of this conversation.
 */
const sa = (id: string, name: string, input: ToolCall["input"]): ToolCall => ({ id: `toolu_golden_subagents_${id}`, name, input });
const SUBAGENT_ROUNDS: ToolCall[][] = [
	[
		sa("load", "tool_search", { query: "select:SendMessage" }),
		sa("unknown_type", "Agent", { subagent_type: "golden-nope", task: "Reply with OK." }),
		sa("unknown_model", "Agent", { task: "Reply with OK.", model: "golden-nope-model" }),
		sa("list", "list_agents", {}),
	],
	[
		sa("nobody", "SendMessage", { to: "golden-nobody", message: "Hello." }),
		sa("resume", "SendMessage", { to: "general-purpose-1", message: "Reply with OK again." }),
		sa("fork", "Agent", { subagent_type: "fork", description: "Golden fork", task: "Reply with OK." }),
	],
];

/**
 * The bash guards and background runs under GOLDEN_SHELL, all in one round:
 * a long sleep, chained short sleeps, a polling loop, two ways to detach, an
 * editor, watch, an interactive rebase and add, and two background commands
 * a one-shot run holds to the end, one past its timeout.
 */
const sh = (id: string, input: ToolCall["input"]): ToolCall => ({ id: `toolu_golden_shell_${id}`, name: "bash", input });
const SHELL_ROUNDS: ToolCall[][] = [
	[
		sh("sleep", { command: "sleep 5" }),
		sh("sleeps", { command: "sleep 1 && sleep 1 && echo after" }),
		sh("poll", { command: "while true; do sleep 1; done" }),
		sh("nohup", { command: "nohup true" }),
		sh("amp", { command: "true &" }),
		sh("editor", { command: "vim golden.txt" }),
		sh("watch", { command: "watch ls" }),
		sh("rebase", { command: "git rebase -i HEAD~1" }),
		sh("add", { command: "git add -p" }),
		sh("bg", { command: "echo golden-bg", run_in_background: true, description: "golden background" }),
		sh("bg_timeout", { command: "sleep 3", run_in_background: true, timeout: 1000, description: "golden deadline" }),
	],
];

/**
 * Tool results under GOLDEN_RESULTS: a shell output past the inline cap (the
 * persisted-output block) and a find that matches nothing.
 */
const RESULT_ROUNDS: ToolCall[][] = [
	[
		{ id: "toolu_golden_result_large", name: "bash", input: { command: "seq 1 20000" } },
		{ id: "toolu_golden_result_find", name: "find", input: { pattern: "*.golden-none" } },
	],
];

/**
 * tool_search under GOLDEN_TOOLSEARCH: a deferred tool called before it is
 * loaded (the miss reminder), and a select of a loaded tool with a name that
 * is not deferred (already loaded, plus the not-found note).
 */
const TOOLSEARCH_ROUNDS: ToolCall[][] = [
	[
		{ id: "toolu_golden_ts_miss", name: "enter_plan_mode", input: {} },
		{ id: "toolu_golden_ts_select", name: "tool_search", input: { query: "select:web_fetch,golden_nope" } },
	],
];

/**
 * GOLDEN_DENY (the session scenario, before its first compaction): a read
 * outside the project, whose first-outside-read prompt the runner cancels, so
 * the model hears the user declined it.
 */
const DENY_ROUNDS: ToolCall[][] = [[{ id: "toolu_golden_deny", name: "read", input: { path: "../golden-outside-read.md" } }]];

/**
 * GOLDEN_BIGFILE (the session scenario, before its first compaction): make a
 * file past the restore's per-file cap and read it, so the restore sends the
 * note in place of its contents.
 */
const BIGFILE_ROUNDS: ToolCall[][] = [
	[fl("big_make", "bash", { command: "yes 'golden padding line for the restore cap' | head -600 > big.txt" })],
	[fl("big_read", "read", { path: "big.txt" })],
];

/**
 * Plan mode under GOLDEN_PLAN, on its own (the session scenario's last
 * prompt): load the tools, exit before entering, enter, run a command plan
 * mode blocks, exit with an empty plan, write the plan to the file
 * enter_plan_mode named, and exit for approval (golden-requests.mjs approves the plan dialog).
 */
const pc = (id: string, name: string, input: ToolCall["input"] = {}): ToolCall => ({ id: `toolu_golden_plan_${id}`, name, input });
const planFile = (messages: Messages) => /Your plan file is (\S+), the one file/.exec(JSON.stringify(messages))?.[1] ?? "plan.md";
const PLAN_ROUNDS: ToolCall[][] = [
	[pc("load", "tool_search", { query: "select:enter_plan_mode,exit_plan_mode" })],
	[pc("exit_early", "exit_plan_mode")],
	[pc("enter", "enter_plan_mode")],
	[pc("blocked", "bash", { command: "touch golden-plan-blocked.txt" })],
	[pc("exit_empty", "exit_plan_mode")],
	[pc("write", "write", (messages) => ({ path: planFile(messages), content: "# Golden plan\n\nRead the README, then reply OK.\n" }))],
	[pc("exit", "exit_plan_mode")],
];

/**
 * GOLDEN_OVERFLOW (the session scenario's last prompt): the first request
 * that ends on that prompt is refused as too long for the context window, in
 * the provider's own words, so pi compacts for the overflow and retries.
 */
let overflowSent = false;
function overflowReply(messages: Messages, anthropic: boolean): Response | undefined {
	const last = messages.findLast((m) => m.role !== "system");
	if (overflowSent || last?.role !== "user" || !JSON.stringify(last.content).includes("GOLDEN_OVERFLOW")) return undefined;
	overflowSent = true;
	const error = anthropic
		? { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 213462 tokens > 200000 maximum" } }
		: { error: { message: "This endpoint's maximum context length is 200000 tokens. However, you requested about 213462 tokens.", code: 400 } };
	return new Response(JSON.stringify(error), { status: 400, headers: { "content-type": "application/json", ...(anthropic ? { "request-id": "req_golden" } : {}) } });
}

/** Added when the user text also says GOLDEN_AGENT: a subagent run (blocking only in one-shot modes). */
const AGENT_CALL: ToolCall = { id: "toolu_golden_7", name: "Agent", input: { description: "Golden check", task: "Reply with OK.", subagent_type: "general-purpose" } };

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const STAGE1_VERDICT = "<severity>60</severity>";
const STAGE2_VERDICT = "<thinking>Golden.</thinking>\n<severity>10</severity>";

/** Stage 2's verdict for an action that carries a GOLDEN_AUTOMODE marker (AUTOMODE_ROUNDS). */
const MARKED_VERDICTS: Record<string, string> = {
	"golden-classifier-block": "<thinking>Golden.</thinking>\n<severity>90</severity>",
	"golden-classifier-silent": "Golden.",
	"golden-classifier-unknown": "<thinking>Golden.</thinking>\n<severity>90</severity>\n<category>Golden Nope</category>",
};

/**
 * The classifier's verdict for a classifier request, or undefined for any
 * other request. Only the action under review (the transcript's last entry,
 * just before `</transcript>`) is checked for a marker, since every later
 * classifier request carries earlier calls in its transcript.
 */
function classifierVerdict(raw: string): string | undefined {
	if (!raw.includes("You are a security monitor")) return undefined;
	if (raw.includes("Stage 1 does NOT apply user intent")) return STAGE1_VERDICT;
	const end = raw.lastIndexOf("</transcript>");
	const action = end < 0 ? "" : raw.slice(raw.lastIndexOf("\\n{", end), end);
	const marker = Object.keys(MARKED_VERDICTS).find((key) => action.includes(key));
	return marker ? MARKED_VERDICTS[marker] : STAGE2_VERDICT;
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

/**
 * The instruction files a read attaches, under GOLDEN_INSTRUCTIONS
 * (golden-requests.mjs writeInstructionFiles): a file in `sub/` brings the
 * nested CLAUDE.md, and a Go file there the path-conditional rule as well.
 */
const ins = (id: string, path: string): ToolCall => ({ id: `toolu_golden_instructions_${id}`, name: "read", input: { path } });
const INSTRUCTION_ROUNDS: ToolCall[][] = [[ins("nested", "sub/notes.txt")], [ins("conditional", "sub/code.go")]];

/** The rounds a GOLDEN_TOOLS message scripts, from its flags; round n answers the n-th reply's results. */
function roundsFor(text: string): ToolCall[][] {
	const has = (flag: string) => text.includes(flag);
	if (has("GOLDEN_PLAN")) return PLAN_ROUNDS;
	if (has("GOLDEN_CHILD")) return CHILD_ROUNDS;
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
	if (has("GOLDEN_SEARCH")) rounds.push(...SEARCH_ROUNDS);
	if (has("GOLDEN_SKILL")) rounds.push(...SKILL_ROUNDS);
	if (has("GOLDEN_MCP")) rounds.push(...MCP_ROUNDS);
	if (has("GOLDEN_LSP")) rounds.push(...LSP_ROUNDS);
	if (has("GOLDEN_HOOKS")) rounds.push(...HOOK_ROUNDS);
	if (has("GOLDEN_MEMORY")) rounds.push(...MEMORY_ROUNDS);
	if (has("GOLDEN_CRON")) rounds.push(...CRON_ROUNDS);
	if (has("GOLDEN_MONITOR")) rounds.push(...MONITOR_ROUNDS);
	if (has("GOLDEN_LOOP")) rounds.push(...LOOP_ROUNDS);
	if (has("GOLDEN_ARTIFACT")) rounds.push(...ARTIFACT_ROUNDS);
	if (has("GOLDEN_FILES")) rounds.push(...FILE_ROUNDS);
	if (has("GOLDEN_WORKFLOW")) rounds.push(...WORKFLOW_ROUNDS);
	if (has("GOLDEN_AUTOMODE")) rounds.push(...AUTOMODE_ROUNDS);
	if (has("GOLDEN_PERMISSIONS")) rounds.push(...PERMISSION_ROUNDS);
	if (has("GOLDEN_SUBAGENTS")) rounds.push(...SUBAGENT_ROUNDS);
	if (has("GOLDEN_SHELL")) rounds.push(...SHELL_ROUNDS);
	if (has("GOLDEN_RESULTS")) rounds.push(...RESULT_ROUNDS);
	if (has("GOLDEN_TOOLSEARCH")) rounds.push(...TOOLSEARCH_ROUNDS);
	if (has("GOLDEN_DENY")) rounds.push(...DENY_ROUNDS);
	if (has("GOLDEN_BIGFILE")) rounds.push(...BIGFILE_ROUNDS);
	if (has("GOLDEN_INSTRUCTIONS")) rounds.push(...INSTRUCTION_ROUNDS);
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
function scriptedCalls(messages: Messages): ToolCall[] | undefined {
	const round = scriptedRound(messages);
	return round?.map((call) => (typeof call.input === "function" ? { ...call, input: call.input(messages) } : call));
}

function scriptedRound(messages: Messages): ToolCall[] | undefined {
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
		const search = searchReply(url, typeof raw === "string" ? raw : undefined);
		if (search) return search;
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
		const overflow = overflowReply(body.messages as Messages, anthropic);
		if (overflow) return overflow;
		const server = anthropic ? serverToolReply(raw) : undefined;
		if (server) return new Response(server, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_golden" } });
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
