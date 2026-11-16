import { afterEach, describe, expect, it, vi } from "vitest";
import { completeThreadless } from "../../extensions/lib/request/anthropic-stream.ts";
import { CREDENTIAL_LOOKUP_TIMEOUT_MS, credentialCause, isCredentialRefusal } from "../../extensions/lib/request/credential-refusal.ts";
import { registryStream } from "./helpers/side-call-registry.ts";

const model = { provider: "openai", id: "gpt-test", api: "openai-responses" } as never;
const context = { systemPrompt: "", messages: [] };
const errorReply = (errorMessage: string) => ({ role: "assistant", content: [], stopReason: "error", errorMessage, usage: {} });

afterEach(() => vi.useRealTimers());

// pi 1.5.2's credential refusals (model-runtime.js prepareRequest, pi-ai auth/resolve.js).
describe("isCredentialRefusal", () => {
	it("knows pi's bare refusal and pi-ai's credential errors, with or without a cause", () => {
		for (const message of [
			"Provider is not configured: openai",
			"OAuth refresh failed for anthropic",
			"OAuth refresh failed for anthropic: invalid_grant",
			"OAuth refresh returned a token that expires too soon for anthropic",
			"OAuth auth derivation failed for openai-codex: bad token",
			"API key auth failed for provider amazon-bedrock: no profile",
			"Credential store read failed for openai: EACCES",
			"Credential store modify failed for openai",
		])
			expect(isCredentialRefusal(message), message).toBe(true);
	});

	it("leaves every other failure alone", () => {
		for (const message of [undefined, "", "529 Overloaded", "Request timed out", "Unknown provider: x", "fetch failed", "401 invalid x-api-key"])
			expect(isCredentialRefusal(message), String(message)).toBe(false);
	});
});

describe("credentialCause", () => {
	it("asks the registry only for pi's bare refusal", async () => {
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: false as const, error: 'No API key found for "openai"' }));
		expect(await credentialCause({ getApiKeyAndHeaders }, model, "Provider is not configured: openai")).toBe('No API key found for "openai"');
		expect(await credentialCause({ getApiKeyAndHeaders }, model, "OAuth refresh failed for openai: invalid_grant")).toBe("OAuth refresh failed for openai: invalid_grant");
		expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
	});

	it("keeps pi's message when the lookup resolves, throws, is cancelled or runs out of time", async () => {
		const bare = "Provider is not configured: openai";
		expect(await credentialCause({ getApiKeyAndHeaders: async () => ({ ok: true }) }, model, bare)).toBe(bare);
		expect(await credentialCause({ getApiKeyAndHeaders: async () => Promise.reject(new Error("boom")) }, model, bare)).toBe(bare);
		const hanging = { getApiKeyAndHeaders: () => new Promise<never>(() => {}) };
		const cancel = new AbortController();
		const cancelled = credentialCause(hanging, model, bare, cancel.signal);
		cancel.abort();
		expect(await cancelled).toBe(bare);
		vi.useFakeTimers();
		const timedOut = credentialCause(hanging, model, bare);
		await vi.advanceTimersByTimeAsync(CREDENTIAL_LOOKUP_TIMEOUT_MS);
		expect(await timedOut).toBe(bare);
	});
});

describe("completeThreadless on a credential refusal", () => {
	it("returns the cause in credentialError and an errorMessage naming the model and the fix", async () => {
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: false as const, error: "OAuth refresh failed for openai" }));
		const registry = { getApiKeyAndHeaders, streamSimple: registryStream(async () => errorReply("Provider is not configured: openai")) } as never;
		const reply = await completeThreadless(registry, model, context, {});
		expect(reply.credentialError).toBe("OAuth refresh failed for openai");
		expect(reply.errorMessage).toBe("No usable credentials for openai/gpt-test: OAuth refresh failed for openai. Log in with /login or set the provider's API key.");
		expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
	});

	it("returns any other reply untouched, with no lookup", async () => {
		const getApiKeyAndHeaders = vi.fn();
		for (const sent of [errorReply("529 Overloaded"), { ...errorReply("Request timed out"), stopReason: "aborted" }, { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: {} }]) {
			const registry = { getApiKeyAndHeaders, streamSimple: registryStream(async () => sent) } as never;
			expect(await completeThreadless(registry, model, context, {})).toEqual(sent);
		}
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
	});
});
