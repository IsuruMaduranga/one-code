/**
 * One Code's own update notice and the release facts behind it — shared by
 * the bundled app (app/bin.mjs registers createUpdateCheck as an inline
 * extension) and the doctor (doctor/update-lookup.ts reports the same
 * "newest installable version"). Plain JS with no pi imports: the app loads
 * it from the extension package it depends on, so it must run on bare Node.
 *
 * The notice replaces pi's (suppressed via PI_SKIP_VERSION_CHECK — its
 * endpoint is hardcoded to pi's registry and cannot be pointed at one-code).
 * It mirrors pi's behaviour: entirely non-blocking, and silent on any failure —
 * an update hint must never cost startup time or surface a network error.
 * Honours pi's offline switch (`--offline` sets PI_OFFLINE=1 before extensions
 * load) and runs at most once a day per agent dir, stamped in
 * `<agentDir>/last-update-check` (pi's own check is per session start; a
 * daily cadence spares the registry on every TUI launch). pi's semver helpers
 * are not exported from the package root, so the dotted-numeric compare lives
 * here.
 */

import { readFileSync, writeFileSync } from "node:fs";

export const APP_PACKAGE = "@one-ai/one-code";
export const EXTENSION_PACKAGE = "one-code-extension";
/** The Homebrew formula (IsuruMaduranga/homebrew-one-ai), renamed from one-code at 0.3.0. */
export const HOMEBREW_FORMULA = "onecode";
/** How each install method upgrades the app; the doctor and the update notice quote these. */
export const UPGRADE_COMMANDS = {
	npm: `npm install -g ${APP_PACKAGE}`,
	brew: `brew upgrade ${HOMEBREW_FORMULA}`,
	"pi-package": "pi update",
};

/**
 * The registry packument for a package (scoped slash percent-encoded). The
 * full document, not `/latest`: its `time` map dates every version, which
 * the Homebrew rule needs (pickAvailableVersion). ~14 KB for this package.
 */
export function registryPackumentUrl(name) {
	return `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
}

const TIMEOUT_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const CHECK_INTERVAL_MS = DAY_MS;
/**
 * Homebrew's `std_npm_args` passes npm `--min-release-age=1`, so a version
 * becomes brew-installable only a day after its npm publish. A Homebrew user
 * told about a fresher version would run `brew upgrade onecode` and get
 * nothing, so every hint for that install method waits the same day.
 */
export const HOMEBREW_MIN_RELEASE_AGE_MS = DAY_MS;

/**
 * The minimum release age for an install method: a day for Homebrew, none
 * otherwise. `ONECODE_INSTALL_METHOD` is set by the app launcher (app/bin.mjs)
 * from where the binary lives; a plain pi package never sets it.
 */
export function minReleaseAgeFor(env = process.env) {
	return env.ONECODE_INSTALL_METHOD === "brew" ? HOMEBREW_MIN_RELEASE_AGE_MS : 0;
}

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
 * fetches). With one, it is the newest plain x.y.z version whose `time` entry
 * is at least that old — the newest one a `--min-release-age` install can see.
 * Prerelease tags never qualify.
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
					const response = await fetch(registryPackumentUrl(APP_PACKAGE), { signal: AbortSignal.timeout(TIMEOUT_MS) });
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
