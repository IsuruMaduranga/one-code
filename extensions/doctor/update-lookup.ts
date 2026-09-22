/**
 * Newest-release lookup for the doctor's Installation section (pure given a
 * fetch). Shares the app's daily update notice's mechanism
 * (lib/update-check.mjs): the same packument, the same "newest installable
 * version" rule — a day's release age under Homebrew, `dist-tags.latest`
 * otherwise — a short timeout, silent on failure, and skipped under pi's
 * offline switch or ONECODE_NO_UPDATE_CHECK — a diagnostic must never hang on
 * the network or restore egress the user turned off.
 */

import { compareVersions } from "../lib/pi-version.ts";
import { APP_PACKAGE, EXTENSION_PACKAGE, minReleaseAgeFor, pickAvailableVersion, registryPackumentUrl } from "../lib/update-check.mjs";
import type { DoctorEnvironment } from "./report.ts";

export const APP_REGISTRY_URL = registryPackumentUrl(APP_PACKAGE);
export const PACKAGE_REGISTRY_URL = registryPackumentUrl(EXTENSION_PACKAGE);
export const LOOKUP_TIMEOUT_MS = 3000;

export type LatestLookup = NonNullable<DoctorEnvironment["latest"]>;

/** pi's truthy-flag reading for PI_OFFLINE (1/true/yes). */
export function isOffline(env: NodeJS.ProcessEnv): boolean {
	return /^(1|true|yes)$/i.test(String(env.PI_OFFLINE ?? "").trim());
}

export async function lookupLatestVersion(input: {
	install: "app" | "pi-package";
	current: string;
	env: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<LatestLookup> {
	if (isOffline(input.env)) return { status: "skipped", reason: "offline" };
	if (input.env.ONECODE_NO_UPDATE_CHECK === "1") return { status: "skipped", reason: "ONECODE_NO_UPDATE_CHECK=1" };
	const url = input.install === "app" ? APP_REGISTRY_URL : PACKAGE_REGISTRY_URL;
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	try {
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(input.timeoutMs ?? LOOKUP_TIMEOUT_MS) });
		if (!response.ok) return { status: "unknown", reason: `registry answered ${response.status}` };
		const minReleaseAgeMs = minReleaseAgeFor(input.env);
		const latest = pickAvailableVersion(await response.json(), { minReleaseAgeMs });
		if (typeof latest !== "string") {
			// A well-formed packument with nothing old enough is a Homebrew
			// outcome, not a broken registry.
			return { status: "unknown", reason: minReleaseAgeMs > 0 ? "no release is a day old yet (Homebrew installs wait that long)" : "unexpected registry payload" };
		}
		const cmp = compareVersions(latest, input.current);
		if (cmp === undefined) return { status: "unknown", version: latest, reason: "unparseable version" };
		return { status: cmp > 0 ? "behind" : "current", version: latest };
	} catch (error) {
		const message = error instanceof Error ? (error.name === "TimeoutError" ? "timed out" : error.message) : String(error);
		return { status: "unknown", reason: message };
	}
}
