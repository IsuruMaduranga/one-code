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
	it("numbers the options when one is labelled like a control row, so picking it selects it", async () => {
		const clash: Question = { question: "Next?", header: "Next", options: [{ label: CHAT }, { label: "Ship" }] };
		const { ui, shown } = scripted([`1. ${CHAT}`]);
		const result = await askThroughDialogs([clash], ui);
		expect(shown[0].options).toEqual([`1. ${CHAT}`, "2. Ship", TYPE_OWN, CHAT]);
		expect(result).toMatchObject({ kind: "submit", answers: [{ selected: [CHAT] }] });
	});

	it("keeps two options that share a label selectable, and previews the one picked", async () => {
		const twins: Question = {
			question: "Which?",
			header: "Pick",
			multiSelect: true,
			options: [{ label: "Fast", description: "cached" }, { label: "Fast", description: "uncached" }],
		};
		const { ui, shown } = scripted([optionRow(twins.options[0]), optionRow(twins.options[1])]);
		const result = await askThroughDialogs([twins], ui);
		expect(shown[1].options).toContain(optionRow(twins.options[1]));
		expect(result).toMatchObject({ kind: "submit", answers: [{ selected: ["Fast", "Fast"] }] });
		const single: Question = { question: "Which?", header: "Pick", options: [{ label: "Fast", description: "a", preview: "A" }, { label: "Fast", description: "b", preview: "B" }] };
		const second = await askThroughDialogs([single], scripted([optionRow(single.options[1])]).ui);
		expect(second).toMatchObject({ kind: "submit", answers: [{ preview: "B" }] });
	});

	it("asks again after a blank typed answer instead of submitting nothing", async () => {
		const { ui, shown } = scripted([TYPE_OWN, "   ", TYPE_OWN, "Masonry"]);
		const result = await askThroughDialogs([layout], ui);
		expect(shown.map((s) => s.kind)).toEqual(["select", "input", "select", "input"]);
		expect(result).toMatchObject({ kind: "submit", answers: [{ selected: ["Masonry"], freeform: true }] });
	});

	it("asks a single-select question with the options, a typed answer and chat rows", async () => {
		const { ui, shown } = scripted([optionRow(layout.options[0])]);
		const result = await askThroughDialogs([layout], ui);
		expect(shown).toEqual([{ kind: "select", title: "Layout: Which layout?\n\nGrid — Cards in rows:\n[A][B]", options: ["Grid — Cards in rows", "List", TYPE_OWN, CHAT] }]);
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

	for (const label of [DONE, TYPE_OWN, CHAT]) {
		it(`selects a literal ${JSON.stringify(label)} option rather than treating it as a control`, async () => {
			const question: Question = { question: "Pick a label", header: "Label", options: [{ label }, { label: "Other" }] };
			const ui: DialogUI = {
				select: async (_title, options) => options[0],
				input: async () => undefined,
			};
			expect(await askThroughDialogs([question], ui)).toMatchObject({ kind: "submit", answers: [{ selected: [label] }] });
		});
	}

	it("distinguishes different options whose label/description render identically", async () => {
		const question: Question = { question: "Which?", header: "Q", options: [{ label: "A — B" }, { label: "A", description: "B" }] };
		const ui: DialogUI = { select: async (_title, options) => options[1], input: async () => undefined };
		expect(await askThroughDialogs([question], ui)).toMatchObject({ kind: "submit", answers: [{ selected: ["A"] }] });
	});

	it("records the chosen option's preview when two options share a label", async () => {
		const question: Question = { question: "Which?", header: "Q", options: [{ label: "Layout", description: "A", preview: "first" }, { label: "Layout", description: "B", preview: "second" }] };
		const ui: DialogUI = { select: async (_title, options) => options[1], input: async () => undefined };
		expect(await askThroughDialogs([question], ui)).toMatchObject({ kind: "submit", answers: [{ selected: ["Layout"], preview: "second" }] });
	});

	it("shows previews before recording that the user selected a preview", async () => {
		const { ui, shown } = scripted([optionRow(layout.options[0])]);
		await askThroughDialogs([layout], ui);
		expect(shown[0].title).toContain(layout.options[0].preview);
	});

	it("declines to chat", async () => {
		expect(await askThroughDialogs([layout, langs], scripted([CHAT]).ui)).toEqual({ kind: "chat" });
	});

	it("cancels on a reply that is not one of the rows instead of guessing", async () => {
		expect(await askThroughDialogs([layout], scripted(["Something else"]).ui)).toEqual({ kind: "cancel", answers: [] });
	});
});
