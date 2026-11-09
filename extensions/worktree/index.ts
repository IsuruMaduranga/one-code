/**
 * worktree extension — Claude Code's EnterWorktree/ExitWorktree.
 *
 * enter_worktree creates (or switches into) a git worktree under
 * `.claude/worktrees/` (`.onecode/worktrees/` in independent mode) and "moves"
 * the session there. pi fixes a session's cwd
 * at creation, so the move is enforced on the tool_call hook: bash commands
 * are prefixed with `cd`, relative paths resolve against the worktree (see
 * rewrite.ts), and an every-turn reminder keeps the model oriented. State
 * rides in tool-result details so a resumed or branched session restores it;
 * a /clear or /new keeps the worktree, as Claude Code does, by recording it on
 * the new branch.
 */

import { feature } from "../lib/feature.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "../lib/string-enum.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { restoreLatestDetails } from "../lib/branch-restore.ts";
import { checkoutGitRunsProgram } from "../lib/shell/git-checkout-programs.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { absoluteFrom, comparablePath, tryRealpath } from "../lib/paths.ts";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../lib/worktree-channel.ts";
import { namesGit, unlistedWorktreesReason, worktreeBashGuardReason } from "../lib/rules/worktree-guards.ts";
import { worktreePowershellGuardReason } from "./powershell-guards.ts";
import { bashParserReady } from "../lib/bash-parser.ts";
import { ORIGINAL_COMMAND_CHANNEL, type OriginalCommandRecord } from "../lib/original-command.ts";
import { requireText } from "../lib/profile.ts";
import type { EnterWorktreeFailure, RemoveBlocker, WorktreeGuardRefusal } from "./text.ts";
import { rewriteToolInput, validateWorktreeName } from "./rewrite.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { findProjectRoot, HARNESS_GIT_CONFIG, HARNESS_GIT_NO_HOOKS, repositoryWorktrees } from "../lib/git.ts";
import { projectConfigDir, projectConfigDirName } from "../lib/sources.ts";
import { readState, readStringsState, recordState } from "../lib/ledger/state.ts";
import { processState } from "../lib/process-state.ts";

const run = promisify(execFile);
const REMINDER_KEY = "cc-worktree-session";
const WORKTREE_TOOLS = new Set(["enter_worktree", "exit_worktree"]);

interface WorktreeState {
	path: string;
	branch?: string;
	baseCommit?: string;
	createdByUs: boolean;
	originalCwd: string;
	/** Root of the main checkout, even when the session started in a linked worktree. */
	sharedRoot: string;
}

