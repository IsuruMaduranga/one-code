/**
 * `/auto-mode setup` — the impure half: gathering facts (exec/fs) and the
 * drafting model call. Parsing, prompts, and validation live in setup.ts; UI
 * wiring in extensions/permissions/index.ts.
 *
 * Gathering is best-effort probe-by-probe: any probe that fails lands in
 * `gatherNotes` instead of the draft silently pretending it ran (the drafting
 * prompt's evidence rules key off those notes). The model call mirrors the
 * classifier's fail-loud shape — no reasoning/temperature, hard timeout, and a
 * parse failure throws rather than persisting a half-read draft — but tries
 * the SESSION model first: drafting wants the most capable model available,
 * where the per-call classifier wants small-and-contained.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AutoModeConfig } from "./config.ts";
import { classifierCandidates, replyText, withAuthBaseUrl } from "./model-select.ts";
import { buildSetupPrompt, parseGitRemotes, redactSecrets, type SetupDraft, parseSetupDraft, type SetupFacts } from "./setup.ts";

const PROBE_TIMEOUT_MS = 10_000;
/** Drafting reads a big fact dump and writes a full slot list — give it room. */
const DRAFT_TIMEOUT_MS = 120_000;
const DRAFT_MAX_TOKENS = 8192;
const CLAUDE_MD_LIMIT = 4_000;
const HISTORY_LINES = 200;

/** One probe: run a command, return trimmed stdout, or undefined on any failure. */
function probe(cmd: string, args: string[], cwd: string, notes: string[], what: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) {
				notes.push(`${what} was not gathered (${cmd} failed: ${error.message.split("\n")[0]})`);
				resolve(undefined);
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

/**
 * Read a file if it exists, truncated to `limit`. A file that exists but
 * cannot be read is NOT the same as no file: it lands in `notes` so the
 * drafting prompt's evidence rules see "present but unreadable" rather than
 * silently treating it as absent.
 */
const readIfPresent = (path: string, limit: number, notes: string[], what: string): string | undefined => {
	try {
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf-8");
		return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
	} catch (error) {
		notes.push(`${what} exists but could not be read (${(error as Error).message.split("\n")[0]})`);
		return undefined;
	}
};

export interface GatherOptions {
	cwd: string;
	home: string;
	username: string;
	/** The user's answer to the usage question, verbatim. */
	usage: string;
	includeShellHistory: boolean;
}

export async function gatherFacts(options: GatherOptions): Promise<SetupFacts> {
	const { cwd, home } = options;
	const notes: string[] = [];

	const gitRoot = await probe("git", ["rev-parse", "--show-toplevel"], cwd, notes, "git root");
	// The three follow-ups depend only on gitRoot, not on each other — run them
	// concurrently so a slow `gh` (network) does not stack on the local git calls.
	const [remotesRaw, branch, ghRaw] = gitRoot
		? await Promise.all([
				probe("git", ["remote", "-v"], cwd, notes, "git remotes"),
				probe("git", ["branch", "--show-current"], cwd, notes, "current branch"),
				// gh gives visibility/default branch for the repo the cwd is in; treat
				// its absence as "unknown", never as "private".
				probe("gh", ["repo", "view", "--json", "visibility,nameWithOwner,defaultBranchRef"], cwd, notes, "repository visibility (gh)"),
			])
		: [undefined, undefined, undefined];

	let repoVisibility: string | undefined;
	let repoNameWithOwner: string | undefined;
	let defaultBranch: string | undefined;
	if (ghRaw) {
		try {
			const parsed = JSON.parse(ghRaw) as {
				visibility?: string;
				nameWithOwner?: string;
				defaultBranchRef?: { name?: string };
			};
			repoVisibility = parsed.visibility;
			repoNameWithOwner = parsed.nameWithOwner;
			defaultBranch = parsed.defaultBranchRef?.name;
		} catch {
			notes.push("gh repo view returned unparseable JSON — repository visibility unknown");
		}
	}

	let shellHistory: string[] | undefined;
	if (options.includeShellHistory) {
		const histFile = [process.env.HISTFILE, join(home, ".zsh_history"), join(home, ".bash_history")]
			.filter((path): path is string => !!path)
			.find((path) => existsSync(path));
		if (histFile) {
			const raw = readIfPresent(histFile, 1024 * 1024, notes, "shell history") ?? "";
			shellHistory = raw
				.split("\n")
				.slice(-HISTORY_LINES)
				// zsh extended history stamps "": 1699999999:0;cmd" — keep the command half.
				.map((line) => redactSecrets(line.replace(/^:\s*\d+:\d+;/, "").trim()))
				.filter(Boolean);
		} else {
			notes.push("no shell history file found — usage patterns not gathered");
		}
	} else {
		notes.push("shell history scan declined by the user");
	}

	// User-scope permissions.allow — audit input, and evidence for carve-outs.
	let permissionsAllow: string[] = [];
	try {
		const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")) as {
			permissions?: { allow?: unknown };
		};
		if (Array.isArray(settings.permissions?.allow)) {
			permissionsAllow = settings.permissions.allow.filter((entry): entry is string => typeof entry === "string");
		}
	} catch {
		notes.push("user settings permissions.allow could not be read");
	}

	return {
		cwd,
		username: options.username,
		usage: options.usage,
		gitRoot: gitRoot || undefined,
		remotes: remotesRaw ? parseGitRemotes(remotesRaw) : [],
		currentBranch: branch || undefined,
		repoVisibility,
		repoNameWithOwner,
		defaultBranch,
		claudeMdProject: readIfPresent(join(gitRoot || cwd, "CLAUDE.md"), CLAUDE_MD_LIMIT, notes, "project CLAUDE.md"),
		claudeMdGlobal: readIfPresent(join(home, ".claude", "CLAUDE.md"), CLAUDE_MD_LIMIT, notes, "global CLAUDE.md"),
		shellHistory,
		permissionsAllow,
		gatherNotes: notes,
	};
}

