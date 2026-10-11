/**
 * An in-process child (subagent, workflow agent, fork) runs One Code's shell
 * tools, not pi's built-ins: a fork advertises the parent's tools, so a child
 * on pi's bash read the model's millisecond `timeout` as seconds. A real pi SDK
 * session opened through `openChildSession` with the curated child extensions.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openChildSession } from "../../extensions/lib/agent-loader.ts";
import { CHILD_EXTENSION_PATHS } from "../../extensions/lib/child-extensions.ts";

const dir = mkdtempSync(join(tmpdir(), "oc-child-shell-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const model = {
	id: "z-ai/glm-5.3", name: "GLM", provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
} as const;

async function openChild(tools?: string[]): Promise<AgentSession> {
	const modelRuntime = await ModelRuntime.create({ credentials: {
		read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {},
	}, modelsPath: null, refreshOnCreate: false });
	vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
	return openChildSession({
		loader: { cwd: dir, agentDir: dir, extraExtensionPaths: CHILD_EXTENSION_PATHS, noContextFiles: true },
		session: { cwd: dir, agentDir: dir, modelRuntime, model: model as never, ...(tools ? { tools } : {}), sessionManager: SessionManager.inMemory(dir) },
	});
}

type Schema = { properties?: Record<string, { description?: string }> };

describe("shell tools in a child session", () => {
	it("loads both shell tools from their silent child entry files, after skill", () => {
		const names = CHILD_EXTENSION_PATHS.map((path) => path.split(/[\\/]/).slice(-2).join("/"));
		for (const entry of ["bash/child.ts", "powershell/child.ts"]) {
			const path = CHILD_EXTENSION_PATHS.find((p) => p.replaceAll("\\", "/").endsWith(entry));
			expect(path && existsSync(path)).toBe(true);
		}
		expect(names.indexOf("bash/child.ts")).toBeGreaterThan(names.indexOf("skill/index.ts"));
	});

	it("registers One Code's bash, with Claude Code's millisecond timeout and run_in_background", async () => {
		const session = await openChild();
		try {
			const bash = session.getAllTools().find((tool) => tool.name === "bash");
			const schema = bash?.parameters as Schema | undefined;
			expect(Object.keys(schema?.properties ?? {})).toEqual(["command", "timeout", "description", "run_in_background"]);
			expect(schema?.properties?.timeout?.description).toMatch(/millisecond/i);
			expect(session.getAllTools().some((tool) => tool.name === "powershell")).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("never adds a shell tool to an agent's allowlist", async () => {
		const session = await openChild(["read"]);
		try {
			expect(session.getActiveToolNames()).not.toContain("powershell");
			expect(session.getActiveToolNames()).not.toContain("bash");
		} finally {
			session.dispose();
		}
	});
});
