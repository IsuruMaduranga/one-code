/**
 * Consent before a language server that runs the project's own code (pure fs).
 *
 * The LSP extension starts a server after any edit, outside the permission
 * gate. Most servers only parse, but some execute the project as part of their
 * job: rust-analyzer runs `build.rs` build scripts and proc macros (and cargo
 * honours a `rust-toolchain.toml` that can name any toolchain binary), and
 * jdtls imports Gradle and Maven builds by running them. In an untrusted
 * checkout, an approved edit to one `.rs` file therefore also ran the
 * repository's build script (SECURITY-REVIEW-2026-09-23 M4). Those servers now
 * start only in a project the user has trusted: once per project root,
 * persisted under `~/.onecode`, asked on first use in an interactive session
 * or granted with `/lsp trust`. With no UI they stay off (fails closed, like
 * project hooks and `.mcp.json` servers). Plugin-provided servers never ask:
 * installing the plugin was the consent.
 */

import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../lib/atomic-write.ts";
import { comparablePath, isPathAtOrUnder, oneCodeStateDir } from "../lib/paths.ts";
import { singleFlight } from "../lib/single-flight.ts";

/** Built-in server commands that execute project code. */
export const PROJECT_CODE_SERVERS: ReadonlySet<string> = new Set(["rust-analyzer", "jdtls"]);

/** What each of those runs, for the consent dialog and the not-started notice. */
export const PROJECT_CODE_REASON: Record<string, string> = {
	"rust-analyzer": "runs this project's build scripts and proc macros",
	jdtls: "runs this project's Gradle or Maven build to import it",
};

interface TrustStore {
	version: 1;
	roots: Record<string, { trustedAt: string }>;
}

export function lspTrustStorePath(): string {
	return join(oneCodeStateDir(), "lsp", "trusted-projects.json");
}

function readStore(storePath: string): TrustStore {
	const store = readJsonFile<TrustStore>(storePath);
	return store && typeof store === "object" && store.roots && typeof store.roots === "object" ? store : { version: 1, roots: {} };
}

/** Whether `serverRoot` lies at or under a trusted project root. */
export function isLspRootTrusted(serverRoot: string, storePath = lspTrustStorePath()): boolean {
	const target = comparablePath(serverRoot);
	return Object.keys(readStore(storePath).roots).some((root) => isPathAtOrUnder(target, comparablePath(root)));
}

/** Trust a project root (and everything under it) for project-code servers. */
export function persistLspTrust(projectRoot: string, storePath = lspTrustStorePath()): void {
	const store = readStore(storePath);
	store.roots[projectRoot] = { trustedAt: new Date().toISOString() };
	try {
		writeJsonAtomic(storePath, store, { mode: 0o600 });
	} catch {
		// Trust still holds for this session through the caller's own memory.
	}
}

/**
 * The per-session trust decision for project-code servers. Every answer is
 * keyed by the project the SERVER runs in (the repository holding its root),
 * never the session's cwd: trusting the current checkout must not start a
 * server rooted in another one (PR #8 review). One question per project is in
 * flight at a time; a "yes" is persisted, a "no" holds for the session.
 */
export function createLspTrustGate(deps: {
	/** The project a directory belongs to (its repository root, or itself). */
	projectRoot: (dir: string) => string;
	isTrusted?: (serverRoot: string) => boolean;
	persist?: (projectRoot: string) => void;
}) {
	const { projectRoot, isTrusted = (root: string) => isLspRootTrusted(root), persist = (root: string) => persistLspTrust(root) } = deps;
	const sessionTrust = new Map<string, boolean>();
	/** Server roots found trusted on disk this process, so the store is read once per root. */
	const trustedServerRoots = new Set<string>();
	const askOnce = singleFlight<boolean>();
	return {
		/**
		 * Whether a server rooted at `serverRoot` may start. Without `confirm`
		 * (no UI), or after a "no" for its project, only stored trust counts.
		 */
		async allowed(serverRoot: string, confirm?: (projectRoot: string) => Promise<boolean>): Promise<boolean> {
			const root = projectRoot(serverRoot);
			if (sessionTrust.get(root) === true || trustedServerRoots.has(serverRoot)) return true;
			// The project root is what a "yes" persists; a linked worktree outside
			// its main checkout is not under it, so both are checked.
			if (isTrusted(serverRoot) || isTrusted(root)) {
				trustedServerRoots.add(serverRoot);
				return true;
			}
			if (sessionTrust.get(root) !== undefined || !confirm) return false;
			return askOnce(root, async () => {
				const ok = await confirm(root);
				sessionTrust.set(root, ok);
				if (ok) persist(root);
				return ok;
			});
		},
		/** `/lsp trust`: trust the project `dir` belongs to, persisted. Returns that project root. */
		trust(dir: string): string {
			const root = projectRoot(dir);
			persist(root);
			sessionTrust.set(root, true);
			return root;
		},
	};
}
