/**
 * pi's `--tools`, `--exclude-tools` and `--no-tools` restrict every child the
 * base starts with tools of its own (lib/agents/agent-catalog.ts
 * agentToolOptions): a subagent's tools are its own minus the ones the flags
 * removed from the session, a workflow agent's and a fork's too. The shared MCP tools follow pi's MCP rule, an agent file's tool
 * the flags removed is told once, and the catalog row says what the child has.
 *
 * Real pi SDK sessions with no model: `prompt` is spied, so the tools each
 * child has on its first request are recorded and no request is sent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../../extensions/agents/workflow/agent-session.ts";
import { SubagentRuntime } from "../../extensions/agents/subagents/runner.ts";
import subagentsExtension from "../../extensions/agents/subagents/index.ts";
import { CHILD_REPORT_CHANNELS, discoverAgents } from "../../extensions/lib/agents/agent-catalog.ts";
import { subagentResultText } from "../../extensions/lib/agents/subagent-text.ts";
import { childLive } from "../../extensions/lib/agents/child-extensions.ts";
import { activeProfile, launchToolFilter, PRODUCT_DIR, PROFILE_DIR, requireText, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { projectConfigDirName } from "../../extensions/lib/profile/sources.ts";
import { profile as shipped } from "./helpers/default-profile.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { backgroundWords } from "../../extensions/tools/background/text.ts";

let agentDir: string;
let cwd: string;
let agentsDir: string;

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "subagent-tool-flags-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "subagent-tool-flags-cwd-"));
	agentsDir = join(cwd, projectConfigDirName(), "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "flags-reader.md"), "---\nname: flags-reader\ndescription: Reads\ntools: Read, Bash, WebFetch\n---\nYou read.");
	writeFileSync(join(agentsDir, "flags-shell.md"), "---\nname: flags-shell\ndescription: Runs commands\ntools: Bash\n---\nYou run commands.");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	setActiveProfileForTest(undefined);
});

/** Put the shipped profile in force under pi's launch arguments `args`. */
const launch = (args: string[]) => setActiveProfileForTest(resolveProfile(shipped, {}, PROFILE_DIR, PRODUCT_DIR, undefined, launchToolFilter(args)));

const tool = (name: string) =>
	({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }) as unknown as ToolDefinition;
const MCP = tool("mcp__flags__ping");

/** The tools every child session registers when first prompted, in call order. */
function recordTools(): string[][] {
	const seen: string[][] = [];
	vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
		seen.push(this.getAllTools().map((t) => t.name));
	});
	return seen;
}

const agent = (name: string) => discoverAgents([agentsDir]).find((a) => a.name === name)!;

/** One subagent run on a real runtime: its tools and its report (the one-time note leads it). */
async function subagent(spec: { agent?: string; fork?: boolean; extraTools?: ToolDefinition[] }) {
	const seen = recordTools();
	const runtime = await SubagentRuntime.create(cwd, () => [MCP]);
	const outcome = await runtime.run({
		cwd,
		task: "do work",
		...(spec.agent ? { agent: agent(spec.agent) } : {}),
		...(spec.fork ? { parentSystemPrompt: "You are the parent." } : {}),
		extraTools: spec.extraTools ?? [],
		onProgress: () => {},
	}).result;
	return { tools: seen[0] ?? [], output: outcome.output };
}

/** One workflow agent() call: its tools and the notices the script's run log got. */
async function workflowAgent(agentType?: string) {
	const seen = recordTools();
	const notices: string[] = [];
	const runner = await AgentRunner.create({ cwd, defaultModel: undefined, getMcpTools: () => [MCP], onNotice: (notice) => notices.push(notice) });
	// No model answers, so the call fails after the first prompt; only the tools are under test.
	await runner.run("do it", agentType ? { agentType } : {}, new AbortController().signal).catch(() => undefined);
	return { tools: seen[0] ?? [], notices };
}

const has = (tools: string[], ...names: string[]) => Object.fromEntries(names.map((name) => [name, tools.includes(name)]));

