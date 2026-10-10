import { describe, expect, it } from "vitest";
import { decide, parseRules } from "../../extensions/permissions/matcher.ts";

const base = {
	toolName: "web_fetch",
	subject: "https://docs.example.com/reference",
	cwd: process.cwd(),
	mode: "plan" as const,
	deny: [],
	ask: [],
	allow: [],
};

describe("web domain permissions", () => {
	it("honors an explicit domain ask rule before read-only web access", () => {
		const result = decide({ ...base, ask: parseRules(["WebFetch(domain:docs.example.com)"]) });
		expect(result.decision).toBe("ask");
		expect(result.cause).toBe("rule");
	});

	it("still denies a domain when a blanket allow rule is present", () => {
		const result = decide({ ...base, deny: parseRules(["WebFetch(domain:docs.example.com)"]), allow: parseRules(["WebFetch"]) });
		expect(result.decision).toBe("deny");
	});

	it("does not let a trailing DNS dot bypass an exact domain deny", () => {
		const result = decide({ ...base, mode: "default", subject: "https://docs.example.com./reference", deny: parseRules(["WebFetch(domain:docs.example.com)"]), allow: parseRules(["WebFetch"]) });
		expect(result.decision).toBe("deny");
	});

	it("honors wildcard subdomain denies", () => {
		const deny = parseRules(["WebFetch(domain:*.example.com)"]);
		for (const subject of ["https://docs.example.com/", "https://deep.docs.example.com/"]) {
			expect(decide({ ...base, mode: "default", subject, deny, allow: parseRules(["WebFetch"]) }).decision).toBe("deny");
		}
	});

	it("honors the all-domains wildcard deny", () => {
		const result = decide({ ...base, mode: "default", deny: parseRules(["WebFetch(domain:*)"]), allow: parseRules(["WebFetch"]) });
		expect(result.decision).toBe("deny");
	});

	it("normalizes case and trailing dots in domain rules as well as URLs", () => {
		const allow = parseRules(["WebFetch(domain:DOCS.EXAMPLE.COM.)"]);
		expect(decide({ ...base, mode: "default", allow }).decision).toBe("allow");
	});

	it("keeps subdomain wildcards scoped to real subdomains", () => {
		const allow = parseRules(["WebFetch(domain:*.example.com)"]);
		for (const subject of ["https://docs.example.com/", "https://deep.docs.example.com./"]) {
			expect(decide({ ...base, mode: "default", subject, allow }).decision).toBe("allow");
		}
		for (const subject of ["https://example.com/", "https://example.com.evil.test/", "https://notexample.com/", "https://.example.com/", "https://a..example.com/"]) {
			expect(decide({ ...base, mode: "default", subject, allow }).decision).toBe("ask");
		}
	});

	it("does not let an in-label wildcard span dot-separated labels", () => {
		const allow = parseRules(["WebFetch(domain:docs*.example.com)"]);
		expect(decide({ ...base, mode: "default", subject: "https://docs2.example.com/", allow }).decision).toBe("allow");
		expect(decide({ ...base, mode: "default", subject: "https://docs.evil.example.com/", allow }).decision).toBe("ask");
	});

	it.each(["https://bücher.example/", "https://xn--bcher-kva.example/"])("honors a Unicode domain deny for %s", (subject) => {
		const deny = parseRules(["WebFetch(domain:bücher.example)"]);
		expect(decide({ ...base, mode: "default", subject, deny, allow: parseRules(["WebFetch"]) }).decision).toBe("deny");
	});

	it("normalizes Unicode suffixes in wildcard domain denies", () => {
		const deny = parseRules(["WebFetch(domain:*.bücher.example)"]);
		for (const subject of ["https://docs.bücher.example/", "https://deep.docs.xn--bcher-kva.example./"]) {
			expect(decide({ ...base, mode: "default", subject, deny, allow: parseRules(["WebFetch"]) }).decision).toBe("deny");
		}
	});

	it("does not normalize a malformed domain rule into a broader hostname allow", () => {
		for (const domain of ["docs.example.com/path", "docs.example.com?query", "docs.example.com#fragment", "docs.example.com\\\\path", "docs.exam\nple.com", "docs.example.com:443"]) {
			const allow = parseRules([`WebFetch(domain:${domain})`]);
			expect(decide({ ...base, mode: "default", allow }).decision, domain).toBe("ask");
		}
	});

	it("preserves plan-mode mutation denies even with matching ask rules", () => {
		expect(decide({ ...base, toolName: "write", subject: "not-the-plan.md", ask: parseRules(["Write"]) }).decision).toBe("deny");
	});

	it("does not widen domain allows to suffix lookalikes or subdomains", () => {
		const allow = parseRules(["WebFetch(domain:docs.example.com)"]);
		for (const subject of ["https://docs.example.com.evil.test/", "https://sub.docs.example.com/"]) {
			expect(decide({ ...base, mode: "default", subject, allow }).decision).toBe("ask");
		}
	});
});