export interface DraftDeps {
	registry: ModelRegistry;
	sessionModel: Model<Api> | undefined;
	config: AutoModeConfig;
	defaultEnvironment: string[];
	signal?: AbortSignal;
}

/**
 * Draft the setup with the most capable model reachable: the session model
 * first, then the classifier candidate chain. Throws on total failure or an
 * unusable draft — the wizard has a user in front of it; nothing here may
 * persist silently wrong.
 */
export async function draftSetup(facts: SetupFacts, deps: DraftDeps): Promise<SetupDraft> {
	const chain = classifierCandidates({
		available: deps.registry.getAvailable(),
		sessionModel: deps.sessionModel,
		configured: deps.config.classifierModel,
		configuredSetForContainment: deps.config.classifierModelSetFor,
	}).candidates.map((entry) => entry.model);
	const models: Model<Api>[] = [];
	for (const model of deps.sessionModel ? [deps.sessionModel, ...chain] : chain) {
		if (!models.some((seen) => seen.provider === model.provider && seen.id === model.id)) models.push(model);
	}
	if (models.length === 0) throw new Error("no model is available to draft the setup");

	const { system, user } = buildSetupPrompt(facts, deps.defaultEnvironment);
	let lastError = "";
	for (const model of models) {
		const auth = await deps.registry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			lastError = auth.error;
			continue;
		}
		const resolved = withAuthBaseUrl(model, auth);
		const timeout = AbortSignal.timeout(DRAFT_TIMEOUT_MS);
		const reply = await completeSimple(
			resolved,
			{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
				maxTokens: DRAFT_MAX_TOKENS,
			},
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			if (deps.signal?.aborted) throw new Error("setup drafting was cancelled");
			lastError = reply.errorMessage ?? reply.stopReason;
			continue; // a dead model steps to the next candidate; a bad draft does not
		}
		if (reply.stopReason === "length") {
			lastError = "draft truncated at maxTokens";
			continue;
		}
		// Parse errors are NOT stepped past: the model responded, its output is
		// unusable, and retrying a different model would hide a prompt bug.
		return parseSetupDraft(replyText(reply), deps.defaultEnvironment);
	}
	throw new Error(`no model could draft the setup (last error: ${lastError})`);
}
