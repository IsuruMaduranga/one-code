import { describe, expect, it } from "vitest";
import {
	BLOCK_HEADS,
	branchUsage,
	breakdownRequest,
	contextGrid,
	type ContextUsage,
	contextUsage,
	formatContextPercent,
	formatContextTokens,
	gridSize,
	harnessSegments,
	scaleToSum,
} from "../../extensions/lib/context/context-usage.ts";
import { contextText } from "../../extensions/lib/context/context-text.ts";
import { contextReport, renderContextUsage } from "../../extensions/lib/ui/context-usage-view.ts";
import { visibleWidth } from "../../extensions/lib/ui/text-width.ts";
import { estimateTextTokens } from "../../extensions/lib/models/pi-ai-estimate.ts";
import { toolSearchResultText } from "../../extensions/lib/request/tool-search-text.ts";
import { skillResultText } from "../../extensions/tools/skill/text.ts";
import { mcpResultText } from "../../extensions/tools/mcp/text.ts";
import { subagentResultWords } from "../../extensions/lib/agents/subagent-text.ts";

const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `The ${name} tool.`, input_schema: { type: "object", properties: { x: { type: "string" } } }, ...extra });

const MEMORY = reminder(
	[
		"Codebase and user instructions are shown below. Be sure to adhere to these instructions.",
		"",
		"Contents of /home/u/.claude/CLAUDE.md (user's private global instructions for all projects):",
		"",
		"Global rule one.",
		"",
		"Contents of /proj/CLAUDE.md (project instructions, checked into the codebase):",
		"",
		"Project rule one. Project rule two, which is longer than the first.",
	].join("\n"),
);
const SKILLS = reminder(`${BLOCK_HEADS.skills}\n\n- simplify: Review the changed code.\n- plugin:deploy: Ship it to production with every check that the release needs.`);
const MCP_INSTRUCTIONS = reminder(`${BLOCK_HEADS.mcpInstructions}\n\nThe following MCP servers have provided instructions:\n\n## docs\nUse docs carefully.`);
const DEFERRED = reminder(`${toolSearchResultText.listingHead}\nweb_fetch: When you read a page, use it.\nmcp__docs__search\nmcp__docs__fetch\n\nWhen the step in front of you needs one, load it.`);
const AGENTS = reminder(`${BLOCK_HEADS.agents}\n- explore: Fast search.`);
const ENVIRONMENT = reminder("# Environment\nPrimary working directory: /proj");

/** An Anthropic request with every category in it. */
function fullRequest() {
	return {
		api: "anthropic-messages",
		head: {
			model: "m",
			system: [{ type: "text", text: "You are One Code. ".repeat(40), cache_control: { type: "ephemeral" } }],
			tools: [tool("read"), tool("bash"), tool("mcp__docs__eager"), tool("mcp__docs__search", { defer_loading: true }), tool("mcp__docs__fetch", { defer_loading: true })],
		},
		list: [
			{
				role: "user",
				content: [
					{ type: "text", text: MEMORY },
					{ type: "text", text: SKILLS },
					{ type: "text", text: MCP_INSTRUCTIONS },
					{ type: "text", text: DEFERRED },
					{ type: "text", text: AGENTS },
					{ type: "text", text: ENVIRONMENT },
					{ type: "text", text: "Please read the README." },
				],
			},
			{ role: "assistant", content: [{ type: "thinking", thinking: "Let me look.", signature: "x".repeat(500) }, { type: "tool_use", id: "t1", name: "read", input: { path: "README.md" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "mcp__docs__fetch" }] }] },
		],
	};
}

