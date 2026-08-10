/** Types for the bundled app's plain-JS modules (app/), used by unit tests. */
declare module "*/app/update-check.mjs" {
	export function isNewerVersion(candidate: string, current: string): boolean;
	export function createUpdateCheck(options: { currentVersion: string; upgradeHint: string }): (pi: unknown) => void;
}
