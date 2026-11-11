/**
 * One Code's ask_user_question wording (profile/text/ask-user/): the answers in
 * Claude Code's phrasing, the careful-reading note for typed answers and
 * notes, and the decline that lists the questions back.
 */
import { describe, expect, it } from "vitest";
import type { Answer, Question } from "../../extensions/tools/ask-user/questions.ts";
import { answerPairs, formatAnswers, formatDecline } from "../../extensions/tools/ask-user/text.ts";

const previewQuestion: Question = {
	question: "Which layout style do you like best?",
	header: "Layout",
	options: [
		{ label: "Card grid", preview: "[ A ][ B ]\n[ C ][ D ]" },
		{ label: "Top tabs", preview: "[ A ][ B ][ C ]\n content here" },
	],
};

const plainQuestion: Question = {
	question: "Favorite color?",
	header: "Color",
	options: [
		{ label: "Blue", description: "Calm, works in most themes" },
		{ label: "Red" },
	],
};

describe("formatAnswers", () => {
	const answer = (selected: string[], freeform = false, notes?: string): Answer => ({
		question: "Which database?",
		header: "Database",
		selected,
		freeform,
		...(freeform ? { typed: true } : {}),
		notes,
	});

	it("confirms answers picked from the options in Claude Code's words", () => {
		expect(formatAnswers([answer(["Postgres"])])).toBe(
			'Your questions have been answered: "Which database?"="Postgres". You can now continue with these answers in mind.',
		);
	});

	it("joins multi-select answers and several questions", () => {
		expect(formatAnswers([answer(["Postgres", "SQLite"]), { ...answer(["Yes"]), question: "Run migrations?" }])).toBe(
			'Your questions have been answered: "Which database?"="Postgres, SQLite", "Run migrations?"="Yes". You can now continue with these answers in mind.',
		);
	});

	it("tells the model to read a typed answer or notes carefully", () => {
		const careful = " Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.";
		expect(formatAnswers([answer(["DuckDB"], true)])).toBe(`The user answered: "Which database?"="DuckDB".${careful}`);
		expect(formatAnswers([answer(["Postgres"], false, "must stay managed")])).toBe(
			`The user answered: "Which database?"="Postgres" notes: must stay managed.${careful}`,
		);
		expect(formatAnswers([{ ...answer(["Postgres", "Zig"]), typed: true }])).toBe(`The user answered: "Which database?"="Postgres, Zig".${careful}`);
	});

	it("carries the picked option's preview", () => {
		expect(answerPairs([{ ...answer(["Card grid"]), preview: "[ ][ ]\n[ ][ ]" }])).toBe('"Which database?"="Card grid" selected preview:\n[ ][ ]\n[ ][ ]');
	});

	it("lists an unanswered question only when it carries notes", () => {
		expect(formatAnswers([answer([])])).toBe("The user did not answer the questions.");
		expect(formatAnswers([])).toBe("The user did not answer the questions.");
		expect(answerPairs([answer([], false, "not sure yet"), { ...answer(["Yes"]), question: "Run migrations?" }])).toBe(
			'"Which database?"=(no option selected) notes: not sure yet, "Run migrations?"="Yes"',
		);
	});
});

describe("formatDecline", () => {
	it("lists the declined questions with their options", () => {
		const out = formatDecline([previewQuestion, plainQuestion]);
		expect(out).toContain("declined to answer");
		expect(out).toContain("· Which layout style do you like best? (Card grid / Top tabs)");
		expect(out).toContain("· Favorite color? (Blue / Red)");
		expect(out).toContain("don't call ask_user_question again");
	});
});

describe("an answer with a preview, as the dialogs collect it", () => {
	it("quotes the picked option and its preview", () => {
		const answers: Answer[] = [{ question: "Which layout?", header: "Layout", selected: ["Grid"], freeform: false, preview: "[A][B]" }];
		expect(formatAnswers(answers)).toBe('Your questions have been answered: "Which layout?"="Grid" selected preview:\n[A][B]. You can now continue with these answers in mind.');
	});
});