describe("a subagent under pi's tool flags", () => {
	it("keeps its own tools without a flag", async () => {
		const { tools, output } = await subagent({ agent: "flags-reader" });
		expect(has(tools, "read", "bash", "web_fetch", MCP.name)).toEqual({ read: true, bash: true, web_fetch: true, [MCP.name]: true });
		expect(output).not.toContain("tool flags");
	});

	it("loses what --exclude-tools removed, and is told so once", async () => {
		launch(["--exclude-tools", "web_fetch"]);
		const { tools, output } = await subagent({ agent: "flags-reader" });
		expect(has(tools, "read", "bash", "web_fetch")).toEqual({ read: true, bash: true, web_fetch: false });
		expect(output.startsWith(subagentResultText().toolsLeftOut({ name: "flags-reader", tools: ["web_fetch"] }))).toBe(true);
	});

	it("keeps only what --tools lists, never more than its own list", async () => {
		launch(["--tools", "read,bash,Agent"]);
		const own = await subagent({ agent: "flags-reader" });
		expect(has(own.tools, "read", "bash", "web_fetch", "Agent", "edit")).toEqual({ read: true, bash: true, web_fetch: false, Agent: false, edit: false });
		// An agent that lists none gets the allowlist, the nested Agent included; an allowlist naming no mcp__ entry keeps MCP tools, as pi does for the session.
		const general = await subagent({ extraTools: [tool("Agent")] });
		expect(has(general.tools, "read", "bash", "Agent", "edit", "web_fetch", MCP.name)).toEqual({ read: true, bash: true, Agent: true, edit: false, web_fetch: false, [MCP.name]: true });
		expect(general.output).not.toContain("tool flags");
	});

	it("starts with none of its tools under --no-tools, keeping its report channels", async () => {
		launch(["--no-tools"]);
		const { tools, output } = await subagent({ agent: "flags-reader" });
		// A launch that failed before the first prompt records no tools: the filter below would then pass on nothing.
		expect(tools).toContain("SubagentHandback");
		expect(tools.filter((name) => !CHILD_REPORT_CHANNELS.includes(name))).toEqual([]);
		expect(output).toContain(subagentResultText().toolsLeftOut({ name: "flags-reader", tools: ["read", "bash", "web_fetch"] }));
	});

	it("gains no tool from an --exclude-tools pattern that also matches a report channel", async () => {
		// `*_*` matches structured_output as well as web_fetch: the child loses both, never keeps web_fetch.
		launch(["--exclude-tools", "*_*"]);
		expect(activeProfile().live.has("web_fetch")).toBe(false);
		const { tools } = await subagent({ agent: "flags-reader" });
		expect(has(tools, "read", "bash", "web_fetch")).toEqual({ read: true, bash: true, web_fetch: false });
		expect(tools.filter((name) => name.includes("_"))).toEqual([]);
		// A fork, whose tools would otherwise be undefined and nothing excluded, too.
		const fork = (await subagent({ fork: true })).tools;
		expect(fork).toContain("read");
		expect(fork.filter((name) => name.includes("_"))).toEqual([]);
	});

	it("keeps a report channel an --exclude-tools entry names exactly", async () => {
		launch(["--exclude-tools", "SubagentHandback,web_fetch"]);
		const { tools } = await subagent({ agent: "flags-reader" });
		expect(has(tools, "SubagentHandback", "web_fetch")).toEqual({ SubagentHandback: true, web_fetch: false });
	});

	it("drops the shared MCP tools an allowlist with an mcp__ entry leaves out", async () => {
		launch(["--tools", "read,mcp__other__*"]);
		const allowlisted = (await subagent({})).tools;
		expect(allowlisted).toContain("read");
		expect(allowlisted).not.toContain(MCP.name);
		launch(["--exclude-tools", "mcp__flags__*"]);
		const excluded = (await subagent({})).tools;
		expect(excluded).toContain("read");
		expect(excluded).not.toContain(MCP.name);
	});

	it("hands a nested agent no Agent tool once the flags removed it", async () => {
		launch(["--exclude-tools", "Agent"]);
		const { tools } = await subagent({ extraTools: [tool("Agent")] });
		expect(tools).toContain("read");
		expect(tools).not.toContain("Agent");
	});

	// A fork's requests carry the parent's tools; its own registry follows the
	// flags too, so its tool_search cannot load a tool the parent left out.
	it("gives a fork no tool the flags removed from the parent, and no note", async () => {
		launch(["--exclude-tools", "web_fetch"]);
		const flagged = await subagent({ fork: true });
		expect(flagged.tools).toContain("read");
		expect(flagged.tools).not.toContain("web_fetch");
		expect(flagged.output).not.toContain("tool flags");
		setActiveProfileForTest(undefined);
		expect((await subagent({ fork: true })).tools).toContain("web_fetch");
	});

	it("restricts the child's own view, which cuts its text", () => {
		launch(["--tools", "read,bash,Agent"]);
		expect(childLive().has("web_fetch")).toBe(false);
		expect(childLive().has("bash")).toBe(activeProfile().live.has("bash"));
	});
});

