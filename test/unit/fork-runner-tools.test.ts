/**
 * runner.ts buildChildSession applies the fork tool rule (fork-cache.ts
 * withParentParameters): a fork with its parent's request hands pi SDK tools
 * that declare the parent's schemas, and any other child keeps its own. Only
 * the session factory is replaced, so the test reads what the runner really
 * passes to pi.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const opened: Array<{ session: { customTools?: Array<{ name: string; parameters: unknown }> } }> = [];
vi.mock("../../extensions/lib/agents/agent-loader.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/lib/agents/agent-loader.ts")>()),
	buildAgentLoader: vi.fn(async () => ({})),
	openChildSession: vi.fn(async (options: (typeof opened)[number]) => {
		opened.push(options);
		return { subscribe: () => () => {}, dispose: () => {}, getAllTools: () => [{ name: "read" }] };
	}),
}));

const { SubagentRuntime } = await import("../../extensions/agents/subagents/runner.ts");
const { SessionTurnTracker } = await import("../../extensions/agents/subagents/session-turns.ts");

const dir = mkdtempSync(join(tmpdir(), "oc-fork-runner-tools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const parentSendMessage = { type: "object", required: ["to", "message"], properties: { to: { type: "string" }, message: { type: "string" } } };
const parentAgent = { type: "object", required: ["task"], properties: { task: { type: "string" }, model: { type: "string" } } };
const nestedAgent = { type: "object", required: ["task"], properties: { task: { type: "string" } } };

async function customTools(spec: Record<string, unknown>) {
	const runtime = await SubagentRuntime.create(dir);
	const build = (runtime as unknown as { buildChildSession(spec: unknown, handback: unknown): Promise<unknown> }).buildChildSession.bind(runtime);
	await build({ cwd: dir, sessionDir: dir, extraTools: [{ name: "Agent", label: "Agent", description: "nested", parameters: nestedAgent, execute: async () => ({}) }], ...spec }, new SessionTurnTracker());
	const tools = opened.at(-1)!.session.customTools ?? [];
	return Object.fromEntries(tools.map((tool) => [tool.name, tool.parameters]));
}

describe("the runner's fork tools", () => {
	const parentTools = [
		{ name: "SendMessage", parameters: parentSendMessage },
		{ name: "Agent", parameters: parentAgent },
	];

	it("declare the parent's schemas in a fork that has its parent's request", async () => {
		const tools = await customTools({ parentSystemPrompt: "parent prompt", parentRequest: { api: "anthropic-messages", payload: {} }, parentTools });
		expect(tools.SendMessage).toBe(parentSendMessage);
		expect(tools.Agent).toBe(parentAgent);
	});

	it("declare the parent's schemas on a resume whose saved request is gone, so they match the fork's own recorded requests", async () => {
		const tools = await customTools({ parentSystemPrompt: "parent prompt", parentTools });
		expect(tools.SendMessage).toBe(parentSendMessage);
		expect(tools.Agent).toBe(parentAgent);
	});

	it("keep their own schemas in a fork not handed the parent's tools, and in a named agent", async () => {
		for (const spec of [{ parentSystemPrompt: "parent prompt" }, { parentTools }]) {
			const tools = await customTools(spec);
			expect(tools.SendMessage).not.toBe(parentSendMessage);
			expect(tools.Agent).toBe(nestedAgent);
		}
	});
});