describe("breakdownRequest", () => {
	it("counts the listing a session without the skill tool gets as Skills", () => {
		const listing = skillResultText.readableListing({ lines: ["- simplify: Review the changed code. (/s/simplify/SKILL.md)"], reader: "read" });
		const out = breakdownRequest({ api: "anthropic-messages", head: { model: "m" }, list: [{ role: "user", content: [{ type: "text", text: reminder(listing) }, { type: "text", text: "hi" }] }] });
		expect(out.tokens.skills).toBe(estimateTextTokens(listing));
		expect(out.skills.map((item) => item.name)).toEqual(["simplify"]);
	});

	it("counts a reply or a tool result that only looks like a harness block as Messages", () => {
		const lookalike = ["Contents of /proj/notes.md (my notes):", "", BLOCK_HEADS.instructions, "", BLOCK_HEADS.skills, "- simplify: x"].join("\n");
		const base = fullRequest();
		const withLookalikes = {
			...base,
			list: [
				...base.list,
				{ role: "assistant", content: [{ type: "text", text: lookalike }] },
				// pi's own message list (an estimate of a request not yet sent) keeps a tool result's text at the top level.
				{ role: "toolResult", toolCallId: "t2", toolName: "read", content: [{ type: "text", text: lookalike }] },
			],
		};
		const before = breakdownRequest(base).tokens;
		const after = breakdownRequest(withLookalikes).tokens;
		expect(after.memory).toBe(before.memory);
		expect(after.skills).toBe(before.skills);
		expect(after.messages).toBeGreaterThanOrEqual(before.messages + 2 * estimateTextTokens(lookalike));
	});

	it("does not count pi's thinking and text signatures", () => {
		const base = fullRequest();
		const signed = (signature: string) => ({
			...base,
			list: [...base.list, { role: "assistant", content: [{ type: "thinking", thinking: "Hm.", thinkingSignature: signature }, { type: "text", text: "Done.", textSignature: signature }] }],
		});
		expect(breakdownRequest(signed("x".repeat(20_000))).tokens.messages).toBe(breakdownRequest(signed("x")).tokens.messages);
	});

	it("puts every part of the request in its category", () => {
		const request = fullRequest();
		const out = breakdownRequest(request, { displayPath: (path) => path.replace("/proj/", "") });
		const t = out.tokens;
		expect(t.systemPrompt).toBe(Math.ceil((request.head.system[0].text.length) / 3.5) + estimateTextTokens(ENVIRONMENT));
		expect(t.mcpInstructions).toBe(estimateTextTokens(MCP_INSTRUCTIONS.slice("<system-reminder>\n".length, -"\n</system-reminder>".length)));
		for (const key of ["systemTools", "mcpTools", "memory", "skills", "messages"] as const) expect(t[key]).toBeGreaterThan(0);
		// The memory block's files, by section, with the display path applied.
		expect(out.memoryFiles.map((file) => file.name)).toEqual(["/home/u/.claude/CLAUDE.md", "CLAUDE.md"]);
		// Each with its type, by the section's descriptor.
		expect(out.memoryFiles.map((file) => file.group)).toEqual(["User", "Project"]);
		// Skills by size, a plugin skill's full name kept.
		expect(out.skills.map((skill) => skill.name)).toEqual(["plugin:deploy", "simplify"]);
		// Loaded: the eager MCP tool and the one a tool_reference loaded; available: the deferred one not loaded.
		expect(out.mcpLoaded.map((item) => item.name)).toEqual(["mcp__docs__eager", "mcp__docs__fetch"]);
		expect(out.mcpAvailable).toEqual(["mcp__docs__search"]);
	});

	it("counts a custom agent's row as Custom agents and a built-in one as System tools", () => {
		const listing = `${BLOCK_HEADS.agents}\n- explore: Fast search.\n- reviewer: Reviews code\n- caveat: a bullet in its description.\n- pr:checker: Checks pull requests.\n\n<example>\nA pull request.\n</example>\n\n<example>One line.</example>\n- fork: clone this conversation.\n\nWhen you launch multiple agents, send them together.`;
		const request = { api: "anthropic-messages", head: { model: "m" }, list: [{ role: "user", content: [{ type: "text", text: reminder(listing) }] }] };
		const plain = breakdownRequest(request);
		expect(plain.tokens.agents).toBe(0);
		expect(plain.agents).toEqual([]);
		const out = breakdownRequest(request, { agentGroups: new Map([["explore", undefined], ["reviewer", "Project"], ["pr:checker", "Plugin (pr)"], ["fork", undefined]]) });
		const row = (text: string) => estimateTextTokens(text);
		// A description's `- x: ` bullet, blank lines and examples stay in its row; the next catalog row and the note after the last blank line do not.
		const reviewer = row("- reviewer: Reviews code") + row("- caveat: a bullet in its description.");
		const checker = ["- pr:checker: Checks pull requests.", "", "<example>", "A pull request.", "</example>", "", "<example>One line.</example>"].reduce((sum, line) => sum + row(line), 0);
		// Largest first.
		expect(out.agents).toEqual([
			{ name: "pr:checker", tokens: checker, group: "Plugin (pr)" },
			{ name: "reviewer", tokens: reviewer, group: "Project" },
		]);
		expect(out.tokens.agents).toBe(reviewer + checker);
		// The rest of the listing (its head, the built-in row and the note) stays System tools.
		expect(out.tokens.systemTools).toBe(plain.tokens.systemTools - out.tokens.agents);
		// A second listing in the same request counts its own rows once.
		const twice = breakdownRequest({ ...request, list: [...request.list, ...request.list] }, { agentGroups: new Map([["explore", undefined], ["reviewer", "Project"], ["pr:checker", "Plugin (pr)"], ["fork", undefined]]) });
		expect(twice.tokens.agents).toBe(2 * out.tokens.agents);
		expect(twice.agents.map((item) => [item.name, item.tokens])).toEqual(out.agents.map((item) => [item.name, 2 * item.tokens]));
	});

	it("types a product's own instruction file by where it sits", () => {
		const block = [BLOCK_HEADS.instructions, "", "Contents of /home/u/.onecode/ONECODE.md (product words for every project):", "", "a", "", "Contents of /proj/ONECODE.md (product words for this project):", "", "b"].join("\n");
		const request = { api: "anthropic-messages", head: { model: "m" }, list: [{ role: "user", content: [{ type: "text", text: reminder(block) }] }] };
		const out = breakdownRequest(request, { displayPath: (path) => path.replace("/home/u", "~").replace("/proj/", "") });
		expect(out.memoryFiles.map((file) => [file.name, file.group])).toEqual([["~/.onecode/ONECODE.md", "User"], ["ONECODE.md", "Project"]]);
	});

	it("counts a deferred tool's schema only once it is loaded", () => {
		const request = fullRequest();
		const withoutLoad = { ...request, list: request.list.slice(0, 2) };
		const loaded = breakdownRequest(request).tokens.mcpTools;
		const notLoaded = breakdownRequest(withoutLoad).tokens.mcpTools;
		expect(loaded - notLoaded).toBe(estimateTextTokens(JSON.stringify(tool("mcp__docs__fetch", { defer_loading: true }))));
	});

	it("reads the system prompt from an OpenAI-style system message, and the stack from the first user message", () => {
		const out = breakdownRequest({
			api: "openai-completions",
			head: { model: "m", tools: [{ type: "function", function: { name: "read", parameters: {} } }] },
			list: [
				{ role: "system", content: "You are One Code." },
				{ role: "user", content: [{ type: "text", text: ENVIRONMENT }, { type: "text", text: SKILLS }, { type: "text", text: "hello" }] },
			],
		});
		expect(out.tokens.systemPrompt).toBe(estimateTextTokens("You are One Code.") + estimateTextTokens(ENVIRONMENT));
		expect(out.tokens.skills).toBeGreaterThan(0);
		expect(out.tokens.messages).toBe(estimateTextTokens("hello"));
		expect(out.tokens.systemTools).toBeGreaterThan(0);
	});

	it("reads a Responses body's instructions and its declared tools item", () => {
		const out = breakdownRequest({
			api: "openai-responses",
			head: { model: "m", instructions: "Be brief." },
			list: [
				{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "mcp__s__t", parameters: {} }] },
				{ role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ type: "function_call", call_id: "c", name: "read", arguments: '{"path":"a"}' },
			],
		});
		expect(out.tokens.systemPrompt).toBe(estimateTextTokens("Be brief."));
		expect(out.mcpLoaded.map((item) => item.name)).toEqual(["mcp__s__t"]);
		expect(out.tokens.messages).toBeGreaterThan(estimateTextTokens("hi"));
	});

	it("splits the blocks merged into one system message, a blank line apart", () => {
		const inner = (framed: string) => framed.slice("<system-reminder>\n".length, -"\n</system-reminder>".length);
		const environment = inner(ENVIRONMENT);
		const deferred = inner(DEFERRED);
		const agents = inner(AGENTS);
		const skills = inner(SKILLS);
		const total = "<total_tokens>15000000 tokens left</total_tokens>";
		const merged = [environment, deferred, agents, skills, total].join("\n\n");
		expect(harnessSegments(merged).map((segment) => segment.kind)).toEqual([undefined, "deferred", "agents", "skills", undefined]);
		const out = breakdownRequest({ api: "anthropic-messages", head: { system: "S" }, list: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: merged }] }] });
		expect(out.skills.map((skill) => skill.name)).toEqual(["plugin:deploy", "simplify"]);
		expect(out.mcpAvailable).toEqual(["mcp__docs__fetch", "mcp__docs__search"]);
		expect(out.tokens.skills).toBe(estimateTextTokens(`${skills}`));
		expect(out.tokens.messages).toBe(estimateTextTokens("hi"));
		// The environment and the tag around the blocks are session context.
		expect(out.tokens.systemPrompt).toBe(estimateTextTokens("S") + estimateTextTokens(`${environment}\n\n`) + estimateTextTokens(`\n\n${total}`));
	});

	it("ends the skills listing at its last row when untagged text follows it", () => {
		const skills = `${BLOCK_HEADS.skills}\n\n- a: one\n- b: two`;
		const segments = harnessSegments(`${skills}\n\nAuto mode note follows.`);
		expect(segments).toEqual([{ kind: "skills", text: skills }, { text: "\n\nAuto mode note follows." }]);
	});

	it("keeps a tag inside an instruction file in that file", () => {
		const body = `${BLOCK_HEADS.instructions}\n\nContents of /p/CLAUDE.md (project instructions, checked into the codebase):\n\nUse this:\n\n<example>x</example>`;
		expect(harnessSegments(body)).toEqual([{ kind: "memory", text: body }]);
	});
});

