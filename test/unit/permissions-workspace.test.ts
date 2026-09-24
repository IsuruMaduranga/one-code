/**
 * Workspace directories (permissions/workspace.ts): what one grants in each
 * mode, where they come from (settings, the repository behind consent,
 * `--add-dir`, `/add-dir`), and what the system prompt is told.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oneCodeProjectSettingsPath } from "../../extensions/lib/one-code-settings.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { WORKSPACE_CHANNEL } from "../../extensions/lib/workspace-channel.ts";
import { decide } from "../../extensions/permissions/matcher.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { listWorkspaceDirectories } from "../../extensions/permissions/settings.ts";
import { parseAddDirFlag, validateWorkspaceDirectory } from "../../extensions/permissions/workspace.ts";
import { buildClaudeCodeSystemPrompt } from "../../extensions/system-prompt/template.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

type GateResult = { block?: boolean; reason?: string } | undefined;

let root: string;
let home: string;
let cwd: string;
let shared: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "perm-ws-")));
	home = join(root, "home");
	cwd = join(root, "project");
	shared = join(root, "shared");
	for (const dir of [home, cwd, shared, join(shared, ".ssh"), join(shared, "sub")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(shared, "notes.md"), "notes");
	writeFileSync(join(shared, ".ssh", "id_rsa"), "key");
	vi.stubEnv("HOME", home);
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("decide() with workspace directories", () => {
	const at = (toolName: string, subject: string, mode: "default" | "acceptEdits" | "auto" | "plan", workspaceDirs: string[] = [shared]) =>
		decide({ toolName, subject, cwd, mode, deny: [], ask: [], allow: [], resolvedSubject: subject, workspaceDirs });

	it("makes reads inside one working-space reads in every mode", () => {
		for (const mode of ["default", "auto", "plan"] as const) expect(at("read", join(shared, "notes.md"), mode).decision).toBe("allow");
		expect(at("read", join(shared, "notes.md"), "default", []).decision).toBe("ask");
	});

	it("never makes a credential inside one a working-space read", () => {
		expect(at("read", join(shared, ".ssh", "id_rsa"), "default").decision).toBe("ask");
		expect(at("read", join(shared, ".ssh", "id_rsa"), "auto").decision).toBe("classify");
	});

	it("lets acceptEdits write there, but leaves auto mode's writes to the classifier", () => {
		expect(at("write", join(shared, "notes.md"), "acceptEdits").decision).toBe("allow");
		expect(at("write", join(shared, "notes.md"), "auto").decision).toBe("classify");
		expect(at("write", join(shared, "notes.md"), "default").decision).toBe("ask");
	});

	it("lets plan mode's read-only bash read there", () => {
		expect(at("bash", `cat ${join(shared, "notes.md")}`, "plan").decision).toBe("allow");
		expect(at("bash", `cat ${join(shared, ".ssh", "id_rsa")}`, "plan").decision).not.toBe("allow");
	});
});

describe("validateWorkspaceDirectory", () => {
	it("accepts an existing directory outside the workspace, as its real path", () => {
		expect(validateWorkspaceDirectory(shared, cwd, home, [])).toEqual({ path: shared });
		expect(validateWorkspaceDirectory("../shared", cwd, home, [])).toEqual({ path: shared });
	});

	it("refuses what Claude Code refuses, and the root and home directory", () => {
		expect(validateWorkspaceDirectory(join(root, "missing"), cwd, home, [])).toEqual({ error: `${join(root, "missing")} does not exist.` });
		expect(validateWorkspaceDirectory(join(shared, "notes.md"), cwd, home, [])).toMatchObject({ error: expect.stringContaining("is not a directory") });
		expect(validateWorkspaceDirectory(join(cwd), cwd, home, [])).toMatchObject({ error: expect.stringContaining("already inside the working directory") });
		expect(validateWorkspaceDirectory(join(shared, "sub"), cwd, home, [shared])).toMatchObject({ error: expect.stringContaining("already in the workspace") });
		expect(validateWorkspaceDirectory("/", cwd, home, [])).toMatchObject({ error: expect.stringContaining("filesystem root") });
		expect(validateWorkspaceDirectory("~", cwd, home, [])).toMatchObject({ error: expect.stringContaining("home directory") });
	});

	it("splits --add-dir like PATH", () => {
		expect(parseAddDirFlag(undefined)).toEqual([]);
		expect(parseAddDirFlag(process.platform === "win32" ? "a; b" : "a: b")).toEqual(["a", "b"]);
	});
});

describe("workspace directories in the gate", () => {
	let fake: FakePi;
	let ctx: Record<string, unknown>;
	let confirmAnswer = true;
	let selectAnswer: string | undefined;
	const announced: string[][] = [];

	const start = async () => {
		fake = createFakePi();
		fake.events.on(WORKSPACE_CHANNEL, (data) => void announced.push((data as { dirs: string[] }).dirs));
		permissionsExtension(fake.pi as never);
		ctx = createFakeCtx({
			cwd,
			hasUI: true,
			mode: "interactive",
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(home, "session"), getBranch: () => [] },
			ui: {
				confirm: vi.fn(async () => confirmAnswer),
				select: vi.fn(async (_title: string, options: string[]) => selectAnswer ?? options.at(-1)),
			},
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "default" });
	};
	const read = (path: string) => fake.fireOne<GateResult>("tool_call", { toolName: "read", input: { path }, toolCallId: `r-${Math.random()}` }, ctx);
	const prompted = () => vi.mocked((ctx.ui as { select: () => unknown }).select).mock.calls.length;

	beforeEach(() => {
		announced.length = 0;
		confirmAnswer = true;
		selectAnswer = undefined;
	});

	it("applies permissions.additionalDirectories from the user's settings and announces them", async () => {
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["../shared"] } }));
		await start();
		expect(listWorkspaceDirectories(cwd, home).map((d) => d.path)).toEqual([shared]);
		expect(await read(join(shared, "notes.md"))).toBeUndefined();
		expect(prompted()).toBe(0);
		expect(announced).toEqual([[shared]]);
	});

	it("asks to trust the repository's directories before applying them", async () => {
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [shared] } }));
		confirmAnswer = false;
		await start();
		expect(announced).toEqual([[]]);
		// Declined: the read asks as any outside read does.
		expect((await read(join(shared, "notes.md")))?.block).toBe(true);
		const confirm = vi.mocked((ctx.ui as { confirm: (t: string, m: string) => unknown }).confirm);
		expect(confirm.mock.calls[0][0]).toBe("Trust this repository's permission settings?");
		expect(String(confirm.mock.calls[0][1])).toContain(`reads inside the workspace directory ${shared}`);
		// Trusted in a new session: applied without a prompt.
		confirmAnswer = true;
		await start();
		expect(await read(join(shared, "notes.md"))).toBeUndefined();
		await start();
		expect(announced.at(-1)).toEqual([shared]);
	});

	it("takes --add-dir, and warns about a directory it cannot use", async () => {
		// The flag registers at load; set it the way pi's CLI would, then start a session.
		await start();
		fake.flags.set("add-dir", `${shared}${process.platform === "win32" ? ";" : ":"}${join(root, "missing")}`);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		expect(await read(join(shared, "notes.md"))).toBeUndefined();
		expect((ctx._notified as Array<{ message: string }>).some((n) => n.message.startsWith(`--add-dir ${join(root, "missing")}:`))).toBe(true);
	});

	it("adds a directory with /add-dir, for the session or remembered in One Code's project settings", async () => {
		await start();
		selectAnswer = "Yes, for this session";
		await fake.commands.get("add-dir")!.handler(shared, ctx);
		expect(await read(join(shared, "notes.md"))).toBeUndefined();
		await fake.fire("session_start", { reason: "new" }, ctx);
		expect((await read(join(shared, "notes.md")))?.block).toBe(true);

		selectAnswer = "Yes, and remember this directory";
		await fake.commands.get("add-dir")!.handler(shared, ctx);
		const saved = JSON.parse(readFileSync(oneCodeProjectSettingsPath(cwd, home), "utf-8"));
		expect(saved.permissions.additionalDirectories).toEqual([shared]);
		await fake.fire("session_start", { reason: "new" }, ctx);
		expect(await read(join(shared, "notes.md"))).toBeUndefined();
	});
});

describe("the system prompt", () => {
	const env = { cwd: "/p", isGitRepo: true, platform: "darwin", osVersion: "x", shell: "zsh", modelLine: "m", memoryDir: "/m" };
	it("lists workspace directories the way Claude Code's environment block does, and nothing when there are none", () => {
		const withDirs = buildClaudeCodeSystemPrompt({} as never, { ...env, workspaceDirs: ["/a", "/b"] }, "frontier");
		expect(withDirs).toContain(" - Working directory: /p\n - Additional working directories:\n  - /a\n  - /b\n - Is a git repository: yes");
		expect(buildClaudeCodeSystemPrompt({} as never, env, "frontier")).toContain(" - Working directory: /p\n - Is a git repository: yes");
	});
});