describe("a workflow agent under pi's tool flags", () => {
	it("keeps its own tools without a flag", async () => {
		const { tools, notices } = await workflowAgent("flags-reader");
		expect(has(tools, "read", "bash", "web_fetch", MCP.name)).toEqual({ read: true, bash: true, web_fetch: true, [MCP.name]: true });
		expect(notices.join("\n")).not.toContain("tool flags");
	});

	it("loses what --exclude-tools removed, and the run log says so", async () => {
		launch(["--exclude-tools", "web_fetch"]);
		const { tools, notices } = await workflowAgent("flags-reader");
		expect(has(tools, "read", "bash", "web_fetch")).toEqual({ read: true, bash: true, web_fetch: false });
		expect(notices).toContain(subagentResultText().toolsLeftOut({ name: "flags-reader", tools: ["web_fetch"] }));
	});

	it("keeps only what --tools lists", async () => {
		launch(["--tools", "read,bash,Agent"]);
		const own = await workflowAgent("flags-reader");
		expect(has(own.tools, "read", "bash", "web_fetch", "edit")).toEqual({ read: true, bash: true, web_fetch: false, edit: false });
		const general = await workflowAgent();
		expect(has(general.tools, "read", "bash", "edit", MCP.name)).toEqual({ read: true, bash: true, edit: false, [MCP.name]: true });
	});

	it("starts with none of its tools under --no-tools, keeping its hand-back", async () => {
		launch(["--no-tools"]);
		const { tools } = await workflowAgent("flags-reader");
		expect(tools).toContain("SubagentHandback");
		expect(tools.filter((name) => !CHILD_REPORT_CHANNELS.includes(name))).toEqual([]);
		expect(tools).not.toContain(MCP.name);
	});
});

describe("the agent catalog under pi's tool flags", () => {
	it("lists for an agent the tools its subagent really has", async () => {
		launch(["--tools", "read,Agent"]);
		const fake = createFakePi();
		subagentsExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s", getBranch: () => [] } });
		await fake.fire("session_start", {}, ctx);
		const listed = await fake.tools.get("Agent")!.execute("call", { action: "list" }, undefined, undefined, ctx);
		const row = (listed as { content: Array<{ text: string }> }).content[0].text.split("\n").find((line) => line.startsWith("- flags-shell:"));
		expect(row).toContain("(Tools: none)");
		const { tools, output } = await subagent({ agent: "flags-shell" });
		expect(tools).not.toContain("bash");
		// No tool of its own left: still a start, with the note.
		expect(output).toContain(subagentResultText().toolsLeftOut({ name: "flags-shell", tools: ["bash"] }));
	});
});

describe("text under pi's --exclude-tools SendMessage", () => {
	it("leaves SendMessage out of a subagent and out of the resident-ended note", async () => {
		const note = () => backgroundWords(requireText("background")).tasks.residentEnded({ id: "t1", description: "review" });
		expect(note()).toContain("SendMessage");
		launch(["--exclude-tools", "SendMessage"]);
		expect(note()).toBe("Terminated the resident agent behind t1 (review).");
		expect((await subagent({ agent: "flags-reader" })).tools).not.toContain("SendMessage");
	});
});
