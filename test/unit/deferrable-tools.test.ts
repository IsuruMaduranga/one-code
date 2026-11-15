/**
 * `DEFERRABLE_TOOLS` (lib/request/deferrable-tools.ts) is the one list of the
 * base tools that sit behind tool_search, and a profile's listing hints are
 * keyed by it. The typecheck keeps the hints to the list; this test keeps the
 * list to what the extensions actually announce on the deferral channel, so a
 * tool the base renames or stops deferring cannot linger in it.
 */
import { describe, expect, it } from "vitest";
import { DEFERRABLE_TOOLS, MCP_RESOURCE_TOOLS } from "../../extensions/lib/request/deferrable-tools.ts";
import { DEFER_CHANNEL } from "../../extensions/lib/request/deferred.ts";
import { oneTurnHandbackSlot, subagentHandbackExtension } from "../../extensions/lib/agents/subagent-handback.ts";
import { forkCacheExtension } from "../../extensions/agents/subagents/fork-cache.ts";
import subagentsExtension from "../../extensions/agents/subagents/index.ts";
import planModeExtension from "../../extensions/safety/plan-mode/index.ts";
import worktreeExtension from "../../extensions/safety/worktree/index.ts";
import artifactsExtension from "../../extensions/tools/artifacts/index.ts";
import backgroundExtension from "../../extensions/tools/background/index.ts";
import lspExtension from "../../extensions/tools/lsp/index.ts";
import notebookExtension from "../../extensions/tools/notebook/index.ts";
import tasksExtension from "../../extensions/tools/tasks/index.ts";
import webExtension from "../../extensions/tools/web/index.ts";
import webFetchExtension from "../../extensions/tools/web-fetch/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/** What `load` announces on the deferral channel; with a `model`, the session is started on it (url_context is announced for a Gemini model only). */
async function announcedBy(load: (pi: never) => void, model?: unknown): Promise<string[]> {
	const fake = createFakePi();
	const names: string[] = [];
	fake.events.on(DEFER_CHANNEL, (data) => names.push((data as { name: string }).name));
	load(fake.pi as never);
	if (model !== undefined) await fake.fire("session_start", { reason: "startup" }, createFakeCtx({ model }));
	return names;
}

describe("DEFERRABLE_TOOLS", () => {
	it("is what the base's extensions announce, so a renamed or undeferred tool is caught", async () => {
		const gemini = { provider: "google", api: "google-generative-ai", id: "gemini-test" };
		const loads: Array<[(pi: never) => void, unknown?]> = [
			[artifactsExtension as never],
			[backgroundExtension as never],
			[lspExtension as never],
			[notebookExtension as never],
			[planModeExtension as never],
			[subagentsExtension as never],
			[tasksExtension as never],
			[webExtension as never, gemini],
			[webFetchExtension as never],
			[worktreeExtension as never],
			[forkCacheExtension({} as never) as never],
			[subagentHandbackExtension(oneTurnHandbackSlot(), { deferred: true }) as never],
		];
		const announced = new Set<string>();
		for (const [load, model] of loads) for (const name of await announcedBy(load, model)) announced.add(name);
		// The MCP resource tools are announced once a server connects (tools/mcp), from the typed list the extension loops over.
		for (const name of MCP_RESOURCE_TOOLS) announced.add(name);
		expect([...announced].sort()).toEqual([...DEFERRABLE_TOOLS].sort());
	});

	it("names each tool once", () => {
		expect(new Set(DEFERRABLE_TOOLS).size).toBe(DEFERRABLE_TOOLS.length);
	});
});
