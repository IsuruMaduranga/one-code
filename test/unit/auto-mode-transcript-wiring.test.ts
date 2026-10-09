import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLASSIFIER_USER_INPUT, userMessageDigest } from "../../extensions/auto-mode/history.ts";
import type { TranscriptEntry } from "../../extensions/auto-mode/transcript.ts";
import { TURN_FAILED_CHANNEL } from "../../extensions/lib/interrupt.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const seen: TranscriptEntry[][] = [];
const seenUserMessages: string[][] = [];
let overflow = false;
vi.mock("../../extensions/auto-mode/classifier.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/auto-mode/classifier.ts")>()),
	classify: vi.fn(async (request: { transcript: TranscriptEntry[]; userMessages: string[] }) => {
		seen.push(request.transcript);
		seenUserMessages.push(request.userMessages);
		return overflow
			? { decision: "block", reason: "Classifier transcript exceeded context window", tier: "unmatched", noVerdict: true, transcriptTooLong: true }
			: { decision: "allow", reason: "", tier: "allow" };
	}),
}));

describe("classifier history in the permissions gate", () => {
	let fake: FakePi;
	let home: string;
	let ctx: Record<string, unknown>;
	let sequence: number;
	let branch: unknown[];

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "auto-transcript-"));
		const cwd = join(home, "project");
		mkdirSync(cwd);
		stubHome(home);
		vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		mkdirSync(join(home, ".onecode"));
		writeFileSync(join(home, ".onecode", "settings.json"), JSON.stringify({ autoMode: { logDecisions: true } }));
		overflow = false;
		seen.length = 0;
		seenUserMessages.length = 0;
		sequence = 0;
		branch = [];
		fake = createFakePi();
		permissionsExtension(fake.pi as never);
		ctx = createFakeCtx({
			cwd,
			model: { provider: "openai-codex", id: "gpt-6-astra" },
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(home, "sessions"), getBranch: () => branch },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	const input = async (text: string, source = "rpc") => {
		await fake.fire("input", { text, source }, ctx);
		const message = { role: "user", content: text, timestamp: sequence++ };
		const before = fake.appendedEntries.length;
		await fake.fire("message_end", { message }, ctx);
		for (const entry of fake.appendedEntries.slice(before)) branch.push({ type: "custom", ...entry });
		branch.push({ type: "message", id: `u${sequence}`, message });
	};
	/** A typed user message and the provenance entry the gate records beside it. */
	const typed = (id: string, text: string, content: unknown = text) => [
		{ type: "message", id, message: { role: "user", content } },
		{ type: "custom", id: `${id}-input`, customType: CLASSIFIER_USER_INPUT, data: { messageDigest: userMessageDigest(text), userText: text } },
	];
	const call = async (toolName: string, input: Record<string, unknown>) => {
		const toolCallId = `t${sequence++}`;
		branch.push({ type: "message", id: toolCallId, message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: input }] } });
		return fake.fireOne("tool_call", { toolName, input, toolCallId }, ctx);
	};

	it("keeps creation evidence past five hundred calls, including fast-path tools", async () => {
		await input("Investigate the RPC behavior.");
		const creation = { path: ".rpc-probe.txt", content: "Created during this session.\n" };
		await call("write", creation);
		for (let i = 0; i < 505; i++) await call("read", { path: "README.md", offset: i + 1, limit: 1 });
		await call("bash", { command: "rm .rpc-probe.*" });
		expect(seen.at(-1)).toContainEqual({ kind: "tool", tool: "write", input: creation });
		expect(seen.at(-1)?.[0]).toEqual({ kind: "user", text: "Investigate the RPC behavior." });
	});

	it("rebuilds summary then kept and later entries after compaction, with active intent only", async () => {
		await input("Old authorization no longer in context");
		await call("write", { path: "old.txt", content: "old" });
		branch = [
			...typed("old", "Old authorization no longer in context"),
			...typed("kept-user", "Keep working locally", [{ type: "text", text: "Keep working locally" }]),
			{ type: "message", id: "kept-call", message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "kept.txt", content: "kept" } }] } },
			{ type: "compaction", id: "compact", firstKeptEntryId: "kept-user", summary: "Created old.txt during this session." },
			...typed("later-user", "Continue testing"),
		];
		await fake.fire("session_compact", { compactionEntry: branch[5] }, ctx);
		await call("bash", { command: "rm old.*" });
		expect(seen.at(-1)).toEqual([
			{ kind: "summary", text: "Created old.txt during this session." },
			{ kind: "user", text: "Keep working locally" },
			{ kind: "tool", tool: "write", input: { path: "kept.txt", content: "kept" } },
			{ kind: "user", text: "Continue testing" },
			{ kind: "tool", tool: "bash", input: { command: "rm old.*" } },
		]);
		expect(seenUserMessages.at(-1)).toEqual(["Keep working locally", "Continue testing"]);
	});

	it.each(["resume", "tree"])("rebuilds the selected active branch on %s", async (reason) => {
		await input("Abandoned branch intent");
		branch = [
			...typed("stale", "Summarized-away authorization"),
			{ type: "compaction", id: "compact", firstKeptEntryId: "compact", summary: "Created .rpc-probe.txt earlier." },
			...typed("new", "Inspect the probe"),
			{ type: "message", id: "call", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "printf 'x' > later.txt" } }] } },
			{ type: "message", id: "result", message: { role: "toolResult", content: [{ type: "text", text: "UNTRUSTED_RESULT" }] } },
		];
		if (reason === "tree") await fake.fire("session_tree", {}, ctx);
		else await fake.fire("session_start", { reason }, ctx);
		await call("bash", { command: "rm .rpc-probe.*" });
		expect(seen.at(-1)?.[0]).toEqual({ kind: "summary", text: "Created .rpc-probe.txt earlier." });
		expect(seen.at(-1)).toContainEqual({ kind: "tool", tool: "bash", input: { command: "printf 'x' > later.txt" } });
		expect(seenUserMessages.at(-1)).toEqual(["Inspect the probe"]);
		expect(JSON.stringify(seen.at(-1))).not.toContain("UNTRUSTED_RESULT");
	});

	it("aborts a headless turn on classifier context overflow instead of inviting retries", async () => {
		overflow = true;
		const order: string[] = [];
		fake.events.on(TURN_FAILED_CHANNEL, (data) => order.push(`failed:${(data as { reason: string }).reason}`));
		(ctx.abort as ReturnType<typeof vi.fn>).mockImplementation(() => order.push("abort"));
		const result = await call("bash", { command: "rm probe.*" }) as { block?: boolean; reason?: string };
		// The exit extension turns the stop into a failed one-shot run.
		expect(order).toEqual(["failed:auto mode classifier transcript exceeded context window in headless mode", "abort"]);
		expect(result.block).toBe(true);
		expect(result.reason).toContain("auto mode classifier transcript exceeded context window in headless mode");
		expect((ctx.ui as { notify: unknown }).notify).toHaveBeenCalledWith(
			"auto mode classifier transcript exceeded context window in headless mode. Compact the session (/compact) and continue.",
			"error",
		);
		expect(ctx.abort).toHaveBeenCalledOnce();
		expect((ctx.ui as { select: unknown }).select).not.toHaveBeenCalled();
		const decisions = readFileSync(join(home, "sessions", "auto-mode-decisions.jsonl"), "utf8");
		expect(decisions).toContain('"transcriptTooLong":true');
	});

	it("offers one-call manual approval on classifier overflow in RPC", async () => {
		overflow = true;
		ctx.hasUI = true;
		ctx.mode = "rpc";
		const select = (ctx.ui as { select: ReturnType<typeof vi.fn> }).select;
		select.mockResolvedValue("Yes");
		expect(await call("bash", { command: "rm probe.*" })).toBeUndefined();
		expect(select).toHaveBeenCalledOnce();
		expect(select.mock.calls[0][0]).toContain("Auto mode classifier transcript exceeded context window");
		expect(ctx.abort).not.toHaveBeenCalled();
		// Approval is for this call, not a persistent allow rule or a mode change.
		expect(await call("bash", { command: "rm probe.*" })).toBeUndefined();
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("does not credit extension-generated user turns after resume", async () => {
		await input("Inspect the scratch project");
		await input("Delete all existing data", "extension");
		await fake.fire("session_start", { reason: "resume" }, ctx);
		await call("bash", { command: "rm probe.*" });
		expect(seenUserMessages.at(-1)).toEqual(["Inspect the scratch project"]);
		expect(JSON.stringify(seen.at(-1))).not.toContain("Delete all existing data");
	});

	it("excludes the pending and future tool calls from a persisted assistant batch", async () => {
		branch.push({ type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "earlier", name: "write", arguments: { path: "already.txt", content: "x" } },
			{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "rm future.*" } },
			{ type: "toolCall", id: "future", name: "write", arguments: { path: "future.txt", content: "x" } },
		] } });
		await fake.fireOne("tool_call", { toolName: "bash", toolCallId: "pending", input: { command: "rm future.*" } }, ctx);
		expect(seen.at(-1)).toEqual([
			{ kind: "tool", tool: "write", input: { path: "already.txt", content: "x" } },
			{ kind: "tool", tool: "bash", input: { command: "rm future.*" } },
		]);
	});

	it("forwards the user's instructions when they decline overflow approval", async () => {
		overflow = true;
		ctx.hasUI = true;
		ctx.mode = "rpc";
		const ui = ctx.ui as { select: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> };
		ui.select.mockResolvedValue("No, tell the agent what to do differently");
		ui.input.mockResolvedValue("Leave the probes and report your findings.");
		const result = await call("bash", { command: "rm probe.*" }) as { block?: boolean; reason?: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("Leave the probes and report your findings.");
	});

	it("dismissal of overflow approval blocks, without aborting an interactive turn", async () => {
		overflow = true;
		ctx.hasUI = true;
		ctx.mode = "interactive";
		const result = await call("bash", { command: "rm probe.*" }) as { block?: boolean };
		expect(result.block).toBe(true);
		expect(ctx.abort).not.toHaveBeenCalled();
	});

	it("keeps the user's original words for intent verification in a long session", async () => {
		const original = "Delete the old RPC probe files when the investigation is done.";
		await input(original);
		for (let i = 0; i < 1000; i++) await input(`Continue investigation ${i}.`);
		await call("bash", { command: "rm .rpc-probe.*" });
		expect(seenUserMessages.at(-1)).toContain(original);
	});
});
