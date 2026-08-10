/**
 * Tested-pi-version guard for the package install path.
 *
 * The package rides on whatever pi the user has installed, and pi renames
 * settings/flags between minor versions (0.83→0.84 renamed `uiMode` to
 * `tuiMode`, and 0.84 rejects the old flag). A user who floats onto an
 * untested pi hits silent breakage, so startup compares the running pi
 * version to the range this release was verified against and warns — softly,
 * never blocking — when outside it. The bundled `one-code` app pins pi inside
 * the range, so it never warns.
 */

/** Inclusive minimum and exclusive maximum pi version this release is tested against. */
export const TESTED_PI_MIN = "0.83.0";
export const TESTED_PI_MAX_EXCLUSIVE = "0.85.0";

/** Dotted-numeric parse; undefined for anything that is not plain x.y.z numbers. */
export function parseVersion(version: string): number[] | undefined {
	const parts = version.trim().split(".");
	if (parts.length === 0 || parts.length > 3) return undefined;
	const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
	return nums.some(Number.isNaN) ? undefined : nums;
}

/** Standard triple compare; undefined when either side is unparseable. */
export function compareVersions(a: string, b: string): number | undefined {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return undefined;
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * A warning line when the running pi is outside the tested range, undefined
 * when in range or the version cannot be parsed (fail silent — a guard must
 * never take the session down).
 */
export function piVersionWarning(runningPiVersion: string | undefined): string | undefined {
	if (!runningPiVersion) return undefined;
	const belowMin = compareVersions(runningPiVersion, TESTED_PI_MIN);
	const atOrAboveMax = compareVersions(runningPiVersion, TESTED_PI_MAX_EXCLUSIVE);
	if (belowMin === undefined || atOrAboveMax === undefined) return undefined;
	if (belowMin >= 0 && atOrAboveMax < 0) return undefined;
	const tested = `${TESTED_PI_MIN} – <${TESTED_PI_MAX_EXCLUSIVE}`;
	return (
		`one-code-extension is tested against pi ${tested}; you are running pi ${runningPiVersion}. ` +
		`Things may still work, but if tools or settings misbehave, update one-code-extension ` +
		`(or pin pi inside the tested range).`
	);
}
