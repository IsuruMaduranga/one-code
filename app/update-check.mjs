/**
 * One Code's own update notice, replacing pi's (which is suppressed via
 * PI_SKIP_VERSION_CHECK — its endpoint is hardcoded to pi's registry and
 * cannot be pointed at one-code).
 *
 * Mirrors pi's behaviour: entirely non-blocking, and silent on any failure —
 * an update hint must never cost startup time or surface a network error.
 * Honours pi's offline switch (`--offline` sets PI_OFFLINE=1 before extensions
 * load) and runs at most once a day per agent dir, stamped in
 * `<agentDir>/last-update-check` (pi's own check is per session start; a
 * daily cadence spares the registry on every TUI launch). pi's semver helpers
 * are not exported from the package root, so the dotted-numeric compare lives
 * here.
 */

import { readFileSync, writeFileSync } from "node:fs";

// Scoped package: the slash must be percent-encoded in registry GETs. The full
// packument (not `/latest`) because its `time` map dates every version, which
// the Homebrew hint needs (see pickAvailableVersion).
const REGISTRY_URL = "https://registry.npmjs.org/@one-ai%2Fone-code";
const TIMEOUT_MS = 3000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Homebrew's `std_npm_args` passes npm `--min-release-age=1`, so a version
 * becomes brew-installable only a day after its npm publish. A Homebrew user
 * told about a fresher version would run `brew upgrade onecode` and get
 * nothing, so the hint for that install method waits the same day.
 */
export const HOMEBREW_MIN_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;

/** pi's truthy-flag reading for PI_OFFLINE (1/true/yes). */
export function isOffline(env = process.env) {
	return /^(1|true|yes)$/i.test(String(env.PI_OFFLINE ?? "").trim());
}

/** True when the stamp file records a check within the interval; unreadable/missing stamps count as due. */
export function checkedRecently(stampPath, now = Date.now()) {
	if (!stampPath) return false;
	try {
		const last = Number(readFileSync(stampPath, "utf8").trim());
		return Number.isFinite(last) && now - last >= 0 && now - last < CHECK_INTERVAL_MS;
	} catch {
		return false;
	}
}

/** True when `candidate` is a strictly newer x.y.z than `current`. */
export function isNewerVersion(candidate, current) {
	const parse = (v) => {
		const parts = String(v).trim().split(".");
		if (parts.length === 0 || parts.length > 3) return undefined;
		const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
		return nums.some(Number.isNaN) ? undefined : nums;
	};
	const a = parse(candidate);
	const b = parse(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

/**
 * The newest version in a registry packument worth announcing, or undefined.
 * With no minimum age this is `dist-tags.latest` (what `npm install -g`
 * fetches). With one, it is the newest x.y.z version whose `time` entry is at
 * least that old — the newest one a `--min-release-age` install can see.
 * Prerelease tags never qualify (isNewerVersion rejects them).
 */
export function pickAvailableVersion(packument, { minReleaseAgeMs = 0, now = Date.now() } = {}) {
	if (!packument || typeof packument !== "object") return undefined;
	const latest = packument["dist-tags"]?.latest;
	if (minReleaseAgeMs <= 0) return typeof latest === "string" ? latest : undefined;
	const time = packument.time;
	if (!time || typeof time !== "object") return undefined;
	let best;
	for (const [version, published] of Object.entries(time)) {
		if (version === "created" || version === "modified") continue;
		const publishedAt = Date.parse(published);
		if (!Number.isFinite(publishedAt) || now - publishedAt < minReleaseAgeMs) continue;
		if (!/^\d+\.\d+\.\d+$/.test(version)) continue; // prereleases never qualify
		if (best === undefined || isNewerVersion(version, best)) best = version;
	}
	return best;
}

export function createUpdateCheck({ currentVersion, upgradeHint, stampPath, minReleaseAgeMs = 0 }) {
	return function updateCheckExtension(pi) {
		pi.on("session_start", (_event, ctx) => {
			if (process.env.ONECODE_NO_UPDATE_CHECK === "1") return;
			if (isOffline()) return;
			if (!ctx.hasUI) return; // print/rpc runs stay clean for parsers
			if (checkedRecently(stampPath)) return;
			// Fire-and-forget: session_start handlers run serially before the
			// prompt opens, so this must never be awaited.
			void (async () => {
				try {
					// Stamp before the fetch: a hung registry must not re-fire on
					// every /clear (session_start) within the day.
					if (stampPath) {
						try {
							writeFileSync(stampPath, String(Date.now()));
						} catch {
							// Unwritable agent dir: check every start, as before.
						}
					}
					const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
					if (!response.ok) return;
					const latest = pickAvailableVersion(await response.json(), { minReleaseAgeMs });
					if (typeof latest === "string" && isNewerVersion(latest, currentVersion)) {
						ctx.ui.notify(
							`One Code ${latest} is available (you have ${currentVersion}). Upgrade: ${upgradeHint}`,
							"info",
						);
					}
				} catch {
					// Offline, slow registry, unexpected payload: stay silent.
				}
			})();
		});
	};
}
