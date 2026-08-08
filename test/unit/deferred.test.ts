import { describe, expect, it } from "vitest";
import {
	DeferredRegistry,
	deferredReminderText,
	searchTools,
	type SearchableTool,
	selectedNames,
} from "../../extensions/lib/deferred.ts";

const tools: SearchableTool[] = [
	{ name: "notebook_edit", description: "Edit a Jupyter notebook cell", keywords: ["ipynb", "jupyter"] },
	{ name: "web_search", description: "Search the web for information", keywords: ["google", "internet"] },
	{ name: "slack_post", description: "Post a message to a channel", keywords: [] },
	{ name: "slack_search", description: "Search past messages", keywords: [] },
];

describe("DeferredRegistry", () => {
	it("records names and merges keywords", () => {
		const r = new DeferredRegistry();
		r.add({ name: "a", keywords: ["x"] });
		r.add({ name: "a", keywords: ["y", "x"] });
		r.add({ name: "b" });
		expect(r.names).toEqual(["a", "b"]);
		expect(r.keywordsFor("a")).toEqual(["x", "y"]);
		expect(r.has("b")).toBe(true);
		expect(r.has("c")).toBe(false);
	});

	it("ignores malformed requests", () => {
		const r = new DeferredRegistry();
		r.add({ name: "" });
		expect(r.names).toEqual([]);
	});
});

describe("searchTools", () => {
	it("select: loads exact names regardless of description", () => {
		const matches = searchTools("select:notebook_edit,web_search", tools);
		expect(matches.map((m) => m.name)).toEqual(["notebook_edit", "web_search"]);
	});

	it("select: is case-insensitive and ignores unknown names", () => {
		const matches = searchTools("select:NoteBook_Edit,does_not_exist", tools);
		expect(matches.map((m) => m.name)).toEqual(["notebook_edit"]);
	});

	it("keyword search matches name, description, and keywords", () => {
		expect(searchTools("jupyter", tools).map((m) => m.name)).toEqual(["notebook_edit"]);
		expect(searchTools("internet", tools).map((m) => m.name)).toEqual(["web_search"]);
	});

	it("ranks name matches above description matches", () => {
		const matches = searchTools("search", tools);
		expect(matches[0].name).toMatch(/^(web_search|slack_search)$/);
		// slack_post only matches via description ("message to a channel"), so it ranks lower or is absent
		expect(matches.findIndex((m) => m.name === "slack_post")).toBe(-1);
	});

	it("+term requires the term in the tool name", () => {
		const matches = searchTools("+slack search", tools);
		expect(matches.map((m) => m.name).sort()).toEqual(["slack_post", "slack_search"]);
		expect(matches[0].name).toBe("slack_search");
	});

	it("returns nothing when no tool matches", () => {
		expect(searchTools("kubernetes", tools)).toEqual([]);
	});

	it("respects max_results", () => {
		expect(searchTools("search message web notebook", tools, 2)).toHaveLength(2);
	});
});

describe("selectedNames", () => {
	it("returns lowercased requested names for a select: query", () => {
		expect(selectedNames("select:NoteBook_Edit, web_search")).toEqual(["notebook_edit", "web_search"]);
	});

	it("returns undefined for a non-select query", () => {
		expect(selectedNames("jupyter notebook")).toBeUndefined();
		expect(selectedNames("+slack search")).toBeUndefined();
	});

	it("drops empty entries so the caller can flag unmatched names", () => {
		expect(selectedNames("select:web_search,,")).toEqual(["web_search"]);
		// A typo'd name is present in the request but absent from searchTools results,
		// which is exactly what lets tool_search report it as not-found.
		const requested = selectedNames("select:web_search,does_not_exist") ?? [];
		const found = searchTools("select:web_search,does_not_exist", tools).map((m) => m.name.toLowerCase());
		expect(requested.filter((n) => !found.includes(n))).toEqual(["does_not_exist"]);
	});
});

describe("deferredReminderText", () => {
	it("lists each tool with only the first line of its description", () => {
		const text = deferredReminderText([
			{ name: "web_fetch", description: "Fetch a URL.\nSecond line detail." },
			{ name: "monitor", description: "Watch a command." },
		]);
		expect(text).toContain("- web_fetch: Fetch a URL.");
		expect(text).not.toContain("Second line");
		expect(text).toContain("- monitor: Watch a command.");
		expect(text).toContain("tool_search");
	});
});