describe("the block heads match the words the base sends", () => {
	it("skills, MCP instructions, agents, instruction files and the deferred listing", () => {
		expect(contextText({} as never, {} as never).instructionsPreamble.startsWith(BLOCK_HEADS.instructions)).toBe(true);
		expect(skillResultText.listingHeader).toBe(BLOCK_HEADS.skills);
		for (const reader of ["read", "shell"] as const) expect(skillResultText.readableListing({ lines: ["- a: b (/s/a/SKILL.md)"], reader }).startsWith(BLOCK_HEADS.readableSkills)).toBe(true);
		expect(mcpResultText.instructions([]).startsWith(BLOCK_HEADS.mcpInstructions)).toBe(true);
		const words = subagentResultWords({} as never, {} as never);
		expect(words.catalogBlock({ rows: [] }).startsWith(BLOCK_HEADS.agents)).toBe(true);
	});
});

const MODEL = { name: "Opus 5.5", id: "claude-opus-5-5" };

describe("contextUsage", () => {
	const breakdown = () => breakdownRequest(fullRequest());

	it("scales the rows to the provider's count, so they add up to the total shown", () => {
		const b = breakdown();
		const estimate = Object.values(b.tokens).reduce((a, c) => a + c, 0);
		const prompt = Math.round(estimate * 1.3);
		const usage = contextUsage({ model: MODEL, window: 200_000, compaction: { enabled: true, reserveTokens: 16_384 }, breakdown: b, reported: { prompt, total: prompt + 250 } });
		const rows = usage.categories.reduce((a, c) => a + c.tokens, 0);
		expect(usage.state).toBe("measured");
		expect(usage.total).toBe(prompt + 250);
		expect(rows).toBe(usage.total);
		// The reply and what came since are messages.
		expect(usage.categories.find((c) => c.key === "messages")!.tokens).toBeGreaterThanOrEqual(250);
		expect(usage.total! + usage.free! + usage.buffer).toBe(200_000);
		expect(usage.unreconciled).toBeUndefined();
	});

	it("keeps the estimates and says so when the provider's count is implausible", () => {
		const usage = contextUsage({ model: MODEL, window: 200_000, breakdown: breakdown(), reported: { prompt: 10, total: 11 } });
		expect(usage.unreconciled).toBe(10);
		expect(usage.total).toBe(11);
		expect(renderContextUsage(usage, { width: 100 }).join("\n")).toContain("Rows are estimates: the provider counted 10 tokens for the last request.");
	});

	it("uses the estimate as the total when the provider reported nothing", () => {
		const b = breakdown();
		const usage = contextUsage({ model: MODEL, window: 200_000, breakdown: b });
		expect(usage.total).toBe(Object.values(b.tokens).reduce((a, c) => a + c, 0));
		expect(usage.buffer).toBe(0);
	});

	it("an empty session shows the window and nothing measured", () => {
		const usage = contextUsage({ model: MODEL, window: 1_000_000, compaction: { enabled: true, reserveTokens: 33_000 } });
		expect(usage).toMatchObject({ state: "empty", categories: [], buffer: 33_000 });
		expect(usage.total).toBeUndefined();
		const cells = contextGrid(usage, false).flat();
		expect(cells.filter((c) => c.kind === "buffer")).toHaveLength(7);
		expect(cells.filter((c) => c.kind === "free")).toHaveLength(193);
		const text = renderContextUsage(usage, { width: 100 }).join("\n");
		expect(text).toContain("?/1m tokens");
		expect(text).toContain("Nothing sent yet in this session");
		expect(text).not.toContain("Free space");
	});

	it("a session past a compaction is not measured until the next reply", () => {
		const reply = { type: "message", message: { role: "assistant", stopReason: "stop", usage: { input: 100, cacheRead: 900, cacheWrite: 50, output: 20 } } };
		expect(branchUsage([reply])).toEqual({ prompt: 1050, compacted: false });
		expect(branchUsage([reply, { type: "compaction" }]).compacted).toBe(true);
		const aborted = { type: "message", message: { role: "assistant", stopReason: "aborted", usage: { input: 5 } } };
		expect(branchUsage([reply, { type: "compaction" }, aborted]).compacted).toBe(true);
		expect(branchUsage([reply, { type: "compaction" }, reply]).compacted).toBe(false);
		// Without an estimate of the next request, nothing is measured.
		const usage = contextUsage({ model: MODEL, window: 200_000, compacted: true });
		expect(usage.state).toBe("compacted");
		expect(renderContextUsage(usage, { width: 100 }).join("\n")).toContain("Compacted since the last request");
		// With one, it is shown and marked as an estimate of the next request.
		const next = contextUsage({ model: MODEL, window: 200_000, breakdown: breakdown(), compacted: true, preview: "compaction" });
		expect(next.state).toBe("measured");
		expect(renderContextUsage(next, { width: 100 }).join("\n")).toContain("nothing sent since the compaction.");
	});

	it("a small window takes Claude Code's 10 by 10 grid, 5 by 5 when narrow", () => {
		expect(gridSize(200_000, false)).toEqual({ columns: 10, rows: 10 });
		expect(gridSize(200_000, true)).toEqual({ columns: 5, rows: 5 });
		expect(gridSize(1_000_000, false)).toEqual({ columns: 20, rows: 10 });
		expect(gridSize(1_000_000, true)).toEqual({ columns: 5, rows: 10 });
		const usage = contextUsage({ model: MODEL, window: 32_000, compaction: { enabled: true, reserveTokens: 16_384 }, breakdown: breakdown() });
		const grid = contextGrid(usage, false);
		expect(grid).toHaveLength(10);
		expect(grid.every((row) => row.length === 10)).toBe(true);
		expect(grid.flat().filter((c) => c.kind === "buffer")).toHaveLength(51);
	});

	it("never lets the used share overflow the grid or go below zero free", () => {
		const b = breakdown();
		const usage = contextUsage({ model: MODEL, window: 1000, compaction: { enabled: true, reserveTokens: 400 }, breakdown: b });
		expect(usage.free).toBe(0);
		expect(contextGrid(usage, false).flat()).toHaveLength(100);
	});
});

