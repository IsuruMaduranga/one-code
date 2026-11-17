/**
 * Which OpenRouter host served the main session's last reply, for /doctor.
 *
 * OpenRouter names the serving host in the `provider` field of every streamed
 * chunk. The `tool-call-corruption` extension already reads it there (pi's
 * `provider_stream_event`, main session only) and publishes it on
 * `OPENROUTER_HOST_CHANNEL` at the end of each assistant message, with the
 * message's generation id for the `/generation` lookup when no chunk named a
 * host. Nothing here changes what a session sends: the host line is part of
 * /doctor's output, which reaches the model only the way any command's output
 * does (appended after the command, and inside a bare /doctor's checkup
 * message).
 *
 * The precision comes from OpenRouter's public endpoints listing for the model
 * (no key is sent): the generation record names the host but not the endpoint's
 * quantization, so the listing's entries for that host are what can be told.
 * A host with endpoints at several precisions lists them all. Pure apart from
 * the one fetch.
 */

import { brandedId } from "../profile/brand.mjs";
import { openRouterApiBase } from "./openrouter-generation.ts";

/** Published by the tool-call-corruption extension when a main-session assistant message on OpenRouter ends. */
export const OPENROUTER_HOST_CHANNEL = brandedId("openrouter-host");

export interface OpenRouterHostEvent {
	/** The model that replied, as `provider/id`. */
	model: string;
	/** The host the stream named, when a chunk named one. */
	host?: string;
	/** The reply's generation id, for the `/generation` lookup. */
	responseId?: string;
}

/** The endpoints listing of `modelId` under a model's base URL, or undefined when that URL is not OpenRouter's own. */
export function endpointsListingUrl(baseUrl: string | undefined, modelId: string): string | undefined {
	const base = openRouterApiBase(baseUrl);
	return base && `${base}/models/${modelId.replace(/^~/, "").split("/").map(encodeURIComponent).join("/")}/endpoints`;
}

/** Each host's quantizations in an endpoints listing body, `"unknown"` for an endpoint that declares none. */
export function quantizationsByHost(body: unknown): Map<string, string[]> {
	const hosts = new Map<string, string[]>();
	const endpoints = (body as { data?: { endpoints?: unknown } } | null)?.data?.endpoints;
	if (!Array.isArray(endpoints)) return hosts;
	for (const endpoint of endpoints as Array<{ provider_name?: unknown; quantization?: unknown }>) {
		if (typeof endpoint?.provider_name !== "string") continue;
		const key = endpoint.provider_name.toLowerCase();
		const quantization = typeof endpoint.quantization === "string" && endpoint.quantization.trim() ? endpoint.quantization.trim() : "unknown";
		const list = hosts.get(key) ?? [];
		if (!list.includes(quantization)) list.push(quantization);
		hosts.set(key, list);
	}
	return hosts;
}

/** The listing's quantizations per host for `modelId`, or undefined when it cannot be read in time. */
export async function fetchEndpointQuantizations(baseUrl: string | undefined, modelId: string, signal: AbortSignal): Promise<Map<string, string[]> | undefined> {
	const url = endpointsListingUrl(baseUrl, modelId);
	if (!url || signal.aborted) return;
	try {
		const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
		if (!response.ok) {
			await response.body?.cancel();
			return;
		}
		return quantizationsByHost(await response.json());
	} catch {
		// The listing is a nicety: a failure leaves the host without its precision.
	}
}

/** What /doctor shows: the host, with the precisions the listing gives it, if any. */
export interface ServedHost {
	model: string;
	host: string;
	quantizations?: readonly string[];
}

/** The host with its precisions, as one phrase: `InferenceNet (fp8)`, `Wafer (fp8 or mxfp4)`. */
export function servedHostLabel(served: ServedHost): string {
	const precisions = (served.quantizations ?? []).map((q) => (q === "unknown" ? "precision not declared" : q));
	return precisions.length > 0 ? `${served.host} (${precisions.join(" or ")})` : served.host;
}
