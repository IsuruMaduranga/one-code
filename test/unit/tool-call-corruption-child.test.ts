/**
 * The OpenRouter stream detector in an in-process child (subagent, workflow
 * agent): a real pi SDK session opened through `openChildSession` with the
 * curated child extensions, only the provider stream replaced.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openChildSession } from "../../extensions/lib/agent-loader.ts";
import { CHILD_EXTENSION_PATHS } from "../../extensions/lib/child-extensions.ts";

const dir = mkdtempSync(join(tmpdir(), "oc-child-corruption-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const model = {
	id: "z-ai/glm-5.3", name: "GLM", provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
} as const;

async function openChild(execute: () => Promise<{ content: Array<{ type: "text"; text: string }>; details: object }>): Promise<AgentSession> {
	const modelRuntime = await ModelRuntime.create({ credentials: {
		read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {},
	}, modelsPath: null, refreshOnCreate: false });
	vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
	return openChildSession({
		loader: { cwd: dir, agentDir: dir, extraExtensionPaths: CHILD_EXTENSION_PATHS, noContextFiles: true },
		session: {
			cwd: dir, agentDir: dir, modelRuntime, model: model as never, tools: ["bash"],
			customTools: [{ name: "bash", label: "bash", description: "test shell", parameters: Type.Object({ command: Type.String() }), execute } as never],
			sessionManager: SessionManager.inMemory(dir),
		},
	});
}

/** Streams one bash call whose raw arguments were cut at the escaped quote. */
function corruptStream(session: AgentSession) {
	const requests = vi.fn();
	session.agent.streamFunction = (_model, _context, options) => {
		const events = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "toolCall", id: "bad", name: "bash", arguments: { command: 'grep -rn "' } }],
			api: model.api, provider: model.provider, model: model.id, responseId: "gen-child", timestamp: 1, stopReason: "toolUse",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		if (options?.signal?.aborted) {
			events.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } });
			return events;
		}
		requests();
		if (requests.mock.calls.length > 1) {
			// Without the guard the child goes on: answer in text so the run ends.
			const reply: AssistantMessage = { ...message, content: [{ type: "text", text: "continued" }], stopReason: "stop" };
			events.push({ type: "start", partial: reply });
			events.push({ type: "done", reason: "stop", message: reply });
			return events;
		}
		events.push({ type: "start", partial: message });
		events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
		events.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"grep -rn \\""}', partial: message });
		events.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as never, partial: message });
		events.push({ type: "done", reason: "toolUse", message });
		return events;
	};
	return requests;
}

describe("OpenRouter corruption guard in a child session", () => {
	it("loads in the package's order, from its child entry file", () => {
		const entry = CHILD_EXTENSION_PATHS.find((path) => path.includes("tool-call-corruption"));
		expect(entry).toMatch(/tool-call-corruption[\\/]child\.ts$/);
		expect(existsSync(entry!)).toBe(true);
		const names = CHILD_EXTENSION_PATHS.map((path) => path.split(/[\\/]/).at(-2));
		expect(names.indexOf("tool-call-corruption")).toBe(names.indexOf("claude-context") + 1);
	});

	it("blocks the damaged call and stops only the child, without writing to the parent's terminal", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }], details: {} }));
		const exitCode = process.exitCode;
		const session = await openChild(execute);
		try {
			const requests = corruptStream(session);
			await session.prompt("search for slugify");
			expect(execute).not.toHaveBeenCalled();
			expect(requests).toHaveBeenCalledTimes(1);
			const result = session.messages.find((message) => message.role === "toolResult");
			expect(JSON.stringify(result)).toContain("OpenRouter tool-call corruption");
			// Stopped after the blocked result: no second request, nothing after it.
			expect(session.messages.at(-1)).toBe(result);
			// No notice and no provider lookup: a child has no terminal of its own.
			expect(stderr).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(exitCode);
		} finally {
			session.dispose();
		}
	});
});