describe("rounding", () => {
	it("scaleToSum hits the target exactly", () => {
		expect(scaleToSum([1, 1, 1], 10).reduce((a, b) => a + b, 0)).toBe(10);
		expect(scaleToSum([2500, 9700, 592, 1800, 2200], 16_700).reduce((a, b) => a + b, 0)).toBe(16_700);
		expect(scaleToSum([0, 0], 5)).toEqual([0, 0]);
	});

	it("formats tokens and percentages as Claude Code 2.1.330 prints them", () => {
		expect([592, 2500, 9700, 16_700, 33_000, 950_300, 1_000_000].map(formatContextTokens)).toEqual(["592", "2.5k", "9.7k", "16.7k", "33k", "950.3k", "1m"]);
		const window = 1_000_000;
		expect([2400, 9700, 592, 1800, 2200, 950_300, 33_000].map((t) => formatContextPercent(t, window))).toEqual(["0.2", "1", "0.1", "0.2", "0.2", "95", "3"]);
	});
});

/** Claude Code's own numbers from cc-05-context-top.txt, as a ContextUsage. */
function ccUsage(): ContextUsage {
	const rows = [
		["systemPrompt", "System prompt", 2450],
		["systemTools", "System tools", 9700],
		["mcpTools", "MCP tools", 592],
		["mcpInstructions", "MCP server instructions", 1800],
		["skills", "Skills", 2200],
	] as const;
	return {
		model: MODEL,
		window: 1_000_000,
		state: "measured",
		total: 16_700,
		categories: rows.map(([key, name, tokens]) => ({ key, name, tokens })),
		buffer: 33_000,
		free: 950_300,
		memoryFiles: [],
		agents: [],
		skills: [
			{ name: "dataviz", tokens: 482 },
			{ name: "init", tokens: 17 },
		],
		mcp: {
			loaded: [
				{ name: "mcp__claude_ai_Claude_Docs__batch", tokens: 134 },
				{ name: "mcp__claude_ai_Claude_Docs__guide", tokens: 170 },
			],
			available: ["mcp__claude_ai_Asana__authenticate", "mcp__claude_ai_Slack__complete_authentication"],
		},
	};
}

