/**
 * safety/permissions/index.ts wiring for plan mode's ask on a shell line the
 * pre-gate cannot prove read-only (`decide()` cause `plan-unproven`): the
 * user is asked, never auto mode's classifier, whatever mode plan mode was
 * entered from; with nobody to answer, the call is refused with the plan-mode
 * text; a "Yes" lets that one call through and nothing is remembered; and a
 * session grant minted before planning does not apply while planning.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_CHANNEL } from "../../extensions/lib/rules/plan-mode-channels.ts";
import { refusalText } from "../../extensions/lib/rules/permission-text.ts";
import { type PermissionBridge, SUBAGENT_GATE_CHANNEL } from "../../extensions/lib/agents/subagent-gate.ts";
import { MODE_ENV } from "../../extensions/lib/agents/permission-gate.ts";
import permissionsExtension from "../../extensions/safety/permissions/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { buildGate } from "./helpers/permission-gate-harness.ts";
import { brand, envName } from "../../extensions/lib/profile/brand.mjs";

type Prompt = { title: string; options: string[] };
type GateResult = { block?: boolean; reason?: string; terminate?: boolean } | undefined;

const GH_VIEW = "gh pr view 188 --repo o/r --json title,body";
const GH_API = "gh api repos/o/r/contents --jq '.[].name'";

describe("plan mode asks the user about an unproven shell line", () => {
	let fake: FakePi;
	let root: string;
	let cwd: string;
	let bridge: PermissionBridge | undefined;
	const prompts: Prompt[] = [];
	/** What the next prompt answers: an index into its options. */
	let answerWith = 0;
	/** Every model lookup the gate makes: the classifier needs one, a prompt does not. */
	const getAvailable = vi.fn(() => [] as unknown[]);

	const makeCtx = (hasUI = true, signal?: AbortSignal) =>
		createFakeCtx({
			cwd,
			hasUI,
			...(signal ? { signal } : {}),
			modelRegistry: { getAvailable },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(root, "session"), getBranch: () => [] },
			ui: {
				select: vi.fn(async (title: string, options: string[]) => {
					prompts.push({ title, options });
					return options[answerWith];
				}),
				input: vi.fn(async () => undefined),
			},
		});
	let ctx: Record<string, unknown>;

	const bash = (command: string, toolCallId = `c${prompts.length}-${Math.random()}`) =>
		fake.fireOne<GateResult>("tool_call", { toolName: "bash", input: { command }, toolCallId }, ctx);

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "plan-ask-"));
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv(envName("STATE_DIR"), join(root, brand.stateDir));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		// No rules from this machine's own settings.
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "empty-config"));
		fake = createFakePi();
		bridge = undefined;
		fake.events.on(SUBAGENT_GATE_CHANNEL, (data) => {
			const next = (data as { decide?: PermissionBridge } | undefined)?.decide;
			if (next) bridge = next;
		});
		prompts.length = 0;
		answerWith = 0;
		permissionsExtension(fake.pi as never);
		ctx = makeCtx();
		await fake.fire("session_start", { reason: "startup" }, ctx);
		// Entered from auto mode, the shipped default: the session's pre-plan mode.
		fake.events.emit(MODE_CHANNEL, { mode: "auto" });
		fake.events.emit(MODE_CHANNEL, { mode: "plan" });
		getAvailable.mockClear();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("prompts the user when plan mode was entered from auto mode, without consulting the classifier", async () => {
		expect(await bash(GH_VIEW)).toBeUndefined();
		expect(prompts).toHaveLength(1);
		expect(prompts[0].title).toContain("in plan mode");
		expect(prompts[0].title).toContain(GH_VIEW);
		expect(getAvailable).not.toHaveBeenCalled();

		// Control: the same line in auto mode goes to the classifier (no model
		// here, so it is blocked without a prompt), which is what plan mode avoids.
		fake.events.emit(MODE_CHANNEL, { mode: "auto" });
		const classified = await bash(GH_VIEW);
		expect(classified?.block).toBe(true);
		expect(prompts).toHaveLength(1);
	});

	it("still refuses a line that names a write, without a prompt", async () => {
		const result = await bash("gh pr view 1 > notes.txt");
		expect(result).toMatchObject({ block: true, reason: refusalText({ kind: "planMode" }) });
		expect(prompts).toHaveLength(0);
	});

	it("refuses with the plan-mode text when there is no UI", async () => {
		ctx = makeCtx(false);
		expect(await bash(GH_VIEW)).toMatchObject({ block: true, reason: refusalText({ kind: "planMode" }) });
		expect(prompts).toHaveLength(0);
	});

	it("refuses with the plan-mode text when the turn is stopped before the prompt opens", async () => {
		const controller = new AbortController();
		controller.abort();
		ctx = makeCtx(true, controller.signal);
		expect(await bash(GH_VIEW)).toMatchObject({ block: true, reason: refusalText({ kind: "planMode" }) });
		expect(prompts).toHaveLength(0);
	});

	it("lets one approved call through, and asks again for a different line", async () => {
		expect(await bash(GH_VIEW)).toBeUndefined();
		expect(await bash(GH_API)).toBeUndefined();
		expect(prompts).toHaveLength(2);
		// Approving once mints nothing: the same line asks again.
		expect(await bash(GH_VIEW)).toBeUndefined();
		expect(prompts).toHaveLength(3);
	});

	it("offers allow-once and deny only, so nothing is remembered", async () => {
		expect(await bash(GH_VIEW)).toBeUndefined();
		expect(prompts[0].options).toEqual(["Yes", "No, tell the agent what to do differently"]);
	});

	it("does not apply a session grant minted before planning", async () => {
		fake.events.emit(MODE_CHANNEL, { mode: "default" });
		answerWith = 1; // "don't ask again for this exact command"
		expect(await bash(GH_VIEW)).toBeUndefined();
		expect(prompts[0].options[1]).toBe("Yes, and don't ask again for this exact command this session");
		expect(await bash(GH_VIEW)).toBeUndefined();
		expect(prompts).toHaveLength(1);

		answerWith = 0;
		fake.events.emit(MODE_CHANNEL, { mode: "plan" });
		expect(await bash(GH_VIEW)).toBeUndefined();
		expect(prompts).toHaveLength(2);
		expect(prompts[1].title).toContain("in plan mode");
		// Back out of plan mode, the grant holds again.
		fake.events.emit(MODE_CHANNEL, { mode: "default" });
		expect(await bash(GH_VIEW)).toBeUndefined();
		expect(prompts).toHaveLength(2);
	});

	it("a subagent's call through the bridge with no parent UI is refused with the plan-mode text", async () => {
		expect(bridge).toBeDefined();
		// The parent's last call ran without a UI, so its context has nobody to ask.
		ctx = makeCtx(false);
		expect(await bash("ls")).toBeUndefined();
		expect(await bridge!({ toolName: "bash", input: { command: GH_VIEW }, cwd })).toMatchObject({ block: true, reason: refusalText({ kind: "planMode" }) });
		expect(prompts).toHaveLength(0);
	});
});

describe("an in-process child's own gate (no bridge) in plan mode", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("refuses an unproven shell line with the plan-mode text", async () => {
		vi.stubEnv(MODE_ENV, "plan");
		const { handler, cwd, home } = buildGate({});
		try {
			expect(await handler({ toolName: "bash", input: { command: GH_VIEW } })).toMatchObject({ block: true, reason: refusalText({ kind: "planMode" }) });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
