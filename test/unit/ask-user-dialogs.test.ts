import { describe, expect, it } from "vitest";
import { askThroughDialogs, CHAT, DONE, type DialogUI, optionRow, TYPE_OWN } from "../../extensions/ask-user/dialogs.ts";
import { formatAnswers, type Question } from "../../extensions/ask-user/questions.ts";

/** A scripted RPC client: answers each select/input in order and records what it was shown. */
function scripted(replies: Array<string | undefined>) {
	const shown: Array<{ kind: "select" | "input"; title: string; options?: string[] }> = [];
	const ui: DialogUI = {
		select: async (title, options) => {
			shown.push({ kind: "select", title, options });
			return replies.shift();
		},
		input: async (title) => {
			shown.push({ kind: "input", title });
			return replies.shift();
		},
	};
	return { ui, shown };
}

const layout: Question = {
	question: "Which layout?",
	header: "Layout",
	options: [
		{ label: "Grid", description: "Cards in rows", preview: "[A][B]" },
		{ label: "List" },
	],
};

const langs: Question = {
	question: "Which languages?",
	header: "Langs",
	multiSelect: true,
	options: [{ label: "TS" }, { label: "Go" }, { label: "Rust" }],
};

describe("askThroughDialogs", () => {
	it("asks a single-select question with the options, a typed answer and chat rows", async () => {
		const { ui, shown } = scripted([optionRow(layout.options[0])]);
		const result = await askThroughDialogs([layout], ui);
		expect(shown).toEqual([{ kind: "select", title: "Layout: Which layout?", options: ["Grid — Cards in rows", "List", TYPE_OWN, CHAT] }]);
		expect(result).toEqual({ kind: "submit", answers: [{ question: "Which layout?", header: "Layout", selected: ["Grid"], freeform: false, preview: "[A][B]" }] });
		if (result.kind === "submit") expect(formatAnswers(result.answers)).toBe('Your questions have been answered: "Which layout?"="Grid" selected preview:\n[A][B]. You can now continue with these answers in mind.');
	});

	it("collects several picks for a multi-select question until Done", async () => {
		const { ui, shown } = scripted(["Go", "TS", DONE]);
		const result = await askThroughDialogs([langs], ui);
		expect(shown[1]).toEqual({ kind: "select", title: "Langs: Which languages? (selected: Go)", options: ["TS", "Rust", DONE, TYPE_OWN, CHAT] });
		expect(result).toEqual({ kind: "submit", answers: [{ question: "Which languages?", header: "Langs", selected: ["Go", "TS"], freeform: false }] });
	});

	it("takes a typed answer as freeform, and beside picks as typed", async () => {
		const own = await askThroughDialogs([layout], scripted([TYPE_OWN, "  Masonry  "]).ui);
		expect(own).toEqual({ kind: "submit", answers: [{ question: "Which layout?", header: "Layout", selected: ["Masonry"], freeform: true, typed: true }] });
		const mixed = await askThroughDialogs([langs], scripted(["Rust", TYPE_OWN, "Zig"]).ui);
		expect(mixed).toEqual({ kind: "submit", answers: [{ question: "Which languages?", header: "Langs", selected: ["Rust", "Zig"], freeform: false, typed: true }] });
	});

	it("cancels with the earlier answers when a dialog is dismissed", async () => {
		const result = await askThroughDialogs([layout, langs], scripted(["List", undefined]).ui);
		expect(result).toEqual({ kind: "cancel", answers: [{ question: "Which layout?", header: "Layout", selected: ["List"], freeform: false }] });
		expect(await askThroughDialogs([layout], scripted([TYPE_OWN, undefined]).ui)).toEqual({ kind: "cancel", answers: [] });
	});

	it("declines to chat", async () => {
		expect(await askThroughDialogs([layout, langs], scripted([CHAT]).ui)).toEqual({ kind: "chat" });
	});

	it("cancels on a reply that is not one of the rows instead of guessing", async () => {
		expect(await askThroughDialogs([layout], scripted(["Something else"]).ui)).toEqual({ kind: "cancel", answers: [] });
	});
});