describe("contextReport", () => {
	it("gives the model Claude Code's Markdown report, whatever the screen shows", () => {
		const usage = {
			...ccUsage(),
			agents: [{ name: "pr:checker", tokens: 200, group: "Plugin (pr)" }],
			memoryFiles: [{ name: "CLAUDE.md", tokens: 1200, group: "Project" }],
			skills: [{ name: "dataviz", tokens: 482 }, { name: "plugin:deploy", tokens: 17 }],
		};
		expect(contextReport(usage)).toBe(
			[
				"## Context Usage",
				"",
				`**Model:** ${MODEL.id}  `,
				"**Tokens:** 16.7k / 1m (2%)",
				"",
				"### Estimated usage by category",
				"",
				"| Category | Tokens | Percentage |",
				"|----------|--------|------------|",
				"| System prompt | 2.5k | 0.2% |",
				"| System tools | 9.7k | 1.0% |",
				"| MCP tools | 592 | 0.1% |",
				"| MCP server instructions | 1.8k | 0.2% |",
				"| Skills | 2.2k | 0.2% |",
				"| Free space | 950.3k | 95.0% |",
				"| Autocompact buffer | 33k | 3.3% |",
				"",
				"### MCP Tools",
				"",
				"| Tool | Server | Tokens |",
				"|------|--------|--------|",
				"| mcp__claude_ai_Claude_Docs__batch | claude_ai_Claude_Docs | 134 |",
				"| mcp__claude_ai_Claude_Docs__guide | claude_ai_Claude_Docs | 170 |",
				"",
				"### Other MCP tools, by server",
				"",
				"| Server | Tools |",
				"|--------|-------|",
				"| claude_ai_Asana | 1 |",
				"| claude_ai_Slack | 1 |",
				"",
				"### Custom Agents",
				"",
				"| Agent Type | Source | Tokens |",
				"|------------|--------|--------|",
				"| pr:checker | Plugin | 200 |",
				"",
				"### Memory Files",
				"",
				"| Type | Path | Tokens |",
				"|------|------|--------|",
				"| Project | CLAUDE.md | 1.2k |",
				"",
				"### Skills",
				"",
				"| Skill | Source | Tokens |",
				"|-------|--------|--------|",
				"| dataviz |  | ~480 |",
				"| plugin:deploy | Plugin (plugin) | < 20 |",
				"",
				"",
			].join("\n"),
		);
	});

	it("keeps the servers with the most tools when it caps the servers' table", () => {
		const available = [...Array.from({ length: 11 }, (_, index) => `mcp__a${index}__tool`), "mcp__zz__one", "mcp__zz__two", "mcp__zz__three"];
		const report = contextReport({ ...ccUsage(), mcp: { loaded: [], available } });
		expect(report).toContain("| Server | Tools |\n|--------|-------|\n| zz | 3 |\n");
		expect(report).toContain("| and 2 more | 2 |");
	});

	it("keeps each table's ten largest rows and sums the rest", () => {
		const memoryFiles = Array.from({ length: 12 }, (_, index) => ({ name: `rules/${index}.md`, tokens: 100 + index, group: "Project" }));
		const report = contextReport({ ...ccUsage(), memoryFiles });
		expect(report).toContain("| Project | rules/11.md | 111 |");
		expect(report).not.toContain("rules/1.md |");
		expect(report).toContain("| and 2 more |  | 201 |");
	});

	it("says an estimate is one, and names what is over the window", () => {
		expect(contextReport({ ...ccUsage(), preview: "first" })).toContain("**Tokens:** 16.7k / 1m (2%)\n\nThis token count is an estimate.\n\n");
		expect(contextReport({ ...ccUsage(), total: 1_200_000 })).toContain("**Over limit:** Context exceeds the 1m-token limit by 200k tokens \u2014 run /compact or /clear to continue.\n");
	});
});

