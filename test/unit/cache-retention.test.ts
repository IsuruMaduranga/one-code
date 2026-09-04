import { describe, expect, it } from "vitest";
import { CACHE_RETENTION_ENV, mainSessionCacheRetention, withShortCacheRetention } from "../../extensions/lib/cache-retention.ts";

describe("mainSessionCacheRetention", () => {
	it("chooses the long TTL for the interactive modes when the user set nothing", () => {
		expect(mainSessionCacheRetention("tui", undefined)).toBe("long");
		expect(mainSessionCacheRetention("rpc", "")).toBe("long");
	});

	it("leaves headless runs on pi's default and never overrides the user's value", () => {
		expect(mainSessionCacheRetention("print", undefined)).toBeUndefined();
		expect(mainSessionCacheRetention("json", undefined)).toBeUndefined();
		expect(mainSessionCacheRetention("tui", "short")).toBeUndefined();
		expect(mainSessionCacheRetention("tui", "long")).toBeUndefined();
	});
});

describe("withShortCacheRetention", () => {
	it("merges PI_CACHE_RETENTION=short into every getAuth result and keeps credential env", async () => {
		const calls: unknown[] = [];
		const runtime = {
			async getAuth(target: unknown, overrides?: unknown) {
				calls.push([target, overrides]);
				return { auth: { apiKey: "k" }, env: { AWS_REGION: "eu-west-1" } };
			},
		};
		const wrapped = withShortCacheRetention(runtime);
		expect(wrapped).toBe(runtime);
		const result = await wrapped.getAuth("anthropic", { signal: undefined });
		expect(result).toEqual({ auth: { apiKey: "k" }, env: { AWS_REGION: "eu-west-1", [CACHE_RETENTION_ENV]: "short" } });
		expect(calls).toEqual([["anthropic", { signal: undefined }]]);
	});

	it("adds an env when the provider had none and passes an unresolved auth through", async () => {
		const runtime = {
			async getAuth(target: unknown): Promise<{ auth: object; env?: Record<string, string> } | undefined> {
				return target === "none" ? undefined : { auth: {} };
			},
		};
		withShortCacheRetention(runtime);
		expect(await runtime.getAuth("anthropic")).toEqual({ auth: {}, env: { [CACHE_RETENTION_ENV]: "short" } });
		expect(await runtime.getAuth("none")).toBeUndefined();
	});
});
