/**
 * worktree extension — Claude Code's EnterWorktree/ExitWorktree.
 *
 * enter_worktree creates (or switches into) a git worktree under
 * `.claude/worktrees/` (`.onecode/worktrees/` in independent mode) and "moves"
 * the session there. pi fixes a session's cwd
 * at creation, so the move is enforced on the tool_call hook: bash commands
 * are prefixed with `cd`, relative paths resolve against the worktree (see
 * rewrite.ts), and an every-turn reminder keeps the model oriented. State
 * rides in tool-result details so a resumed or branched session restores it.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { restoreLatestDetails } from "../lib/branch-restore.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { absoluteFrom, comparablePath } from "../lib/paths.ts";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../lib/worktree-channel.ts";
import { namesGit, unlistedWorktreesReason, worktreeBashGuardReason } from "./guards.ts";
import { worktreePowershellGuardReason } from "./powershell-guards.ts";
import { bashParserReady } from "../lib/bash-parser.ts";
import { ORIGINAL_COMMAND_CHANNEL, type OriginalCommandRecord } from "../lib/original-command.ts";
import { enterWorktreeDescription, ENTER_WORKTREE_PARAMS, EXIT_WORKTREE_DESCRIPTION, EXIT_WORKTREE_PARAMS } from "./descriptions.ts";
import { rewriteToolInput, validateWorktreeName } from "./rewrite.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { HARNESS_GIT_CONFIG, repositoryWorktrees } from "../lib/git.ts";
import { projectConfigDir, projectConfigDirName } from "../lib/config-mode.ts";

const run = promisify(execFile);
const REMINDER_KEY = "cc-worktree-session";
const WORKTREE_TOOLS = new Set(["enter_worktree", "exit_worktree"]);

interface WorktreeState {
	path: string;
	branch?: string;
	baseCommit?: string;
	createdByUs: boolean;
	originalCwd: string;
	/** Root of the shared checkout (`git rev-parse --show-toplevel` at entry). */
	sharedRoot: string;
}

