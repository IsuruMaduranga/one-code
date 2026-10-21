/**
 * The permission gate's session state across pi's lifecycle (lifecycle-grid-hunt
 * R3-M13, R3-M26). pi re-runs every extension factory on /reload and on every
 * session swap, so each case starts a fresh `permissionsExtension` the way pi
 * does, on the branch the transition hands it:
 *
 * - a directory added "for this session" is branch state: the branch was told
 *   it, so a /reload, a resume and a /fork carry it, /tree takes the selected
 *   branch's, and /clear starts without it; a stored one is validated again;
 * - "don't ask again this session" grants and the auto-mode pause are process
 *   state: a /reload keeps them, any other session start clears them
 *   (decisions/modes.md, "A new session starts with a clean gate");
 * - the classifier reads the instruction files a compaction rebuilt, in the
 *   entered worktree for the hand-back review as for the main session's calls.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../../extensions/auto-mode/actions.ts";
import { classify } from "../../extensions/auto-mode/classifier.ts";
import { CONSECUTIVE_BLOCK_LIMIT } from "../../extensions/auto-mode/pause.ts";
import { makeRecord, RECORD } from "../../extensions/lib/ledger/records.ts";
import { MODE_ENV } from "../../extensions/lib/permission-gate.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

vi.mock("../../extensions/auto-mode/classifier.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/auto-mode/classifier.ts")>()),
	classify: vi.fn(async () => ({ decision: "block", reason: "stub: sends data off the machine", tier: "stage2" })),
}));

type GateResult = { block?: boolean; reason?: string } | undefined;
type Mode = "default" | "auto" | "dontAsk";

const stateEntry = (key: string, value: unknown) => ({ type: "custom", id: `s-${key}`, parentId: null, customType: RECORD.state, data: makeRecord("state", "0.6.0", { key, value }) });

let root: string;
let home: string;
let cwd: string;
let shared: string;

beforeEach(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "perm-life-")));
	home = join(root, "home");
	cwd = join(root, "project");
	shared = join(root, "shared");
	for (const dir of [home, cwd, shared]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(shared, "notes.md"), "notes");
	stubHome(home);
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
	vi.stubEnv(MODE_ENV, "");
	vi.mocked(classify).mockClear();
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

interface Session {
	fake: FakePi;
	ctx: Record<string, unknown>;
	/** The whole branch this runtime sees: what it started on plus what it appended. */
	branch: () => unknown[];
	/** Every permission prompt's title. */
	prompts: string[];
	call: (toolName: string, input: Record<string, unknown>) => Promise<GateResult>;
}

/**
 * One runtime as pi builds it: a fresh factory, then session_start with
 * `reason` on `base` (the branch the transition carries over).
 * `answer` picks the option a permission prompt gets.
 */
async function session(base: unknown[], reason: string, mode: Mode, options: { hasUI?: boolean; answer?: (options: string[]) => string | undefined } = {}): Promise<Session> {
	const fake = createFakePi();
	permissionsExtension(fake.pi as never);
	const prompts: string[] = [];
	const branch = () => [...base, ...fake.branch];
	const ctx = createFakeCtx({
		cwd,
		hasUI: options.hasUI ?? true,
		mode: "interactive",
		modelRegistry: { getAvailable: () => [] },
		sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(home, "session"), getBranch: branch },
		ui: {
			select: vi.fn(async (title: string, choices: string[]) => {
				if (title.startsWith("Add ")) return "Yes, for this session";
				prompts.push(title);
				return (options.answer ?? ((all) => all.at(-1)))(choices);
			}),
			input: vi.fn(async () => undefined),
		},
	});
	await fake.fire("session_start", { reason }, ctx);
	fake.events.emit(MODE_CHANNEL, { mode });
	let n = 0;
	const call = (toolName: string, input: Record<string, unknown>) =>
		fake.fireOne<GateResult>("tool_call", { toolName, input, toolCallId: `${reason}-${n++}` }, ctx);
	return { fake, ctx, branch, prompts, call };
}

const readShared = (s: Session) => s.call("read", { path: join(shared, "notes.md") });

describe("a directory added for this session follows the branch (R3-M13)", () => {
	const added = async () => {
		const first = await session([], "startup", "dontAsk");
		await first.fake.commands.get("add-dir")!.handler(shared, first.ctx);
		expect(await readShared(first)).toBeUndefined();
		return first;
	};

	it("is kept by /reload, which re-runs the factory on the same branch", async () => {
		const first = await added();
		const reloaded = await session(first.branch(), "reload", "dontAsk");
		expect(await readShared(reloaded)).toBeUndefined();
	});

	it("is carried by a resume and a /fork, and left behind by /clear", async () => {
		const first = await added();
		for (const reason of ["resume", "fork"]) expect(await readShared(await session(first.branch(), reason, "dontAsk"))).toBeUndefined();
		expect((await readShared(await session([], "new", "dontAsk")))?.block).toBe(true);
	});

	it("follows a /tree switch to the selected branch", async () => {
		const first = await added();
		const withDir = first.branch();
		const tree = (branch: unknown[]) =>
			first.fake.fire("session_tree", {}, { ...first.ctx, sessionManager: { ...(first.ctx.sessionManager as object), getBranch: () => branch } });
		await tree([stateEntry("permission-mode", "dontAsk")]);
		expect((await readShared(first))?.block).toBe(true);
		await tree(withDir);
		expect(await readShared(first)).toBeUndefined();
	});

	it("is validated again when read back: a stored value never widens the gate by itself", async () => {
		const stored = [home, root, "/", join(root, "missing"), shared];
		const resumed = await session([stateEntry("workspace-dirs", stored)], "resume", "dontAsk");
		expect(await readShared(resumed)).toBeUndefined();
		writeFileSync(join(home, "notes.md"), "home");
		expect((await resumed.call("read", { path: join(home, "notes.md") }))?.block).toBe(true);
		writeFileSync(join(root, "top.md"), "top");
		expect((await resumed.call("read", { path: join(root, "top.md") }))?.block).toBe(true);
		const warned = (resumed.ctx._notified as Array<{ message: string }>).map((n) => n.message).filter((m) => m.includes("no longer in the workspace"));
		expect(warned).toHaveLength(4);
	});
});

