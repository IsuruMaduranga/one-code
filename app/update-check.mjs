/**
 * One Code's own update notice, replacing pi's (which is suppressed via
 * PI_SKIP_VERSION_CHECK — its endpoint is hardcoded to pi's registry and
 * cannot be pointed at one-code).
 *
 * Mirrors pi's behaviour: checked once per session start, entirely
 * non-blocking, and silent on any failure — an update hint must never cost
 * startup time or surface a network error. pi's semver helpers are not
 * exported from the package root, so the dotted-numeric compare lives here.
 */

// Scoped package: the slash must be percent-encoded in registry GETs.
const REGISTRY_URL = "https://registry.npmjs.org/@one-ai%2Fone-code/latest";
const TIMEOUT_MS = 3000;

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

export function createUpdateCheck({ currentVersion, upgradeHint }) {
	return function updateCheckExtension(pi) {
		pi.on("session_start", (_event, ctx) => {
			if (process.env.ONE_CODE_NO_UPDATE_CHECK === "1") return;
			if (!ctx.hasUI) return; // print/rpc runs stay clean for parsers
			// Fire-and-forget: session_start handlers run serially before the
			// prompt opens, so this must never be awaited.
			void (async () => {
				try {
					const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
					if (!response.ok) return;
					const { version: latest } = await response.json();
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
