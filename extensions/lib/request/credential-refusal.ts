/**
 * A side call pi refused because it could not resolve the model's credential.
 *
 * pi resolves the credential inside each call (`ModelRuntime.prepareRequest`)
 * and a failure ends the call as a reply with `stopReason: "error"` whose
 * `errorMessage` is the thrown error's message (pi-ai `lazyStream`); the
 * `ModelsError` code does not survive, so the refusal is told by its text
 * (pi 1.5.2):
 *
 * - "Provider is not configured: <provider>": nothing resolved and pi names no
 *   cause, so the registry is asked once why (`getApiKeyAndHeaders`), bounded
 *   by the call's signal and a short timeout.
 * - A `ModelsError` from pi-ai's `auth/resolve.js` ("OAuth refresh failed for
 *   <provider>: <cause>", "API key auth failed for provider <provider>: …",
 *   …): the message already carries the cause, so nothing is resolved again
 *   (a second lookup could start a second OAuth refresh).
 *
 * Any other error (a 529, a timeout, a network failure) is not a refusal and
 * costs no lookup.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/** pi's refusal when no credential resolved; it names no cause. */
const UNRESOLVED = /^Provider is not configured: /;
/** pi-ai's credential errors, each carrying its cause after the provider id. */
const CAUSED = /^(?:OAuth refresh failed for |OAuth refresh returned a token that expires too soon for |OAuth auth derivation failed for |API key auth failed for provider |Credential store (?:read|modify) failed for )/;

/** How long the cause lookup after a bare refusal may take before pi's own message stands. */
export const CREDENTIAL_LOOKUP_TIMEOUT_MS = 5_000;

/** The registry slice the cause lookup reads. */
export interface CredentialLookup {
	getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Whether `errorMessage` is pi's refusal of a credential it could not resolve. */
export function isCredentialRefusal(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && (UNRESOLVED.test(errorMessage) || CAUSED.test(errorMessage));
}

/**
 * The cause of a credential refusal: pi's own message when it names one, else
 * the registry's answer, else pi's message. Never throws and never outlives
 * `signal` or the lookup timeout.
 */
export async function credentialCause(registry: CredentialLookup, model: Model<Api>, errorMessage: string, signal?: AbortSignal): Promise<string> {
	if (!UNRESOLVED.test(errorMessage) || signal?.aborted) return errorMessage;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const gaveUp = new Promise<undefined>((resolve) => {
		onAbort = () => resolve(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(onAbort, CREDENTIAL_LOOKUP_TIMEOUT_MS);
		timer.unref?.(); // a lookup never holds a one-shot run open
	});
	try {
		const auth = await Promise.race([registry.getApiKeyAndHeaders(model), gaveUp]);
		return auth && !auth.ok ? auth.error : errorMessage;
	} catch {
		return errorMessage;
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/** The reply text for a credential refusal: the model, the cause and the fix. */
export function credentialRefusalMessage(model: Pick<Model<Api>, "provider" | "id">, cause: string): string {
	return `No usable credentials for ${model.provider}/${model.id}: ${cause}. Log in with /login or set the provider's API key.`;
}
