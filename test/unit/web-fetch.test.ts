import { describe, expect, it } from "vitest";
import { htmlToMarkdown, isSameHost, normalizeUrl, paginate } from "../../extensions/tools/web-fetch/extract.ts";

describe("normalizeUrl", () => {
	it("upgrades http to https and says so", () => {
		expect(normalizeUrl("http://example.com/a")).toEqual({ url: "https://example.com/a", upgraded: true });
	});

	it("leaves https alone", () => {
		expect(normalizeUrl("https://example.com/")).toEqual({ url: "https://example.com/" });
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeUrl("  https://example.com/  ")).toEqual({ url: "https://example.com/" });
	});

	it("rejects non-web schemes and malformed input", () => {
		expect(normalizeUrl("file:///etc/passwd")).toEqual({ problem: { kind: "scheme", protocol: "file:" } });
		expect(normalizeUrl("ftp://example.com")).toEqual({ problem: { kind: "scheme", protocol: "ftp:" } });
		expect(normalizeUrl("not a url")).toEqual({ problem: { kind: "invalid", input: "not a url" } });
		expect(normalizeUrl("data:text/plain,hello")).toEqual({ problem: { kind: "scheme", protocol: "data:" } });
	});

	it.each(["https://localhost/", "https://intranet/", "http://localhost:8080/"])("rejects dotless local hosts: %s", (url) => {
		expect(normalizeUrl(url)).toEqual({ problem: { kind: "noDot" } });
	});

	it.each(["https://user:password@example.com/", "https://user@example.com/"])("rejects embedded credentials: %s", (url) => {
		expect(normalizeUrl(url)).toEqual({ problem: { kind: "credentials" } });
	});
});

describe("isSameHost", () => {
	it("compares hosts, ignoring paths", () => {
		expect(isSameHost("https://a.com/x", "https://a.com/y")).toBe(true);
		expect(isSameHost("https://a.com", "https://b.com")).toBe(false);
		expect(isSameHost("https://a.com", "https://sub.a.com")).toBe(false);
	});

	it("does not silently follow a scheme change or embedded credentials", () => {
		expect(isSameHost("https://a.com", "http://a.com")).toBe(false);
		expect(isSameHost("https://a.com:444", "http://a.com:444")).toBe(false);
		expect(isSameHost("https://user:password@a.com", "https://a.com")).toBe(false);
	});

	it("returns false for unparseable input", () => {
		expect(isSameHost("nonsense", "https://a.com")).toBe(false);
	});
});

describe("htmlToMarkdown", () => {
	const article = `<!doctype html><html><head><title>Guide</title></head><body>
		<nav><a href="/skip">Navigation</a></nav>
		<article>
			<h1>Install</h1>
			<p>Run the <code>setup</code> command first.</p>
			<ul><li>step one</li><li>step two</li></ul>
		</article>
	</body></html>`;

	it("extracts readable content as markdown", async () => {
		const result = await htmlToMarkdown(article, "https://example.com/guide");
		expect(result.markdown).toContain("Install");
		expect(result.markdown).toContain("`setup`");
		// turndown indents list items as "-   item"
		expect(result.markdown).toMatch(/-\s+step one/);
		expect(result.markdown).toMatch(/-\s+step two/);
		expect(result.fallback).toBe(false);
	});

	it("resolves relative links against the fetched page URL", async () => {
		const result = await htmlToMarkdown('<html><body><article><h1>Guide</h1><p>Read the <a href="../install">install guide</a> and <a href="/api">API reference</a>.</p></article></body></html>', "https://example.com/docs/start");
		expect(result.markdown).toContain("[install guide](https://example.com/install)");
		expect(result.markdown).toContain("[API reference](https://example.com/api)");
	});

	it("keeps readable content when a server returns an HTML fragment without body tags", async () => {
		const result = await htmlToMarkdown('<h1>Release notes</h1><p>The current release is version 3.2.</p>', "https://example.com/release");
		expect(result.markdown).toContain("The current release is version 3.2.");
	});

	it("keeps the document title", async () => {
		expect((await htmlToMarkdown(article, "https://example.com/guide")).title).toBe("Guide");
	});

	it("strips navigation chrome from an article", async () => {
		expect((await htmlToMarkdown(article, "https://example.com/guide")).markdown).not.toContain("Navigation");
	});

	it("flags the fallback path when there is no extractable article", async () => {
		const result = await htmlToMarkdown("<html><head><title>E</title></head><body></body></html>", "https://example.com/");
		expect(result.fallback).toBe(true);
		expect(result.title).toBe("E");
	});

	it("drops script and style content", async () => {
		const withScript =
			"<html><body><script>alert('x')</script><style>.a{color:red}</style><p>visible text here</p></body></html>";
		const markdown = (await htmlToMarkdown(withScript, "https://example.com/")).markdown;
		expect(markdown).toContain("visible text here");
		expect(markdown).not.toContain("alert");
		expect(markdown).not.toContain("color:red");
	});
});

describe("paginate", () => {
	const text = "abcdefghij";

	it("returns the whole text when it fits", () => {
		expect(paginate(text, 0, 20)).toEqual({ text, truncated: false, nextOffset: undefined, totalChars: 10 });
	});

	it("windows long text and reports where to continue", () => {
		const page = paginate(text, 0, 4);
		expect(page.text).toBe("abcd");
		expect(page.truncated).toBe(true);
		expect(page.nextOffset).toBe(4);
	});

	it("resumes from an offset and ends cleanly", () => {
		const page = paginate(text, 4, 4);
		expect(page.text).toBe("efgh");
		expect(page.nextOffset).toBe(8);
		const last = paginate(text, 8, 4);
		expect(last.text).toBe("ij");
		expect(last.truncated).toBe(false);
	});

	it("clamps an out-of-range offset instead of throwing", () => {
		expect(paginate(text, 999, 10).text).toBe("");
		expect(paginate(text, -5, 3).text).toBe("abc");
	});
});
