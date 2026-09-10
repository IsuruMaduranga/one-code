/**
 * Newest-release lookup for the doctor's Installation section (pure given a
 * fetch). Mirrors the app's daily update check (app/update-check.mjs): the same
 * registry endpoints, a short timeout, silent on failure, and skipped under
 * pi's offline switch or ONECODE_NO_UPDATE_CHECK — a diagnostic must never hang
 * on the network or restore egress the user turned off.
 */

import { compareVersions } from "../lib/pi-version.ts";
import type { DoctorEnvironment } from "./report.ts";

export const APP_REGISTRY_URL = "https://registry.npmjs.org/@one-ai%2Fone-code/latest";
export const PACKAGE_REGISTRY_URL = "https://registry.npmjs.org/one-code-extension/latest";
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
		const body = (await response.json()) as { version?: unknown };
		if (typeof body.version !== "string") return { status: "unknown", reason: "unexpected registry payload" };
		const cmp = compareVersions(body.version, input.current);
		if (cmp === undefined) return { status: "unknown", version: body.version, reason: "unparseable version" };
		return { status: cmp > 0 ? "behind" : "current", version: body.version };
	} catch (error) {
		const message = error instanceof Error ? (error.name === "TimeoutError" ? "timed out" : error.message) : String(error);
		return { status: "unknown", reason: message };
	}
}
