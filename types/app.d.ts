/**
 * Types for the plain-JS update-check module (extensions/lib/update-check.mjs),
 * shared by the bundled app and the doctor; tsc has no allowJs, so the
 * extension code and the unit tests see it through this declaration.
 */
declare module "*/lib/update-check.mjs" {
	export const APP_PACKAGE: string;
	export const EXTENSION_PACKAGE: string;
	export const HOMEBREW_FORMULA: string;
	export const UPGRADE_COMMANDS: { npm: string; brew: string; "pi-package": string };
	export function registryPackumentUrl(name: string): string;
	export const CHECK_INTERVAL_MS: number;
	export const HOMEBREW_MIN_RELEASE_AGE_MS: number;
	export function minReleaseAgeFor(env?: Record<string, string | undefined>): number;
	export function isNewerVersion(candidate: string, current: string): boolean;
	export function pickAvailableVersion(
		packument: unknown,
		options?: { minReleaseAgeMs?: number; now?: number },
	): string | undefined;
	export function isOffline(env?: Record<string, string | undefined>): boolean;
	export function checkedRecently(stampPath: string | undefined, now?: number): boolean;
	export function createUpdateCheck(options: {
		currentVersion: string;
		upgradeHint: string;
		stampPath?: string;
		minReleaseAgeMs?: number;
	}): (pi: unknown) => void;
}
