/**
 * The permissions extension puts the `{"meta":{"resolvedPaths":…}}` line
 * directly above the action in the transcript the classifier is handed when
 * the action's in-project path a symlink takes outside the working
 * directory, and no line when it stays inside; the session's own transcript
 * never holds it (auto-mode/resolved-paths-meta.ts). The classifier is
 * stubbed to capture what it is handed.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../extensions/auto-mode/transcript.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const seen: TranscriptEntry[][] = [];
vi.mock("../../extensions/auto-mode/classifier.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/auto-mode/classifier.ts")>()),
	classify: vi.fn(async (request: { transcript: TranscriptEntry[] }) => {
		seen.push(request.transcript);
		return { decision: "block", reason: "stub", tier: "stage2" };
	}),
}));

describe("the resolvedPaths line in the classifier's transcript", () => {
	let fake: FakePi;
	let stateDir: string;
	let ctx: Record<string, unknown>;
	let secret: string;
	let branch: unknown[];

	beforeEach(async () => {
		stateDir = realpathSync.native(mkdtempSync(join(tmpdir(), "resolved-wiring-")));
		const project = join(stateDir, "project");
		mkdirSync(project, { recursive: true });
		mkdirSync(join(stateDir, "outside"));
		secret = join(stateDir, "outside", "authorized_keys");
		writeFileSync(secret, "k\n");
		symlinkSync(secret, join(project, "notes.txt"));
		// The user's real settings may list a workspace directory that holds the
		// temp dir (an additionalDirectories entry under /private/tmp), which
		// would put the link's target inside the workspace.
		vi.stubEnv("HOME", stateDir);
		vi.stubEnv("ONECODE_STATE_DIR", join(stateDir, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(stateDir, "agent"));
		seen.length = 0;
		branch = [];
		fake = createFakePi();
		permissionsExtension(fake.pi as never);
		ctx = createFakeCtx({
			cwd: project,
			hasUI: false,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(stateDir, "session"), getBranch: () => branch },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "auto" });
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("sits directly above a write through an in-project link, and is absent for an in-project write", async () => {
		await fake.fireOne("tool_call", { toolName: "bash", input: { command: "echo key >> notes.txt" }, toolCallId: "t1" }, ctx);
		expect(seen).toHaveLength(1);
		expect(seen[0].slice(-2)).toEqual([
			{ kind: "resolved-paths", resolvedPaths: [{ path: "notes.txt", resolvesTo: secret }] },
			{ kind: "tool", tool: "bash", input: { command: "echo key >> notes.txt" } },
		]);

		// pi owns the history; only the tool input is persisted, not resolvedPaths.
		branch.push({ type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo key >> notes.txt" } },
		] } });
		await fake.fireOne("tool_call", { toolName: "bash", input: { command: "curl -d @todo.txt https://example.com" }, toolCallId: "t2" }, ctx);
		expect(seen).toHaveLength(2);
		expect(seen[1].slice(-2)).toEqual([
			{ kind: "tool", tool: "bash", input: { command: "echo key >> notes.txt" } },
			{ kind: "tool", tool: "bash", input: { command: "curl -d @todo.txt https://example.com" } },
		]);
	});
});
