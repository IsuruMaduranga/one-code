import { describe, expect, it } from "vitest";
import {
	type Answer,
	buildChoices,
	DONE_LABEL,
	formatAnswers,
	formatOptionLabel,
	OTHER_LABEL,
	type Question,
	resolveSelection,
	stripMark,
} from "../../extensions/ask-user/questions.ts";

const question: Question = {
	question: "Which database?",
	header: "Database",
	options: [
		{ label: "Postgres", description: "Relational, default choice" },
		{ label: "SQLite" },
	],
};

describe("formatOptionLabel", () => {
	it("appends a description when present", () => {
		expect(formatOptionLabel(question.options[0])).toBe("Postgres — Relational, default choice");
		expect(formatOptionLabel(question.options[1])).toBe("SQLite");
	});
});

describe("buildChoices", () => {
	it("offers the options plus a free-text escape hatch", () => {
		const choices = buildChoices(question);
		expect(choices).toEqual(["Postgres — Relational, default choice", "SQLite", OTHER_LABEL]);
	});

	it("adds a done entry and ticks selections in multi-select mode", () => {
		const choices = buildChoices({ ...question, multiSelect: true }, ["SQLite"]);
		expect(choices).toEqual([
			"Postgres — Relational, default choice",
			"✓ SQLite",
			DONE_LABEL,
			OTHER_LABEL,
		]);
	});
});

describe("stripMark and resolveSelection", () => {
	it("removes the tick from a marked choice", () => {
		expect(stripMark("✓ SQLite")).toBe("SQLite");
		expect(stripMark("SQLite")).toBe("SQLite");
	});

	it("maps a display string back to its option label", () => {
		expect(resolveSelection("Postgres — Relational, default choice", question.options)).toBe("Postgres");
		expect(resolveSelection("SQLite", question.options)).toBe("SQLite");
	});

	it("returns undefined for an unknown display string", () => {
		expect(resolveSelection(DONE_LABEL, question.options)).toBeUndefined();
	});
});

describe("formatAnswers", () => {
	const answer = (selected: string[], freeform = false): Answer => ({
		question: "Which database?",
		header: "Database",
		selected,
		freeform,
	});

	it("renders one answer", () => {
		expect(formatAnswers([answer(["Postgres"])])).toBe("Which database?\n→ Postgres");
	});

	it("joins multi-select answers", () => {
		expect(formatAnswers([answer(["Postgres", "SQLite"])])).toContain("→ Postgres, SQLite");
	});

	it("marks a typed answer", () => {
		expect(formatAnswers([answer(["DuckDB"], true)])).toContain("(typed by the user)");
	});

	it("handles no selection and no answers", () => {
		expect(formatAnswers([answer([])])).toContain("(no answer)");
		expect(formatAnswers([])).toBe("The user did not answer.");
	});

	it("separates several questions", () => {
		const out = formatAnswers([answer(["Postgres"]), { ...answer(["Yes"]), question: "Run migrations?" }]);
		expect(out.split("\n\n")).toHaveLength(2);
		expect(out).toContain("Run migrations?");
	});
});