describe("renderContextUsage", () => {
	it("names a failed estimate instead of saying nothing was sent", () => {
		const usage = contextUsage({ model: { name: "M", id: "m" }, window: 1000, estimateError: "boom\x1b[31m" });
		expect(usage).toMatchObject({ state: "empty", estimateError: "boom\x1b[31m" });
		const lines = renderContextUsage(usage, { width: 100 });
		expect(lines).toContain("     The estimate failed: boom");
		expect(lines.join("\n")).not.toContain("Nothing sent yet");
	});

	it("lays out Claude Code's screen at full width", () => {
		const lines = renderContextUsage(ccUsage(), { width: 160 });
		expect(lines[0]).toBe("  ⎿  Context usage");
		expect(lines[1]).toBe(`     ⛀ ⛁ ⛁ ⛀ ⛀ ⛀ ${"⛶ ".repeat(13)}⛶   Opus 5.5`);
		expect(lines[2].endsWith("   claude-opus-5-5")).toBe(true);
		expect(lines[3].endsWith("   16.7k/1m tokens (2%)")).toBe(true);
		expect(lines[5].endsWith("   Estimated usage by category")).toBe(true);
		expect(lines[6].endsWith("   ⛁ System prompt: 2.5k tokens (0.2%)")).toBe(true);
		expect(lines[10]).toBe(`     ${"⛶ ".repeat(13)}⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝   ⛁ Skills: 2.2k tokens (0.2%)`);
		expect(lines[11]).toBe(`${" ".repeat(47)}⛶ Free space: 950.3k tokens (95%)`);
		expect(lines[12]).toBe(`${" ".repeat(47)}⛝ Autocompact buffer: 33k tokens (3%)`);
		expect(lines.slice(13)).toEqual([
			"",
			"     Auto-compact window:  1m tokens",
			"",
			"     MCP tools · /mcp (loaded on-demand)",
			"",
			"     Loaded",
			"     ├ mcp__claude_ai_Claude_Docs__batch: 134 tokens",
			"     └ mcp__claude_ai_Claude_Docs__guide: 170 tokens",
			"",
			"     Available",
			"     ├ mcp__claude_ai_Asana__authenticate",
			"     └ mcp__claude_ai_Slack__complete_authentication",
			"     Skills · /skills",
			"     ├ dataviz: ~480 tokens",
			"     └ init: ~20 tokens",
		]);
	});

	it("collapses each list to a count and its tokens, as Claude Code's fullscreen does", () => {
		const usage = { ...ccUsage(), memoryFiles: [{ name: "CLAUDE.md", tokens: 1200 }] };
		const lines = renderContextUsage(usage, { width: 160, collapsed: true });
		expect(lines.slice(13)).toEqual([
			"",
			"     Auto-compact window:  1m tokens",
			"",
			"     MCP tools · /mcp (loaded on-demand)",
			"     └ 4 tools · 304 tokens",
			"",
			"     Memory files · /memory",
			"     └ 1 file · 1.2k tokens",
			"",
			"     Skills · /skills",
			"     └ 2 skills · 2.2k tokens",
			"",
			"     /context all to expand",
		]);
		const withAgents = { ...ccUsage(), agents: [{ name: "reviewer", tokens: 300, group: "Project" }, { name: "pr:checker", tokens: 200, group: "Plugin (pr)" }] };
		const agentLines = renderContextUsage(withAgents, { width: 160, collapsed: true, agentsDir: ".claude/agents/" });
		const at = agentLines.indexOf("     Custom agents · .claude/agents/");
		expect(agentLines.slice(at, at + 3)).toEqual(["     Custom agents · .claude/agents/", "     └ 2 agents · 500 tokens", ""]);
		expect(agentLines[at - 2]).toBe("     └ 4 tools · 304 tokens");
		// Nothing to list: no hint.
		const bare = { ...ccUsage(), skills: [], mcp: { loaded: [], available: [] } };
		expect(renderContextUsage(bare, { width: 160, collapsed: true }).join("\n")).not.toContain("/context all");
	});

	it("lists custom agents by group, Project then User then each plugin, before the memory files", () => {
		const usage = {
			...ccUsage(),
			mcp: { loaded: [], available: [] },
			agents: [
				{ name: "zed:helper", tokens: 90, group: "Plugin (zed)" },
				{ name: "mine", tokens: 120, group: "User" },
				{ name: "abc:lint", tokens: 80, group: "Plugin (abc)" },
				{ name: "reviewer", tokens: 300, group: "Project" },
			],
			memoryFiles: [{ name: "CLAUDE.md", tokens: 1200 }],
		};
		// A transcript entry stored by a build before custom agents still draws.
		const { agents: _agents, ...older } = usage;
		expect(() => renderContextUsage(older as unknown as ContextUsage, { width: 160, collapsed: true })).not.toThrow();
		const lines = renderContextUsage(usage, { width: 160, agentsDir: ".claude/agents/" });
		const at = lines.indexOf("     Custom agents · .claude/agents/");
		expect(lines.slice(at, at + 11)).toEqual([
			"     Custom agents · .claude/agents/",
			"     Project",
			"     └ reviewer: 300 tokens",
			"     User",
			"     └ mine: 120 tokens",
			"     Plugin (abc)",
			"     └ abc:lint: 80 tokens",
			"     Plugin (zed)",
			"     └ zed:helper: 90 tokens",
			"     Memory files · /memory",
			"     └ CLAUDE.md: 1.2k tokens",
		]);
	});

	it("fits a 70-column terminal with the narrow grid", () => {
		const lines = renderContextUsage(ccUsage(), { width: 70 });
		expect(lines[1]).toBe("     ⛀ ⛀ ⛀ ⛀ ⛀   Opus 5.5");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(70);
		// A note wraps rather than running off the edge.
		const noted = renderContextUsage({ ...ccUsage(), unreconciled: 10 }, { width: 70 });
		const at = noted.findIndex((line) => line.includes("Rows are estimates"));
		expect(`${noted[at].trim()} ${noted[at + 1].trim()}`).toBe("Rows are estimates: the provider counted 10 tokens for the last request.");
		for (const line of noted) expect(visibleWidth(line)).toBeLessThanOrEqual(70);
	});

	it("moves the legend under the grid when it does not fit beside it", () => {
		const usage = { ...ccUsage(), model: { name: "A model with a long name", id: "provider/a-very-long-model-identifier-that-takes-space" } };
		const lines = renderContextUsage(usage, { width: 70 });
		expect(lines[1]).toBe("     ⛀ ⛀ ⛀ ⛀ ⛀");
		expect(lines[11]).toBe("");
		expect(lines[12]).toBe("     A model with a long name");
		for (const line of lines.slice(0, 25)) expect(visibleWidth(line)).toBeLessThanOrEqual(70);
	});
});
