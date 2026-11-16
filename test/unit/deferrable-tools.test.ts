/**
 * `DEFERRABLE_TOOLS` (lib/request/deferrable-tools.ts) is the one list of the
 * base tools that sit behind tool_search, and a profile's listing hints are
 * keyed by it. The typecheck keeps every deferral of a base tool (`deferBaseTool`)
 * and every hint to the list; this test keeps the list to what the extensions
 * actually announce, so a tool the base renames or stops deferring cannot
 * linger in it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { sourceFiles } from "./helpers/import-graph.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** What `load` announces on the deferral channel; with a `model`, the session is started on it (url_context is announced for a Gemini model only). */
async function announcedBy(load: (pi: never) => void, model?: unknown): Promise<string[]> {
	const fake = createFakePi();
	const names: string[] = [];
	fake.events.on(DEFER_CHANNEL, (data) => names.push((data as { name: string }).name));
	load(fake.pi as never);
	if (model !== undefined) await fake.fire("session_start", { reason: "startup" }, createFakeCtx({ model }));
	return names;
}

/** The extensions that defer a base tool, by source file, and how to load each. The MCP resource tools are announced once a server connects (tools/mcp), from the typed list that extension loops over. */
const gemini = { provider: "google", api: "google-generative-ai", id: "gemini-test" };
const LOADS: Record<string, [load: (pi: never) => void, model?: unknown]> = {
	"extensions/tools/artifacts/index.ts": [artifactsExtension as never],
	"extensions/tools/background/index.ts": [backgroundExtension as never],
	"extensions/tools/lsp/index.ts": [lspExtension as never],
	"extensions/tools/notebook/index.ts": [notebookExtension as never],
	"extensions/safety/plan-mode/index.ts": [planModeExtension as never],
	"extensions/agents/subagents/index.ts": [subagentsExtension as never],
	"extensions/tools/tasks/index.ts": [tasksExtension as never],
	"extensions/tools/web/index.ts": [webExtension as never, gemini],
	"extensions/tools/web-fetch/index.ts": [webFetchExtension as never],
	"extensions/safety/worktree/index.ts": [worktreeExtension as never],
	"extensions/agents/subagents/fork-cache.ts": [forkCacheExtension({} as never) as never],
	"extensions/lib/agents/subagent-handback.ts": [subagentHandbackExtension(oneTurnHandbackSlot(), { deferred: true }) as never],
};
const MCP_MODULE = "extensions/tools/mcp/index.ts";

describe("DEFERRABLE_TOOLS", () => {
	it("is what the base's extensions announce, so a renamed or undeferred tool is caught", async () => {
		const announced = new Set<string>();
		for (const [load, model] of Object.values(LOADS)) for (const name of await announcedBy(load, model)) announced.add(name);
		for (const name of MCP_RESOURCE_TOOLS) announced.add(name);
		// deferBaseTool's name is typed, so what is announced is on the list; the list may hold no name nobody defers.
		expect([...announced].sort()).toEqual([...DEFERRABLE_TOOLS].sort());
	});

	it("is announced by loading every module that defers a base tool", () => {
		const deferring = sourceFiles(join(ROOT, "extensions"), ROOT).filter((file) => /\bdeferBaseTool\(/.test(readFileSync(join(ROOT, file), "utf8")) && !file.endsWith("deferred-channel.ts"));
		expect(deferring.sort()).toEqual([...Object.keys(LOADS), MCP_MODULE].sort());
	});

	it("names each tool once", () => {
		expect(new Set(DEFERRABLE_TOOLS).size).toBe(DEFERRABLE_TOOLS.length);
	});
});
