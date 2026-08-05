import { describe, expect, it } from "vitest";
import { htmlToMarkdown, isSameHost, normalizeUrl, paginate } from "../../extensions/web-fetch/extract.ts";

describe("normalizeUrl", () => {
	it("upgrades http to https and says so", () => {
		const result = normalizeUrl("http://example.com/a");
		expect(result.url).toBe("https://example.com/a");
		expect(result.note).toMatch(/Upgraded/);
	});

	it("leaves https alone without a note", () => {
		expect(normalizeUrl("https://example.com/")).toEqual({ url: "https://example.com/" });
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeUrl("  https://example.com/  ").url).toBe("https://example.com/");
	});

	it("rejects non-web schemes and malformed input", () => {
		expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/Unsupported URL scheme/);
		expect(() => normalizeUrl("ftp://example.com")).toThrow(/Unsupported URL scheme/);
		expect(() => normalizeUrl("not a url")).toThrow(/Not a valid URL/);
	});
});

describe("isSameHost", () => {
	it("compares hosts, ignoring path and scheme", () => {
		expect(isSameHost("https://a.com/x", "https://a.com/y")).toBe(true);
		expect(isSameHost("https://a.com", "https://b.com")).toBe(false);
		expect(isSameHost("https://a.com", "https://sub.a.com")).toBe(false);
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

	it("extracts readable content as markdown", () => {
		const result = htmlToMarkdown(article, "https://example.com/guide");
		expect(result.markdown).toContain("Install");
		expect(result.markdown).toContain("`setup`");
		// turndown indents list items as "-   item"
		expect(result.markdown).toMatch(/-\s+step one/);
		expect(result.markdown).toMatch(/-\s+step two/);
		expect(result.fallback).toBe(false);
	});

	it("keeps the document title", () => {
		expect(htmlToMarkdown(article, "https://example.com/guide").title).toBe("Guide");
	});

	it("strips navigation chrome from an article", () => {
		expect(htmlToMarkdown(article, "https://example.com/guide").markdown).not.toContain("Navigation");
	});

	it("flags the fallback path when there is no extractable article", () => {
		const result = htmlToMarkdown("<html><head><title>E</title></head><body></body></html>", "https://example.com/");
		expect(result.fallback).toBe(true);
		expect(result.title).toBe("E");
	});

	it("drops script and style content", () => {
		const withScript =
			"<html><body><script>alert('x')</script><style>.a{color:red}</style><p>visible text here</p></body></html>";
		const markdown = htmlToMarkdown(withScript, "https://example.com/").markdown;
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
