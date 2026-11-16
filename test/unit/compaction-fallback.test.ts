import { describe, expect, it } from "vitest";
import { fallbackNotice, fallbackReason, replyFallback, thrownFallback } from "../../extensions/context/compaction/fallback.ts";

describe("replyFallback", () => {
	it("names the provider's error, a timeout and a capped summary", () => {
		expect(replyFallback({ stopReason: "error", errorMessage: "401 invalid x-api-key" }, 120_000)).toEqual({ kind: "provider", detail: "401 invalid x-api-key" });
		expect(replyFallback({ stopReason: "error" }, 120_000)).toEqual({ kind: "provider", detail: "the provider returned an error" });
		expect(replyFallback({ stopReason: "aborted" }, 120_000)).toEqual({ kind: "timeout", seconds: 120 });
		expect(replyFallback({ stopReason: "length" }, 120_000)).toEqual({ kind: "length" });
	});
});

describe("fallbackNotice", () => {
	const model = "openai-codex/gpt-6.1-sol";

	it("tells the user about a credential failure and names the fix", () => {
		const notice = fallbackNotice({ kind: "credentials", detail: "OAuth refresh failed for openai-codex" }, model);
		expect(notice).toContain("openai-codex/gpt-6.1-sol");
		expect(notice).toContain("OAuth refresh failed for openai-codex");
		expect(notice).toContain("/login");
		expect(notice).toContain("once per session");
	});

	it("tells the user about a provider error, a timeout and a fault, with the cause", () => {
		expect(fallbackNotice({ kind: "provider", detail: "Provider is not configured: my-proxy" }, model)).toContain("Provider is not configured: my-proxy");
		expect(fallbackNotice({ kind: "timeout", seconds: 120 }, model)).toContain("120 seconds");
		expect(fallbackNotice(thrownFallback(new Error("boom")), model)).toContain("boom");
	});

	it("stays quiet about the model's own variance", () => {
		expect(fallbackNotice({ kind: "length" }, model)).toBeUndefined();
		expect(fallbackNotice({ kind: "noSummary" }, model)).toBeUndefined();
	});
});

describe("fallbackReason", () => {
	it("gives every kind a log line", () => {
		expect(fallbackReason({ kind: "credentials", detail: "no key" })).toBe("credentials: no key");
		expect(fallbackReason({ kind: "provider", detail: "500" })).toBe("provider error: 500");
		expect(fallbackReason({ kind: "timeout", seconds: 120 })).toBe("no reply within 120 seconds");
		expect(fallbackReason(thrownFallback("odd"))).toBe("error: odd");
		expect(fallbackReason({ kind: "length" })).toBe("the summary ran past its output cap");
		expect(fallbackReason({ kind: "noSummary" })).toBe("the reply held no <summary> block");
	});
});
