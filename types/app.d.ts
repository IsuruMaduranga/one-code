/** Types for the bundled app's plain-JS modules (app/), used by unit tests. */
declare module "*/app/update-check.mjs" {
	export const CHECK_INTERVAL_MS: number;
	export function isNewerVersion(candidate: string, current: string): boolean;
	export function isOffline(env?: Record<string, string | undefined>): boolean;
	export function checkedRecently(stampPath: string | undefined, now?: number): boolean;
	export function createUpdateCheck(options: {
		currentVersion: string;
		upgradeHint: string;
		stampPath?: string;
	}): (pi: unknown) => void;
}
