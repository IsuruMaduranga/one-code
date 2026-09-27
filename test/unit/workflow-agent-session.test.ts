/**
 * The session a workflow `agent()` call opens (workflow/agent-session.ts
 * AgentRunner.run) is the one a subagent gets
 * (SUBAGENTS-WORKFLOWS-REVIEW-2026-09-26 H2, H3, M6): the agent file's
 * `tools` keeps `structured_output`, its `disallowedTools` removes tools, an
 * allowlist that matches nothing fails loud, and the curated child extensions
 * and the parent's MCP tools are there.
 *
 * Real pi SDK sessions on a temp agent dir with no model: `prompt` is spied, so
 * the tools each agent would have had on its first request are recorded and no
 * request is sent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../../extensions/workflow/agent-session.ts";

let agentDir: string;
let cwd: string;

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "wf-agent-session-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "wf-agent-session-cwd-"));
	const agents = join(cwd, ".claude", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "b4-reader.md"), "---\nname: b4-reader\ntools: Read, Grep, Glob, Bash\n---\nYou read.");
	writeFileSync(join(agents, "b4-reviewer.md"), "---\nname: b4-reviewer\ndisallowedTools: Edit, Write\n---\nYou review.");
	writeFileSync(join(agents, "b4-broken.md"), "---\nname: b4-broken\ntools: Nonsense\n---\nYou are broken.");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

const mcpTool = {
	name: "mcp__b4__ping",
	label: "ping",
	description: "ping",
	parameters: Type.Object({}),
	async execute() {
		return { content: [], details: {} };
	},
} as unknown as ToolDefinition;

/** Run one agent() call and return the tools its session had when it was first prompted. */
async function toolsOf(opts: { agentType?: string; schema?: Record<string, unknown> }) {
	const seen: { active: string[]; all: string[] }[] = [];
	vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
		seen.push({ active: this.getActiveToolNames(), all: this.getAllTools().map((t) => t.name) });
	});
	const runner = await AgentRunner.create({ cwd, defaultModel: undefined, getMcpTools: () => [mcpTool] });
	// No model answers, so the call fails after the first prompt; only the toolset is under test.
	const error = await runner.run("do it", opts, new AbortController().signal).then(
		() => undefined,
		(e: Error) => e.message,
	);
	return { first: seen[0], error };
}

// SUBAGENTS-WORKFLOWS-REVIEW-2026-09-26 M1 (A9-F1): the answer was cut at
// 50,000 characters with no marker.
describe("workflow agent() answers past the cap", () => {
	it("saves a long answer to the run directory and hands the script a pointer, never a cut", async () => {
		const answer = `${"row\n".repeat(17_500)}Verdict: the migration is safe.`;
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
			this.messages.push({ role: "assistant", content: [{ type: "text", text: answer }] } as never);
		});
		const resultsDir = mkdtempSync(join(tmpdir(), "wf-agent-session-run-"));
		try {
			const runner = await AgentRunner.create({ cwd, defaultModel: undefined, resultsDir });
			const { value } = await runner.run("tabulate", {}, new AbortController().signal);
			expect(value).toContain("<persisted-output>");
			expect(value).not.toContain("Verdict:");
			const path = /Full output saved to: (\S+\.txt)/.exec(value as string)?.[1];
			expect(path?.startsWith(join(resultsDir, "tool-results"))).toBe(true);
			expect(readFileSync(path!, "utf-8")).toBe(answer);
		} finally {
			rmSync(resultsDir, { recursive: true, force: true });
		}
	});
});

describe("workflow agent() sessions", () => {
	it("sends no request when the workflow stops while MCP tools are still connecting", async () => {
		const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async () => {});
		const controller = new AbortController();
		const runner = await AgentRunner.create({
			cwd,
			defaultModel: undefined,
			getMcpTools: async () => {
				controller.abort();
				return [mcpTool];
			},
		});
		await expect(runner.run("do it", {}, controller.signal)).rejects.toThrow("aborted");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("keeps structured_output for a schema'd agentType whose file has a tools list (H3)", async () => {
		const { first } = await toolsOf({ agentType: "b4-reader", schema: { type: "object", properties: { answer: { type: "string" } } } });
		expect(first.active).toContain("structured_output");
		expect(first.active).toEqual(expect.arrayContaining(["read", "bash"]));
		expect(first.active).not.toContain("edit");
	});

	it("applies the agent file's disallowedTools (H2)", async () => {
		const { first } = await toolsOf({ agentType: "b4-reviewer" });
		expect(first.all).not.toContain("edit");
		expect(first.all).not.toContain("write");
		expect(first.active).toContain("read");
	});

	it("fails loud when the agent file's allowlist matches no tool", async () => {
		const { first, error } = await toolsOf({ agentType: "b4-broken" });
		expect(first).toBeUndefined();
		expect(error).toMatch(/lists tools \(nonsense\) that match no available tool/);
	});

	it("loads the curated child extensions and the parent's MCP tools, as a subagent does (M6)", async () => {
		const { first } = await toolsOf({});
		expect(first.all).toEqual(expect.arrayContaining(["web_fetch", "web_search", "skill", "notebook_edit", "tool_search", "mcp__b4__ping"]));
	});
});
