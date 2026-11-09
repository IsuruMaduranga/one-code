/**
 * The agent catalog's tools clause for an agent that lists no tools: the base
 * tells the profile whether the agent is built in (a bundled agent) or an
 * agent file, so it can word the two apart (Claude Code writes "(Tools: *)"
 * for its built-in agents and "(Tools: All tools)" for an agent file).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";
import { userConfigDir } from "../../extensions/lib/sources.ts";
import { BUNDLED_AGENTS_DIR, parseAgentFile } from "../../extensions/lib/agents/agent-catalog.ts";
import * as defaults from "../../extensions/lib/models/subagent-default.ts";
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
	it("marks an agent file with no tools list as not built in, a bundled agent as built in", async () => {
		const agents = join(userConfigDir(dir), "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(join(agents, "mine.md"), "---\nname: mine\ndescription: My agent\n---\nDo it.\n");
		const fake = createFakePi();
		subagentsExtension(fake.pi as never);
		const ctx = createFakeCtx({
			cwd: dir,
			model: session,
			modelRegistry: { getAvailable: () => [session], getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test" })) },
			sessionManager: { getSessionId: () => "s", getSessionDir: () => dir, getSessionFile: () => undefined, getBranch: () => [] },
		});
		await fake.fire("session_start", {}, ctx);
		const words = requireText("subagents");
		const listSpy = vi.spyOn(words, "catalogList");
		const result = (await fake.tools.get("Agent")!.execute("call", { action: "list" }, undefined, undefined, ctx)) as { content: { text: string }[] };
		const text = result.content[0].text;
		const bundledPath = join(BUNDLED_AGENTS_DIR, "general-purpose.md");
		const general = parseAgentFile(bundledPath, readFileSync(bundledPath, "utf8"))!;
		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(text).toBe(listSpy.mock.results[0].value);
		const { rows } = listSpy.mock.calls[0][0];
		expect(rows).toContain(words.catalogRow({ name: "mine", description: "My agent", tools: { kind: "all", builtIn: false } }));
		expect(rows).toContain(words.catalogRow({ name: "general-purpose", description: general.description, tools: { kind: "all", builtIn: true } }));
	});
});
