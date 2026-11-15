import { describe, expect, it } from "vitest";
import {
	deferredMissReminderText,
	DeferredRegistry,
	deferredAddendumText,
	deferredReminderText,
	resultText,
	searchTools,
	type SearchableTool,
	selectedNames,
	selectedRequests,
	toolNotFoundName,
} from "../../extensions/lib/request/deferred.ts";
import { toolSearchResultText } from "../../extensions/lib/request/tool-search-text.ts";

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

	it("keeps the owner's listing hint: a later one replaces it, a request without one keeps it, removal drops it", () => {
		const r = new DeferredRegistry();
		r.add({ name: "a", hint: "first" });
		r.add({ name: "a", hint: "second" });
		r.add({ name: "a", keywords: ["x"] });
		expect(r.hintFor("a")).toBe("second");
		r.add({ name: "b" });
		expect(r.hintFor("b")).toBeUndefined();
		r.remove("a");
		r.add({ name: "a" });
		expect(r.hintFor("a")).toBeUndefined();
	});

	it("keeps an owner's hint on one line: whitespace runs and line breaks become one space, and a blank one is no hint", () => {
		const r = new DeferredRegistry();
		r.add({ name: "a", hint: "  When you echo,\n\n  use it.\r\n\tnot_a_tool: no " });
		expect(r.hintFor("a")).toBe("When you echo, use it. not_a_tool: no");
		r.add({ name: "a", hint: " \n\t " });
		expect(r.hintFor("a")).toBe("When you echo, use it. not_a_tool: no");
		r.add({ name: "b", hint: "\n \n" });
		expect(r.hintFor("b")).toBeUndefined();
		expect(r.requests()[1]).not.toHaveProperty("hint");
	});

	it("lists its tools as deferral requests, in order, with a hint only where one was given", () => {
		const r = new DeferredRegistry();
		r.add({ name: "a", keywords: ["x"], hint: "first" });
		r.add({ name: "b" });
		r.add({ name: "a", keywords: ["y"] });
		expect(r.requests()).toEqual([
			{ name: "a", keywords: ["x", "y"], hint: "first" },
			{ name: "b", keywords: [] },
		]);
		expect(r.requests()[1]).not.toHaveProperty("hint");
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

describe("selectedRequests", () => {
	it("keeps the model's spelling beside the mapped name, so a miss quotes what was asked", () => {
		expect(selectedRequests("select:find,grep,Glob")).toEqual([
			{ name: "find", asWritten: "find" },
			{ name: "grep", asWritten: "grep" },
			{ name: "find", asWritten: "Glob" },
		]);
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

	it("resolves Claude Code tool spellings through the alias table (M1)", () => {
		// A CC-trained model writes PascalCase names; these must load our tools.
		expect(selectedNames("select:WebFetch,NotebookEdit,WebSearch")).toEqual([
			"web_fetch",
			"notebook_edit",
			"web_search",
		]);
	});

	it("loads a CC-named deferred tool via select: (M1)", () => {
		const deferrable: SearchableTool[] = [
			{ name: "web_fetch", description: "Fetch a URL", keywords: [] },
			{ name: "notebook_edit", description: "Edit a notebook", keywords: [] },
		];
		expect(searchTools("select:WebFetch,NotebookEdit", deferrable).map((m) => m.name)).toEqual([
			"web_fetch",
			"notebook_edit",
		]);
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

describe("toolNotFoundName", () => {
	it("recovers the tool name from pi's bare not-found error", () => {
		expect(toolNotFoundName("Tool web_fetch not found")).toBe("web_fetch");
		expect(toolNotFoundName("  Tool monitor not found  ")).toBe("monitor");
	});

	it("returns undefined for any other error text", () => {
		expect(toolNotFoundName("Operation aborted")).toBeUndefined();
		expect(toolNotFoundName("Tool web_fetch failed to run")).toBeUndefined();
		expect(toolNotFoundName("")).toBeUndefined();
	});
});

describe("resultText", () => {
	it("flattens content blocks, matching pi's createErrorToolResult shape", () => {
		expect(resultText({ content: [{ type: "text", text: "Tool web_fetch not found" }] })).toBe(
			"Tool web_fetch not found",
		);
		expect(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab");
	});

	it("handles string content and missing/odd shapes without throwing", () => {
		expect(resultText({ content: "plain" })).toBe("plain");
		expect(resultText({})).toBe("");
		expect(resultText(undefined)).toBe("");
		expect(resultText({ content: [null, { type: "image" }] })).toBe("");
	});

	it("round-trips a real not-found result to the recovered name", () => {
		const result = { content: [{ type: "text", text: "Tool web_fetch not found" }] };
		expect(toolNotFoundName(resultText(result))).toBe("web_fetch");
	});
});

describe("deferredMissReminderText", () => {
	it("passes the missed tool's name to the profile's reminder", () => {
		expect(deferredMissReminderText("web_fetch")).toBe(toolSearchResultText.missReminder({ name: "web_fetch" }));
	});
});

describe("deferredReminderText", () => {
	it("lists bare names one per line under the profile's fixed heading (no descriptions)", () => {
		const text = deferredReminderText([
			{ name: "web_fetch", description: "Fetch a URL.\nSecond line detail." },
			{ name: "monitor", description: "Watch a command." },
		]);
		const lines = text.split("\n");
		expect(text).toBe([toolSearchResultText.listingHead, "web_fetch", "monitor"].join("\n"));
		expect(lines.slice(-2)).toEqual(["web_fetch", "monitor"]);
		expect(text).not.toContain("Fetch a URL");
	});

	it("is byte-identical regardless of what has been loaded (cache-stable, like CC)", () => {
		const tools = [{ name: "a", description: "x" }, { name: "b", description: "y" }];
		expect(deferredReminderText(tools)).toBe(deferredReminderText(tools));
		expect(deferredReminderText(tools)).not.toMatch(/cannot be called yet/);
	});

	it("puts the profile's hint after a tool's name and its closing paragraph after the names", () => {
		const words = { listingHints: { monitor: "When you watch, use it." }, listingClose: "Load what the next step needs." };
		const text = deferredReminderText([{ name: "web_fetch" }, { name: "monitor" }, { name: "mcp__s__t" }], words);
		expect(text).toBe([toolSearchResultText.listingHead, "web_fetch", "monitor: When you watch, use it.", "mcp__s__t", "", "Load what the next step needs."].join("\n"));
		expect(deferredAddendumText(["monitor", "x"], words)).toBe([toolSearchResultText.addendumHead, "monitor: When you watch, use it.", "x"].join("\n"));
	});

	describe("a hint from the tool's owner", () => {
		const words = { listingHints: { monitor: "When you watch, use it." } };
		const owner = (hints: Record<string, string>) => (name: string) => hints[name];

		it("is used for a tool the profile has no hint for", () => {
			expect(deferredReminderText([{ name: "late" }], words, owner({ late: "When you echo, use it." }))).toBe(
				[toolSearchResultText.listingHead, "late: When you echo, use it."].join("\n"),
			);
			expect(deferredAddendumText(["late"], words, owner({ late: "When you echo, use it." }))).toBe(
				[toolSearchResultText.addendumHead, "late: When you echo, use it."].join("\n"),
			);
		});

		it("never replaces the profile's hint", () => {
			const hints = owner({ monitor: "Owner's words." });
			expect(deferredReminderText([{ name: "monitor" }], words, hints)).toBe([toolSearchResultText.listingHead, "monitor: When you watch, use it."].join("\n"));
			expect(deferredAddendumText(["monitor"], words, hints)).toBe([toolSearchResultText.addendumHead, "monitor: When you watch, use it."].join("\n"));
		});

		it("gives way to an empty profile entry, which lists the bare name", () => {
			const hints = owner({ late: "When you echo, use it." });
			expect(deferredReminderText([{ name: "late" }], { listingHints: { late: "" } }, hints)).toBe([toolSearchResultText.listingHead, "late"].join("\n"));
			expect(deferredAddendumText(["late"], { listingHints: { late: "" } }, hints)).toBe([toolSearchResultText.addendumHead, "late"].join("\n"));
		});

		it("is used for a tool whose name the profile's object only inherits", () => {
			const hints = (name: string) => (name === "constructor" ? "When you build, use it." : undefined);
			expect(deferredAddendumText(["constructor", "toString"], words, hints)).toBe([toolSearchResultText.addendumHead, "constructor: When you build, use it.", "toString"].join("\n"));
		});

		it("leaves the bare name when neither has one, byte for byte as without owner hints", () => {
			const tools = [{ name: "web_fetch" }, { name: "monitor" }, { name: "mcp__s__t" }];
			const hints = owner({ late: "When you echo, use it." });
			expect(deferredReminderText(tools, words, hints)).toBe(deferredReminderText(tools, words));
			expect(deferredReminderText(tools, words, hints)).toBe([toolSearchResultText.listingHead, "web_fetch", "monitor: When you watch, use it.", "mcp__s__t"].join("\n"));
			expect(deferredAddendumText(["x"], words, hints)).toBe(deferredAddendumText(["x"], words));
		});
	});
});