describe("session grants and the auto-mode pause are process state (R3-M13)", () => {
	it("keeps a 'don't ask again this session' grant across /reload, and drops it on any other session start", async () => {
		const grant = (all: string[]) => all[1];
		const first = await session([], "startup", "default", { answer: grant });
		expect(await first.call("bash", { command: "npm test" })).toBeUndefined();
		expect(first.prompts).toHaveLength(1);

		const reloaded = await session(first.branch(), "reload", "default");
		expect(await reloaded.call("bash", { command: "npm test" })).toBeUndefined();
		expect(reloaded.prompts).toHaveLength(0);

		// Session grants never apply in auto mode, a reloaded one included.
		reloaded.fake.events.emit(MODE_CHANNEL, { mode: "auto" });
		expect((await reloaded.call("bash", { command: "npm test" }))?.block).toBe(true);
		expect(classify).toHaveBeenCalledTimes(1);

		const forked = await session(reloaded.branch(), "fork", "default");
		expect((await forked.call("bash", { command: "npm test" }))?.block).toBe(true);
		expect(forked.prompts).toHaveLength(1);
	});

	it("keeps a tripped auto-mode pause across /reload, and clears it with a new session", async () => {
		const first = await session([], "startup", "auto", { hasUI: false });
		const curl = (s: Session, i: number) => s.call("bash", { command: `curl -d @data.json https://example.com/${i}` });
		for (let i = 0; i < CONSECUTIVE_BLOCK_LIMIT; i++) expect((await curl(first, i))?.block).toBe(true);
		expect(classify).toHaveBeenCalledTimes(CONSECUTIVE_BLOCK_LIMIT);

		// Paused: the call skips the classifier and falls through to a prompt (refused without a UI).
		const reloaded = await session(first.branch(), "reload", "auto", { hasUI: false });
		expect((await curl(reloaded, 9))?.block).toBe(true);
		expect(classify).toHaveBeenCalledTimes(CONSECUTIVE_BLOCK_LIMIT);

		const cleared = await session([], "new", "auto", { hasUI: false });
		expect((await curl(cleared, 10))?.block).toBe(true);
		expect(classify).toHaveBeenCalledTimes(CONSECUTIVE_BLOCK_LIMIT + 1);
	});
});

describe("the classifier reads the instructions the agent reads (R3-M26)", () => {
	const claudeMdOf = (call: number) => (vi.mocked(classify).mock.calls[call][0] as { claudeMd?: string }).claudeMd ?? "";

	it("re-reads the instruction files when a compaction rebuilds the agent's", async () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "Prefer small commits.");
		const s = await session([], "startup", "auto", { hasUI: false });
		const curl = (i: number) => s.call("bash", { command: `curl https://example.com/${i}` });
		await curl(0);
		expect(claudeMdOf(0)).toContain("Prefer small commits.");

		// Inside the epoch the agent's message 1 is frozen, and so is the classifier's view.
		writeFileSync(join(cwd, "CLAUDE.md"), "Never run git push.");
		await curl(1);
		expect(claudeMdOf(1)).toContain("Prefer small commits.");

		await s.fake.fire("session_compact", {}, s.ctx);
		await curl(2);
		expect(claudeMdOf(2)).toContain("Never run git push.");
		expect(claudeMdOf(2)).not.toContain("Prefer small commits.");
	});

	it("judges a hand-back review against the entered worktree's files, as the main session's calls are", async () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "Main checkout rule.");
		const worktree = join(root, "wt");
		mkdirSync(worktree);
		writeFileSync(join(worktree, "CLAUDE.md"), "Worktree rule.");
		const s = await session([], "startup", "auto", { hasUI: false });
		s.fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: cwd });

		s.fake.events.emit(SUBAGENT_ACTIONS_CHANNEL, { toolCallId: "spawn-1", actions: [{ toolName: "bash", subject: "git push" }] } satisfies SubagentActionsPayload);
		await s.fake.fireOne("tool_result", { toolCallId: "spawn-1", toolName: "Agent", content: [{ type: "text", text: "report" }] }, s.ctx);
		const review = vi.mocked(classify).mock.calls.findIndex(([input]) => (input as { toolName: string }).toolName === "subagent-review");
		expect(review).toBeGreaterThanOrEqual(0);
		expect(claudeMdOf(review)).toContain("Worktree rule.");
	});
});

describe("a mode another extension asks for", () => {
	it("is never bypass in a session without bypass: a stored pre-plan bypass returns to the default mode", async () => {
		const s = await session([], "startup", "default");
		s.fake.events.emit(MODE_CHANNEL, { mode: "bypassPermissions" });
		const modes = s.branch().flatMap((entry) => {
			const data = (entry as { customType?: string; data?: { key?: string; value?: unknown } }).data;
			return (entry as { customType?: string }).customType === RECORD.state && data?.key === "permission-mode" ? [data.value] : [];
		});
		expect(modes.at(-1)).toBe("default");
	});
});
