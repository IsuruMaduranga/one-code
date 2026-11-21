/**
 * runner.ts buildChildSession applies the fork tool rule (fork-cache.ts
 * withParentParameters): a fork with its parent's request hands pi SDK tools
 * that declare the parent's schemas, and any other child keeps its own. A
 * blocking run() marked as a background turn gets the stall watch. Only the
 * session factory and the loader are replaced, so the test reads what the
 * runner really passes to pi.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const opened: Array<{ session: { customTools?: Array<{ name: string; parameters: unknown }> } }> = [];
const loaders: Array<{ extraFactories?: Array<(pi: never) => void> }> = [];
vi.mock("../../extensions/lib/agents/agent-loader.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/lib/agents/agent-loader.ts")>()),
	buildAgentLoader: vi.fn(async (options: (typeof loaders)[number]) => {
		loaders.push(options);
		return {};
	}),
	openChildSession: vi.fn(async (options: (typeof opened)[number]) => {
		opened.push(options);
		return { subscribe: () => () => {}, dispose: () => {}, getAllTools: () => [{ name: "read" }], sessionManager: { getSessionId: () => "child" } };
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

describe("a blocking run's stall watch", () => {
	/** The lifecycle events the child's inline extensions listen to: the stall watch is the one that times a turn from agent_start. */
	const watchesTurns = async (background: boolean | undefined) => {
		const runtime = await SubagentRuntime.create(dir);
		await runtime.run({ cwd: dir, task: "Count", onProgress: () => {}, ...(background === undefined ? {} : { background }) }).result;
		const events = new Set<string>();
		// Every other API call (registerTool and the like) is a no-op here.
		const known = { on: (event: string) => events.add(event), events: { on: () => {}, emit: () => {} } };
		const pi = new Proxy(known, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) });
		for (const factory of loaders.at(-1)!.extraFactories ?? []) factory(pi as never);
		return events.has("agent_start");
	};

	it("is on for a background turn (a SendMessage resume in a TUI session) and off for a blocking one", async () => {
		expect(await watchesTurns(true)).toBe(true);
		expect(await watchesTurns(false)).toBe(false);
		expect(await watchesTurns(undefined)).toBe(false);
	});
});