interface WorktreeDetails {
	/** null = session exited the worktree; undefined = tool did not change state. */
	worktreeState?: WorktreeState | null;
}

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await run("git", [...HARNESS_GIT_CONFIG, ...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

async function listWorktreePaths(cwd: string): Promise<string[]> {
	const out = await git(["worktree", "list", "--porcelain"], cwd);
	return out
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

/**
 * The worktree git-isolation guard, said when the session enters: before it,
 * GPT-6 Sol and Astra both ran a read-only `git -C <main checkout> status`
 * and met the refusal with no warning (2026-10-04 self-test).
 */
const ISOLATION_NOTE = "Git commands aimed at the main checkout or another worktree of this repository are refused until you exit.";

export default function worktreeExtension(pi: ExtensionAPI) {
	let state: WorktreeState | undefined;

	const reminderFor = (s: WorktreeState) =>
		`Worktree session active: you are working in the git worktree at ${s.path}` +
		`${s.branch ? ` (branch ${s.branch})` : ""}, not in ${s.originalCwd}. ` +
		"Relative paths and bash commands already run there. Use exit_worktree to leave when the user asks.";

	const applyState = (next: WorktreeState | undefined, toolCallId?: string) => {
		state = next;
		const location: WorktreeLocation | null = next ? { path: next.path, branch: next.branch, sharedRoot: next.sharedRoot } : null;
		pi.events.emit(WORKTREE_CHANNEL, location);
		if (next) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: reminderFor(next),
				scope: "every-turn",
				key: REMINDER_KEY,
				placement: "sticky-append",
				toolCallId,
			});
		} else {
			pi.events.emit(REMINDER_CHANNEL, { key: REMINDER_KEY, remove: true });
		}
	};

	const reconstructState = (ctx: ExtensionContext) => {
		const details = restoreLatestDetails<WorktreeDetails>(ctx.sessionManager.getBranch(), WORKTREE_TOOLS, (d) => d?.worktreeState !== undefined);
		let restored = details?.worktreeState ?? undefined;
		if (restored && !existsSync(restored.path)) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `Left worktree session; back in ${restored.originalCwd}. The worktree at ${restored.path} no longer exists.`,
			});
			restored = undefined;
		}
		// Sessions persisted before sharedRoot existed: originalCwd is the best guess.
		if (restored && !restored.sharedRoot) restored = { ...restored, sharedRoot: restored.originalCwd };
		applyState(restored);
	};

	pi.on("session_start", (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

	/** The repository's worktrees for a git command's target check; undefined when git cannot list them. */
	const otherWorktrees = async (command: string, cwd: string): Promise<string[] | undefined> =>
		namesGit(command) ? repositoryWorktrees(cwd) : [];

	pi.on("tool_call", async (event) => {
		if (!state) return;
		if (["enter_worktree", "exit_worktree", "Agent", "SendMessage", "workflow"].includes(event.toolName)) return;
		if (event.toolName === "bash" || event.toolName === "monitor") {
			// Guard before rewriting (and before the permission prompt — this
			// extension loads ahead of permissions): git must verifiably target
			// this worktree, and shared-stash footguns are refused with the recipe.
			// A monitor's command runs through the same bash, so it is judged the same way.
			const command = (event.input as Record<string, unknown>).command;
			if (typeof command === "string") {
				await bashParserReady();
				const others = await otherWorktrees(command, state.path);
				if (others === undefined) return { block: true, reason: unlistedWorktreesReason(state.path) };
				const reason = worktreeBashGuardReason({ command, worktreePath: state.path, sharedRoot: state.sharedRoot, otherWorktrees: others });
				if (reason) return { block: true, reason };
			}
		}
		if (event.toolName === "powershell") {
			// The same invariants for PowerShell, the primary shell on Windows.
			const command = (event.input as Record<string, unknown>).command;
			if (typeof command === "string") {
				const others = await otherWorktrees(command, state.path);
				if (others === undefined) return { block: true, reason: unlistedWorktreesReason(state.path) };
				const reason = worktreePowershellGuardReason({ command, worktreePath: state.path, sharedRoot: state.sharedRoot, otherWorktrees: others });
				if (reason) return { block: true, reason };
			}
		}
		const { originalCommand } = rewriteToolInput(event.toolName, event.input as Record<string, unknown>, state.path);
		if (originalCommand !== undefined) {
			const record: OriginalCommandRecord = { toolCallId: event.toolCallId, command: originalCommand, cwd: state.path };
			pi.events.emit(ORIGINAL_COMMAND_CHANNEL, record);
		}
	});

	pi.registerTool({
		name: "enter_worktree",
		label: "Enter Worktree",
		...ccToolRenderers("Enter Worktree"),
		description: enterWorktreeDescription(projectConfigDirName()),
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: ENTER_WORKTREE_PARAMS.name })),
			path: Type.Optional(Type.String({ description: ENTER_WORKTREE_PARAMS.path })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} as WorktreeDetails, isError: true });

			if (params.name && params.path) return fail("Pass either `name` or `path`, not both.");
			// An empty `path` string is falsy, so without this it would fall through
			// to *creating* a new worktree instead of reporting the bad argument —
			// the mirror of the empty-`name` case, which is already rejected below.
			if (params.path !== undefined && params.path.length === 0) {
				return fail("`path` was empty — pass an existing worktree path from `git worktree list`, or omit `path` to create a new worktree.");
			}

			let repoRoot: string;
			try {
				// git prints `C:/…` on Windows; resolve gives the native form every path built from it shares.
				repoRoot = resolve(await git(["rev-parse", "--show-toplevel"], ctx.cwd));
			} catch {
				return fail("enter_worktree needs a git repository; this directory is not one.");
			}

			if (params.path) {
				const known = await listWorktreePaths(ctx.cwd);
				// git lists `C:/…` on Windows, while the model passes the `C:\…` we showed it.
				const wanted = comparablePath(absoluteFrom(ctx.cwd, params.path));
				const listed = known.find((p) => comparablePath(p) === wanted);
				const target = listed === undefined ? undefined : resolve(listed);
				if (!target) return fail(`${params.path} is not a worktree of this repository. Known worktrees:\n${known.join("\n")}`);
				// The branch is display-only here (footer, reminder): a detached HEAD
				// leaves it unset silently, a failing git is reported in the result text.
				let branch: string | undefined;
				let branchNote = "";
				try {
					const ref = await git(["rev-parse", "--abbrev-ref", "HEAD"], target);
					if (ref && ref !== "HEAD") branch = ref;
				} catch (error) {
					branchNote = ` Its branch could not be read (${(error as Error).message.split("\n")[0]}).`;
				}
				const next: WorktreeState = { path: target, branch, createdByUs: false, originalCwd: ctx.cwd, sharedRoot: repoRoot };
				applyState(next, toolCallId);
				return {
					content: [{ type: "text", text: `Switched into existing worktree ${target}${branch ? ` (branch ${branch})` : ""}.${branchNote} All work now happens there; exit_worktree returns to ${ctx.cwd}. ${ISOLATION_NOTE}` }],
					details: { worktreeState: next } satisfies WorktreeDetails,
				};
			}

			// Any active worktree session blocks creating another — not just ones we
			// created. A session entered via `path` has createdByUs:false, and
			// without gating on `state` alone a create-new call silently abandoned it.
			if (state) {
				return fail(`Already in a worktree session (${state.path}). exit_worktree first, or switch with \`path\` to another worktree.`);
			}

			const name = params.name ?? `wt-${randomBytes(3).toString("hex")}`;
			const nameError = validateWorktreeName(name);
			if (nameError) return fail(`Invalid worktree name "${name}": ${nameError}`);

			// `.onecode/worktrees` in independent mode (lib/config-mode.ts).
			const worktreesDir = join(projectConfigDir(repoRoot), "worktrees");
			mkdirSync(worktreesDir, { recursive: true });
			// Self-ignoring directory: worktrees never show up as untracked files.
			const ignorePath = join(worktreesDir, ".gitignore");
			if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n");

			const path = join(worktreesDir, name);
			if (existsSync(path)) return fail(`Worktree ${path} already exists — pass it as \`path\` to switch into it.`);

			const branch = name.replace(/\//g, "-");
			let baseCommit: string;
			try {
				baseCommit = await git(["rev-parse", "HEAD"], ctx.cwd);
				await git(["worktree", "add", "-b", branch, path, "HEAD"], repoRoot);
			} catch (error) {
				return fail(`Could not create worktree: ${(error as Error).message}`);
			}

			const next: WorktreeState = { path, branch, baseCommit, createdByUs: true, originalCwd: ctx.cwd, sharedRoot: repoRoot };
			applyState(next, toolCallId);
			return {
				content: [
					{
						type: "text",
						text: `Created worktree ${path} on branch ${branch} (from HEAD ${baseCommit.slice(0, 8)}). All commands and relative paths now run there; exit_worktree returns to ${ctx.cwd}. ${ISOLATION_NOTE}`,
					},
				],
				details: { worktreeState: next } satisfies WorktreeDetails,
			};
		},
	});

	pi.registerTool({
		name: "exit_worktree",
		label: "Exit Worktree",
		...ccToolRenderers("Exit Worktree"),
		description: EXIT_WORKTREE_DESCRIPTION,
		parameters: Type.Object({
			action: StringEnum(["keep", "remove"] as const, { description: EXIT_WORKTREE_PARAMS.action }),
			discard_changes: Type.Optional(Type.Boolean({ description: EXIT_WORKTREE_PARAMS.discard_changes })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				return {
					content: [{ type: "text", text: "No worktree session is active; nothing to exit." }],
					details: {} satisfies WorktreeDetails,
				};
			}
			const current = state;

			if (params.action === "keep") {
				applyState(undefined);
				return {
					content: [
						{
							type: "text",
							text: `Left worktree session; back in ${current.originalCwd}. The worktree remains at ${current.path}${current.branch ? ` (branch ${current.branch})` : ""} — re-enter it with enter_worktree {path}.`,
						},
					],
					details: { worktreeState: null } satisfies WorktreeDetails,
				};
			}

			if (!current.createdByUs) {
				return {
					content: [
						{ type: "text", text: `This worktree (${current.path}) was not created by enter_worktree in this session — exit with action: "keep" and remove it manually if intended.` },
					],
					details: {} satisfies WorktreeDetails,
					isError: true,
				};
			}

			if (!params.discard_changes) {
				const blockers: string[] = [];
				try {
					const dirty = await git(["status", "--porcelain"], current.path);
					if (dirty) blockers.push(`Uncommitted changes:\n${dirty}`);
					if (current.baseCommit && current.branch) {
						const ahead = await git(["rev-list", "--count", `${current.baseCommit}..${current.branch}`], current.path);
						if (ahead !== "0") blockers.push(`${ahead} commit(s) on ${current.branch} not on the original branch.`);
					}
				} catch {
					blockers.push("Could not verify the worktree is clean.");
				}
				if (blockers.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Refusing to remove ${current.path}:\n\n${blockers.join("\n\n")}\n\nConfirm with the user, then re-invoke with discard_changes: true — or exit with action: "keep".`,
							},
						],
						details: {} satisfies WorktreeDetails,
						isError: true,
					};
				}
			}

			try {
				await git(["worktree", "remove", "--force", current.path], current.originalCwd);
				if (current.branch) await git(["branch", "-D", current.branch], current.originalCwd);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not remove the worktree: ${(error as Error).message}` }],
					details: {} satisfies WorktreeDetails,
					isError: true,
				};
			}
			applyState(undefined);
			return {
				content: [{ type: "text", text: `Removed worktree ${current.path}${current.branch ? ` and branch ${current.branch}` : ""}; back in ${current.originalCwd}.` }],
				details: { worktreeState: null } satisfies WorktreeDetails,
			};
		},
	});

	for (const [name, keywords] of Object.entries({
		enter_worktree: ["worktree", "isolate", "branch", "checkout"],
		exit_worktree: ["worktree", "leave", "return", "cleanup"],
	})) {
		pi.events.emit(DEFER_CHANNEL, { name, keywords });
	}
}
