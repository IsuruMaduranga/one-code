/**
 * Where One Code keeps the user's consent to a repository's own
 * configuration (pure).
 *
 * Each store records that the user approved something a checkout ships, keyed
 * by a hash the model can compute: its hooks, its `.mcp.json` servers, its
 * allow rules and workspace directories, and the language servers that run
 * its build. An entry is standing permission, so a write to a store is a
 * gate-control write: the auto-mode safety floor stops it
 * (`auto-mode/safety-floor.ts`), and a classifier that was talked around
 * never gets to approve it. One home for the paths, so a new store cannot be
 * left off the floor.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { oneCodeStateDir } from "./paths.ts";

/** Each consent store, relative to One Code's state dir. */
const CONSENT_STORES = {
	hooks: ["hooks", "project-approvals.json"],
	mcp: ["mcp", "project-approvals.json"],
	projectAllow: ["permissions", "project-allow-approvals.json"],
	lsp: ["lsp", "trusted-projects.json"],
} as const;

export type ConsentStore = keyof typeof CONSENT_STORES;

/** One consent store's file, under `ONECODE_STATE_DIR` when it is set. */
export function consentStorePath(store: ConsentStore, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	return join(oneCodeStateDir(env, home), ...CONSENT_STORES[store]);
}

/** Every consent store's file, for the safety floor. */
export function consentStorePaths(home: string, env: Record<string, string | undefined> = process.env): string[] {
	return (Object.keys(CONSENT_STORES) as ConsentStore[]).map((store) => consentStorePath(store, env, home));
}

/**
 * A consent store under any literal `.onecode` directory, as a forward-slashed
 * path tail: the textual floor's counterpart of `consentStorePaths`, for a
 * store in another home or spelled through a symlink the resolver missed.
 */
export const CONSENT_STORE_TAIL = new RegExp(
	`/\\.onecode/(${Object.values(CONSENT_STORES)
		.map((parts) => parts.join("/").replace(/[.]/g, "\\."))
		.join("|")})$`,
);
