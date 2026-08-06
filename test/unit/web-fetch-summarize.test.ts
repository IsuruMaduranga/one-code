import { describe, expect, it } from "vitest";
import { pickReaderModel, READER_MAX_CHARS, readerMessages } from "../../extensions/web-fetch/summarize.ts";

/** Minimal structural stand-in; only provider/id/cost are consulted. */
const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 } }) as any;

describe("pickReaderModel", () => {
	it("prefers a vetted smaller same-provider model", () => {
		const catalog = [
			model("anthropic", "claude-fable-5", 15),
			model("anthropic", "claude-haiku-4-5", 1),
			model("openai", "gpt-5-mini", 0.25),
		];
		const choice = pickReaderModel(catalog, catalog[0]);
		expect(choice).toMatchObject({ via: "profile" });
		// Never crosses providers: the page and the query go to the reader.
		expect(choice?.model.id).toBe("claude-haiku-4-5");
	});

	it("never picks a reader pricier than the session model", () => {
		// A haiku session gets haiku itself (it is in the profile), never sonnet.
		const catalog = [model("anthropic", "claude-haiku-4-5", 1), model("anthropic", "claude-sonnet-5", 3)];
		expect(pickReaderModel(catalog, catalog[0])?.model.id).toBe("claude-haiku-4-5");
	});

	it("falls back to the session model on an unvetted provider", () => {
		const catalog = [model("acme", "big-model", 20), model("acme", "tiny-model", 0.01)];
		const choice = pickReaderModel(catalog, catalog[0]);
		expect(choice).toMatchObject({ via: "session" });
		expect(choice?.model.id).toBe("big-model");
	});

	it("returns nothing without a session model", () => {
		expect(pickReaderModel([model("openai", "gpt-5-mini", 0.25)], undefined)).toBeUndefined();
	});
});

describe("readerMessages", () => {
	it("carries the page as tagged untrusted data with the question after it", () => {
		const messages = readerMessages({
			prompt: "What is the version?",
			markdown: "The version is 3.2.",
			url: "https://example.com/release",
			title: "Release notes",
		});
		expect(messages.system).toContain("untrusted");
		expect(messages.user).toContain("<page>\nThe version is 3.2.\n</page>");
		expect(messages.user).toContain("Title: Release notes");
		expect(messages.user.endsWith("Question: What is the version?")).toBe(true);
		expect(messages.truncated).toBe(false);
	});

	it("cuts oversized pages and says so to the reader", () => {
		const messages = readerMessages({
			prompt: "q",
			markdown: "x".repeat(READER_MAX_CHARS + 10),
			url: "https://example.com",
		});
		expect(messages.truncated).toBe(true);
		expect(messages.user).toContain("cut at");
		expect(messages.user.length).toBeLessThan(READER_MAX_CHARS + 500);
	});
});
