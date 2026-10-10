import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../extensions/auto-mode/transcript.ts";
import hooksExtension from "../../extensions/hooks/index.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const seen: TranscriptEntry[][] = [];
vi.mock("../../extensions/auto-mode/classifier.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/auto-mode/classifier.ts")>()),
	classify: vi.fn(async (request: { transcript: TranscriptEntry[] }) => {
		seen.push(request.transcript);
		return { decision: "block", reason: "rewritten action denied", tier: "stage2" };
	}),
}));

describe("main hooks before permissions", () => {
	let root: string;
	let cwd: string;
	let config: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hooks-permission-order-"));
		cwd = join(root, "project");
		config = join(root, ".claude");
		mkdirSync(cwd);
		mkdirSync(config);
		stubHome(root);
		vi.stubEnv("CLAUDE_CONFIG_DIR", config);
		vi.stubEnv("ONECODE_STATE_DIR", join(root, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		resetHookSettingsCache();
		seen.length = 0;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function call(rewritten: string, deny: string[] = []) {
		const hook = join(root, "rewrite.cjs");
		writeFileSync(hook, `process.stdin.resume(); console.log(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: rewritten } } }))});`);
		writeFileSync(join(config, "settings.json"), JSON.stringify({
			permissions: { deny },
			hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${process.execPath}" "${hook}"` }] }] },
		}));
		const fake = createFakePi();
		hooksExtension(fake.pi as never);
		permissionsExtension(fake.pi as never);
		const ctx = createFakeCtx({
			cwd,
			model: { provider: "openai-codex", id: "gpt-6-astra" },
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "test", getSessionDir: () => join(root, "session"), getSessionFile: () => undefined, getBranch: () => [] },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const input = { command: "echo original" };
		const results = await fake.fire<{ block?: boolean; reason?: string } | undefined>("tool_call", { toolName: "bash", toolCallId: "rewritten", input }, ctx);
		expect(input.command).toBe(rewritten);
		return results.at(-1);
	}

	it("matches deny rules against the rewritten command even when the hook returns allow", async () => {
		const result = await call("echo forbidden", ["Bash(echo forbidden)"]);
		expect(result?.block).toBe(true);
		expect(seen).toHaveLength(0);
	});

	it("sends the final rewritten command to the auto-mode classifier", async () => {
		const result = await call("rm probe.*");
		expect(result?.block).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0].at(-1)).toEqual({ kind: "tool", tool: "bash", input: { command: "rm probe.*" } });
		expect(JSON.stringify(seen)).not.toContain("echo original");
	});
});
