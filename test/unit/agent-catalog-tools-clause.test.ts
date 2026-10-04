/**
 * The agent catalog's tools clause for an agent that lists no tools: Claude
 * Code writes "(Tools: *)" for its built-in agents and "(Tools: All tools)"
 * for an agent file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as defaults from "../../extensions/subagents/default-model.ts";
import subagentsExtension from "../../extensions/subagents/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const session = { provider: "openai", id: "gpt-5-main", name: "gpt-5-main", input: ["text"], cost: { input: 2, output: 8 } };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-catalog-"));
	// Nothing from the real home: its agents and plugins would join the catalog.
	vi.stubEnv("HOME", dir);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
	vi.spyOn(defaults, "loadSubagentDefault").mockReturnValue(undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("agent catalog tools clause", () => {
	it("says All tools for an agent file with no tools list, * for a bundled agent", async () => {
		mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
		writeFileSync(join(dir, ".claude", "agents", "mine.md"), "---\nname: mine\ndescription: My agent\n---\nDo it.\n");
		const fake = createFakePi();
		subagentsExtension(fake.pi as never);
		const ctx = createFakeCtx({
			cwd: dir,
			model: session,
			modelRegistry: { getAvailable: () => [session], getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test" })) },
			sessionManager: { getSessionId: () => "s", getSessionDir: () => dir, getSessionFile: () => undefined, getBranch: () => [] },
		});
		await fake.fire("session_start", {}, ctx);
		const result = (await fake.tools.get("Agent")!.execute("call", { action: "list" }, undefined, undefined, ctx)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("\n- mine: My agent (Tools: All tools)\n");
		expect(text).toMatch(/\n- general-purpose: [^\n]* \(Tools: \*\)\n/);
	});
});