interface WorktreeDetails {
	/** null = session exited the worktree; undefined = tool did not change state. */
	worktreeState?: WorktreeState | null;
}

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await run("git", [...HARNESS_GIT_CONFIG, ...HARNESS_GIT_NO_HOOKS, ...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

async function listWorktreePaths(cwd: string): Promise<string[]> {
	const out = await git(["worktree", "list", "--porcelain"], cwd);
	return out
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

/** The `one-code:state` key of the worktree paths the branch was already told are gone. */
const MISSING_REPORTED_STATE = "worktree:missing-reported";

/** The `one-code:state` key of the worktree a /clear or /new carried onto its new branch. */
const CARRIED_STATE = "worktree:carried";

/**
 * The worktree the session is in, as process state (lib/process-state.ts): a
 * /clear or /new starts an empty branch, and Claude Code keeps the session in
 * its worktree across that (decisions/tools.md). Children never load this
 * extension, so only the main session writes it.
 */
const liveWorktree = () => processState<{ state?: WorktreeState }>("worktree:live", () => ({}));

function isWorktreeState(value: unknown): value is WorktreeState {
	const s = value as Partial<WorktreeState> | null | undefined;
	return typeof s?.path === "string" && typeof s.originalCwd === "string" && typeof s.sharedRoot === "string" && typeof s.createdByUs === "boolean";
}

function worktreeExtension(pi: ExtensionAPI) {
	const text = requireText("worktree");
	const guardWords = requireText("worktreeGuard");
	const block = (refusal: WorktreeGuardRefusal) => ({ block: true, reason: guardWords.refusal(refusal) });
	let state: WorktreeState | undefined;

	const applyState = (next: WorktreeState | undefined, toolCallId?: string) => {
		state = next;
		liveWorktree().state = next;
		const location: WorktreeLocation | null = next ? { path: next.path, branch: next.branch, sharedRoot: next.sharedRoot } : null;
		pi.events.emit(WORKTREE_CHANNEL, location);
		if (next) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: text.reminder(next),
				key: REMINDER_KEY,
				placement: "sticky-append",
				toolCallId,
			});
		} else {
			pi.events.emit(REMINDER_CHANNEL, { key: REMINDER_KEY, remove: true });
		}
	};

	/**
	 * The worktree a /clear or /new keeps: the one this process was in, when it
	 * belongs to this directory and still exists, recorded on the new branch so
	 * a resume of it reads it back. A branch with its own worktree tool results
	 * follows them instead (they come after the carry).
	 */
	const carriedState = (ctx: ExtensionContext, reason: string | undefined): WorktreeState | undefined => {
		// A recorded carry holds only in the directory it was entered from, as
		// the live one does: a branch forked into another project, or continued
		// after its directory went away, starts outside the worktree.
		const enteredHere = (s: WorktreeState) => comparablePath(tryRealpath(s.originalCwd) ?? s.originalCwd) === comparablePath(tryRealpath(ctx.cwd) ?? ctx.cwd);
		const recorded = readState(ctx, CARRIED_STATE);
		if (isWorktreeState(recorded)) return enteredHere(recorded) ? recorded : undefined;
		const live = liveWorktree().state;
		if (reason !== "new" || !live || !existsSync(live.path) || !enteredHere(live)) return undefined;
		recordState(pi, CARRIED_STATE, live);
		return live;
	};

	const reconstructState = (ctx: ExtensionContext, reason?: string) => {
		const details = restoreLatestDetails<WorktreeDetails>(ctx.sessionManager.getBranch(), WORKTREE_TOOLS, (d) => d?.worktreeState !== undefined);
		let restored = details ? (details.worktreeState ?? undefined) : carriedState(ctx, reason);
		if (restored && !existsSync(restored.path)) {
			// Nothing in the tool details records that the session left, so every
			// later restore finds the same stale state; tell the branch once, and
			// record that it was told (a resume, /reload or /tree reads it back).
			const reported = readStringsState(ctx, MISSING_REPORTED_STATE);
			if (!reported.includes(restored.path)) {
				recordState(pi, MISSING_REPORTED_STATE, [...reported, restored.path]);
				pi.events.emit(REMINDER_CHANNEL, {
					text: text.missingOnRestore(restored),
				});
			}
			restored = undefined;
		}
		// Sessions persisted before sharedRoot existed: originalCwd is the best guess.
		if (restored && !restored.sharedRoot) restored = { ...restored, sharedRoot: restored.originalCwd };
		applyState(restored);
	};

	pi.on("session_start", (event, ctx) => reconstructState(ctx, event.reason));
	pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

	/** The repository's worktrees for a git command's target check; undefined when git cannot list them. */
	const otherWorktrees = async (command: string, cwd: string): Promise<string[] | undefined> =>
		namesGit(command) ? repositoryWorktrees(cwd) : [];

	pi.on("tool_call", async (event) => {
		if (!state) return;
		if (WORKTREE_TOOLS.has(event.toolName)) return;
		if (!existsSync(state.path)) {
			return { block: true, reason: text.activeMissing(state) };
		}
		if (["Agent", "SendMessage", "workflow"].includes(event.toolName)) return;
		if (event.toolName === "bash" || event.toolName === "monitor") {
			// Guard before rewriting (and before the permission prompt — this
			// extension loads ahead of permissions): git must verifiably target
			// this worktree, and shared-stash footguns are refused with the recipe.
			// A monitor's command runs through the same bash, so it is judged the same way.
			const command = (event.input as Record<string, unknown>).command;
			if (typeof command === "string") {
				await bashParserReady();
				const others = await otherWorktrees(command, state.path);
				if (others === undefined) return block(unlistedWorktreesReason(state.path));
				const refusal = worktreeBashGuardReason({ command, worktreePath: state.path, sharedRoot: state.sharedRoot, otherWorktrees: others });
				if (refusal) return block(refusal);
			}
		}
		if (event.toolName === "powershell") {
			// The same invariants for PowerShell, the primary shell on Windows.
			const command = (event.input as Record<string, unknown>).command;
			if (typeof command === "string") {
				const others = await otherWorktrees(command, state.path);
				if (others === undefined) return block(unlistedWorktreesReason(state.path));
				const refusal = worktreePowershellGuardReason({ command, worktreePath: state.path, sharedRoot: state.sharedRoot, otherWorktrees: others });
				if (refusal) return block(refusal);
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
		description: text.descriptions.enter_worktree(projectConfigDirName()),
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: text.params.enter.name })),
			path: Type.Optional(Type.String({ description: text.params.enter.path })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (failure: EnterWorktreeFailure) => ({ content: [{ type: "text" as const, text: text.enter.failed(failure) }], details: {} as WorktreeDetails, isError: true });

			if (params.name && params.path) return fail({ kind: "nameAndPath" });
			// An empty `path` string is falsy, so without this it would fall through
			// to *creating* a new worktree instead of reporting the bad argument —
			// the mirror of the empty-`name` case, which is already rejected below.
			if (params.path !== undefined && params.path.length === 0) {
				return fail({ kind: "emptyPath" });
			}

			let repoRoot: string;
			try {
				// git prints `C:/…` on Windows; resolve gives the native form every path built from it shares.
				repoRoot = resolve(await git(["rev-parse", "--show-toplevel"], ctx.cwd));
			} catch {
				return fail({ kind: "notARepository" });
			}

			const sharedRoot = findProjectRoot(repoRoot) ?? repoRoot;
			if (params.path) {
				const known = await listWorktreePaths(ctx.cwd);
				// git lists `C:/…` on Windows, while the model passes the `C:\…` we showed it.
				const requested = absoluteFrom(ctx.cwd, params.path);
				const wanted = comparablePath(tryRealpath(requested) ?? requested);
				const listed = known.find((p) => comparablePath(tryRealpath(p) ?? p) === wanted);
				const target = listed === undefined ? undefined : resolve(listed);
				if (!target) return fail({ kind: "notListed", path: params.path, known });
				if (!existsSync(target)) return fail({ kind: "listedMissing", path: target });
				// The branch is display-only here (footer, reminder): a detached HEAD
				// leaves it unset silently, a failing git is reported in the result text.
				let branch: string | undefined;
				let branchError: string | undefined;
				try {
					const ref = await git(["rev-parse", "--abbrev-ref", "HEAD"], target);
					if (ref && ref !== "HEAD") branch = ref;
				} catch (error) {
					branchError = (error as Error).message.split("\n")[0];
				}
				const next: WorktreeState = { path: target, branch, createdByUs: false, originalCwd: ctx.cwd, sharedRoot };
				applyState(next, toolCallId);
				return {
					content: [{ type: "text", text: text.enter.switched({ session: next, branchError }) }],
					details: { worktreeState: next } satisfies WorktreeDetails,
				};
			}

			// Any active worktree session blocks creating another — not just ones we
			// created. A session entered via `path` has createdByUs:false, and
			// without gating on `state` alone a create-new call silently abandoned it.
			if (state) {
				return fail({ kind: "alreadyActive", path: state.path });
			}

			const name = params.name ?? `wt-${randomBytes(3).toString("hex")}`;
			const nameProblem = validateWorktreeName(name);
			if (nameProblem) return fail({ kind: "invalidName", name, problem: nameProblem });

			// Hooks are disabled by the git wrapper; checkout filters must go through
			// the normal shell permission gate rather than execute implicitly here.
			const program = checkoutGitRunsProgram(repoRoot, homedir(), []);
			if (program) return fail({ kind: "checkoutRunsProgram", program });

			// `.onecode/worktrees` in independent mode (lib/sources.ts).
			const worktreesDir = join(projectConfigDir(repoRoot), "worktrees");
			mkdirSync(worktreesDir, { recursive: true });
			// Self-ignoring directory: worktrees never show up as untracked files.
			const ignorePath = join(worktreesDir, ".gitignore");
			if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n");

			const path = join(worktreesDir, name);
			if (existsSync(path)) return fail({ kind: "exists", path });

			const branch = name.replace(/\//g, "-");
			let baseCommit: string;
			try {
				baseCommit = await git(["rev-parse", "HEAD"], ctx.cwd);
				await git(["worktree", "add", "-b", branch, path, "HEAD"], repoRoot);
			} catch (error) {
				return fail({ kind: "createFailed", osMessage: (error as Error).message });
			}

			const next: WorktreeState = { path, branch, baseCommit, createdByUs: true, originalCwd: ctx.cwd, sharedRoot };
			applyState(next, toolCallId);
			return {
				content: [{ type: "text", text: text.enter.created({ session: next, baseCommit }) }],
				details: { worktreeState: next } satisfies WorktreeDetails,
			};
		},
	});

	pi.registerTool({
		name: "exit_worktree",
		label: "Exit Worktree",
		...ccToolRenderers("Exit Worktree"),
		description: text.descriptions.exit_worktree,
		parameters: Type.Object({
			action: StringEnum(["keep", "remove"] as const, { description: text.params.exit.action }),
			discard_changes: Type.Optional(Type.Boolean({ description: text.params.exit.discard_changes })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				return {
					content: [{ type: "text", text: text.exit.noSession }],
					details: {} satisfies WorktreeDetails,
				};
			}
			const current = state;

			if (params.action === "keep") {
				applyState(undefined);
				return {
					content: [{ type: "text", text: text.exit.kept({ session: current, exists: existsSync(current.path) }) }],
					details: { worktreeState: null } satisfies WorktreeDetails,
				};
			}

			if (!current.createdByUs) {
				return {
					content: [{ type: "text", text: text.exit.notCreatedHere(current) }],
					details: {} satisfies WorktreeDetails,
					isError: true,
				};
			}

			if (!params.discard_changes) {
				const blockers: RemoveBlocker[] = [];
				try {
					const dirty = await git(["status", "--porcelain", "--untracked-files=all"], current.path);
					if (dirty) blockers.push({ kind: "uncommitted", files: dirty });
					if (current.baseCommit && current.branch) {
						const ahead = await git(["rev-list", "--count", "HEAD", `refs/heads/${current.branch}`, `^${current.baseCommit}`], current.path);
						if (ahead !== "0") blockers.push({ kind: "commitsAhead", count: ahead, branch: current.branch });
					} else {
						blockers.push({ kind: "baseUnknown" });
					}
				} catch {
					blockers.push({ kind: "statusUnknown" });
				}
				if (blockers.length > 0) {
					return {
						content: [{ type: "text", text: text.exit.removeRefused({ session: current, blockers }) }],
						details: {} satisfies WorktreeDetails,
						isError: true,
					};
				}
			}

			try {
				await git(["worktree", "remove", ...(params.discard_changes ? ["--force"] : []), current.path], current.originalCwd);
			} catch (error) {
				return {
					content: [{ type: "text", text: text.exit.removeFailed((error as Error).message) }],
					details: {} satisfies WorktreeDetails,
					isError: true,
				};
			}
			applyState(undefined);
			if (current.branch) {
				try {
					// The commit check above (or discard consent) already cleared the branch;
					// -d would also refuse a tip the original checkout's current HEAD lacks.
					await git(["branch", "-D", current.branch], current.originalCwd);
				} catch (error) {
					return {
						content: [{ type: "text", text: text.exit.branchDeleteFailed({ session: current, branch: current.branch, osMessage: (error as Error).message }) }],
						details: { worktreeState: null } satisfies WorktreeDetails,
						isError: true,
					};
				}
			}
			return {
				content: [{ type: "text", text: text.exit.removed(current) }],
				details: { worktreeState: null } satisfies WorktreeDetails,
			};
		},
	});

	for (const [name, keywords] of Object.entries(text.searchKeywords)) {
		pi.events.emit(DEFER_CHANNEL, { name, keywords });
	}
}

export default feature("worktree", worktreeExtension);
