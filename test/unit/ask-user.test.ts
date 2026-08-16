import { describe, expect, it } from "vitest";
import { type Answer, formatAnswers, formatDecline, type Question } from "../../extensions/ask-user/questions.ts";
import {
	applyWidgetKey,
	collectAnswers,
	createWidgetState,
	decodeWidgetKey,
	footerFor,
	hasPreviews,
	isAnswered,
	renderWidget,
	rowNumbers,
	rowsFor,
	type WidgetKey,
	type WidgetState,
} from "../../extensions/ask-user/widget.ts";

const previewQuestion: Question = {
	question: "Which layout style do you like best?",
	header: "Layout",
	options: [
		{ label: "Card grid", preview: "[ A ][ B ]\n[ C ][ D ]" },
		{ label: "Top tabs", preview: "[ A ][ B ][ C ]\n content here" },
	],
};

const multiQuestion: Question = {
	question: "Which languages do you use?",
	header: "Languages",
	multiSelect: true,
	options: [
		{ label: "Python", description: "Scripting, ML" },
		{ label: "Go", description: "Backends, CLIs" },
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

const style = {
	paint: (_color: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

function press(state: WidgetState, ...keys: (WidgetKey | string)[]) {
	let result: ReturnType<typeof applyWidgetKey>;
	for (const key of keys) {
		result = applyWidgetKey(state, typeof key === "string" ? { kind: "text", text: key } : key);
	}
	return result;
}

const enter: WidgetKey = { kind: "enter" };
const down: WidgetKey = { kind: "down" };
const esc: WidgetKey = { kind: "esc" };

describe("decodeWidgetKey", () => {
	it("decodes navigation and control keys", () => {
		expect(decodeWidgetKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodeWidgetKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodeWidgetKey("\t")).toEqual({ kind: "nextTab" });
		expect(decodeWidgetKey("\x1b[Z")).toEqual({ kind: "prevTab" });
		expect(decodeWidgetKey("\x1b[D")).toEqual({ kind: "prevTab" });
		expect(decodeWidgetKey("\r")).toEqual({ kind: "enter" });
		expect(decodeWidgetKey("\x1b")).toEqual({ kind: "esc" });
		expect(decodeWidgetKey("\x7f")).toEqual({ kind: "backspace" });
	});

	it("treats printable input as text and drops unknown escape sequences", () => {
		expect(decodeWidgetKey("n")).toEqual({ kind: "text", text: "n" });
		expect(decodeWidgetKey("hello")).toEqual({ kind: "text", text: "hello" });
		expect(decodeWidgetKey("\x1b[H")).toBeUndefined();
		expect(decodeWidgetKey("\x00")).toBeUndefined();
	});
});

describe("row model", () => {
	it("preview questions drop the free-text row; others keep it", () => {
		expect(hasPreviews(previewQuestion)).toBe(true);
		expect(rowsFor(previewQuestion).map((r) => r.kind)).toEqual(["option", "option", "chat"]);
		expect(rowsFor(plainQuestion).map((r) => r.kind)).toEqual(["option", "option", "other", "chat"]);
		expect(rowsFor(multiQuestion).map((r) => r.kind)).toEqual(["option", "option", "other", "next", "chat"]);
	});

	it("multi-select with previews stays stacked (previews are single-select only)", () => {
		expect(hasPreviews({ ...multiQuestion, options: [{ label: "A", preview: "x" }, { label: "B" }] })).toBe(false);
	});

	it("numbers rows the way they display: Next and preview-layout chat are unnumbered", () => {
		expect(rowNumbers(multiQuestion, rowsFor(multiQuestion))).toEqual([1, 2, 3, undefined, 4]);
		expect(rowNumbers(plainQuestion, rowsFor(plainQuestion))).toEqual([1, 2, 3, 4]);
		expect(rowNumbers(previewQuestion, rowsFor(previewQuestion))).toEqual([1, 2, undefined]);
	});

	it("digits cannot activate an unnumbered row", () => {
		const state = createWidgetState([previewQuestion]);
		expect(press(state, "3")).toBeUndefined(); // chat shows no number in preview layout
		expect(state.qs[0].cursor).toBe(0);
	});
});

describe("answer flow", () => {
	it("single-select enter answers and advances to the next question", () => {
		const state = createWidgetState([previewQuestion, plainQuestion]);
		press(state, enter);
		expect(isAnswered(state.qs[0])).toBe(true);
		expect(state.tab).toBe(1);
	});

	it("answering the last question advances to the Submit tab and Enter submits", () => {
		const state = createWidgetState([previewQuestion, plainQuestion]);
		press(state, enter); // Card grid
		press(state, down, enter); // Red
		expect(state.tab).toBe(2);
		const result = press(state, enter);
		expect(result).toEqual({
			kind: "submit",
			answers: [
				expect.objectContaining({ selected: ["Card grid"], freeform: false }),
				expect.objectContaining({ selected: ["Red"], freeform: false }),
			],
		});
	});

	it("multi-select toggles checkboxes and commits via Next", () => {
		const state = createWidgetState([multiQuestion]);
		press(state, enter); // toggle Python on
		press(state, enter); // toggle Python off
		press(state, enter); // on again
		press(state, down, enter); // toggle Go
		expect(state.qs[0].selected).toEqual([0, 1]);
		press(state, down, down, enter); // Next (unnumbered — digits skip it)
		expect(state.qs[0].committed).toBe(true);
		expect(state.tab).toBe(1); // Submit tab
	});

	it("typed free-text answers a single-select question", () => {
		const state = createWidgetState([plainQuestion]);
		press(state, "3"); // jump to Type something → editing
		expect(state.editing?.field).toBe("other");
		press(state, "Teal", enter);
		expect(state.editing).toBeUndefined();
		const [answer] = collectAnswers(state);
		expect(answer).toMatchObject({ selected: ["Teal"], freeform: true });
		expect(state.tab).toBe(1);
	});

	it("typed free-text joins the selections on a multi-select question", () => {
		const state = createWidgetState([multiQuestion]);
		press(state, enter); // Python
		press(state, "3"); // Type something
		press(state, "Zig", enter);
		expect(state.editing).toBeUndefined();
		expect(state.tab).toBe(0); // multi-select stays until Next
		press(state, down, enter); // Next
		expect(collectAnswers(state)[0]).toMatchObject({ selected: ["Python", "Zig"], freeform: false });
	});

	it("notes attach to the answer on preview questions", () => {
		const state = createWidgetState([previewQuestion]);
		press(state, "n");
		expect(state.editing?.field).toBe("notes");
		press(state, "prefer compact", enter);
		press(state, enter); // answer Card grid
		expect(collectAnswers(state)[0].notes).toBe("prefer compact");
	});

	it("ignores 'n' as a notes key on questions without previews", () => {
		const state = createWidgetState([plainQuestion]);
		press(state, "n");
		expect(state.editing).toBeUndefined();
	});
});

describe("decline and cancel", () => {
	it("Chat about this resolves the whole batch as a decline", () => {
		const state = createWidgetState([previewQuestion, plainQuestion]);
		const result = press(state, down, down, enter); // chat row
		expect(result).toEqual({ kind: "chat" });
	});

	it("Esc cancels; Esc while editing only backs out of the editor", () => {
		const state = createWidgetState([plainQuestion]);
		press(state, "3"); // start typing
		expect(press(state, esc)).toBeUndefined();
		expect(state.editing).toBeUndefined();
		expect(press(state, esc)).toEqual({ kind: "cancel", answers: [] });
	});

	it("Esc reports the unsubmitted answers already given on other tabs", () => {
		const state = createWidgetState([previewQuestion, plainQuestion]);
		press(state, enter); // answer Layout, advance to Color
		const result = press(state, esc);
		expect(result).toEqual({
			kind: "cancel",
			answers: [expect.objectContaining({ header: "Layout", selected: ["Card grid"] })],
		});
	});

	it("Submit with unanswered questions jumps to the first one instead", () => {
		const state = createWidgetState([previewQuestion, plainQuestion]);
		press(state, { kind: "nextTab" }, { kind: "nextTab" }); // to Submit
		expect(state.tab).toBe(2);
		expect(press(state, enter)).toBeUndefined();
		expect(state.tab).toBe(0);
	});

	it("tab navigation wraps around both ways", () => {
		const state = createWidgetState([previewQuestion, plainQuestion]);
		press(state, { kind: "prevTab" });
		expect(state.tab).toBe(2);
		press(state, { kind: "nextTab" });
		expect(state.tab).toBe(0);
	});
});

describe("renderWidget", () => {
	const within = (lines: string[], width: number) =>
		lines.every((line) => [...line.replace(/\x1b\[[0-9;]*m/g, "")].length <= width);

	it("paints only the active tab as an inverse chip", () => {
		const marker = { ...style, inverse: (text: string) => `«${text}»` };
		const state = createWidgetState([previewQuestion, multiQuestion]);
		const tabBar = renderWidget(state, marker, 100)[1];
		expect(tabBar).toContain("« ⊡ Layout »");
		expect(tabBar).not.toContain("« ⊡ Languages »");
		press(state, { kind: "nextTab" });
		expect(renderWidget(state, marker, 100)[1]).toContain("« ⊡ Languages »");
	});

	it("renders the tab bar, preview box, notes hint, and footer", () => {
		const state = createWidgetState([previewQuestion, multiQuestion]);
		const lines = renderWidget(state, style, 100);
		const text = lines.join("\n");
		expect(text).toContain("⊡ Layout");
		expect(text).toContain("⊡ Languages");
		expect(text).toContain("✔ Submit");
		expect(text).toContain("❯ 1. Card grid");
		expect(text).toContain("[ A ][ B ]");
		expect(text).toContain("┌");
		expect(text).toContain("press n to add notes");
		expect(text).toContain("Chat about this");
		expect(text).toContain("n to add notes");
		expect(within(lines, 100)).toBe(true);
	});

	it("marks answered tabs and renders checkboxes on multi-select", () => {
		const state = createWidgetState([previewQuestion, multiQuestion]);
		press(state, enter); // answer Layout → now on Languages
		const lines = renderWidget(state, style, 100);
		const text = lines.join("\n");
		expect(text).toContain("⊠ Layout");
		expect(text).toContain("[ ] Python");
		expect(text).toContain("3. [ ] Type something.");
		expect(text).toContain("Next");
		expect(text).toContain("4. Chat about this"); // Next is unnumbered, CC-style
		press(state, enter); // tick Python
		expect(renderWidget(state, style, 100).join("\n")).toContain("[✔] Python");
	});

	it("renders the free-text draft with a cursor while editing", () => {
		const state = createWidgetState([plainQuestion]);
		press(state, "3", "Te");
		const text = renderWidget(state, style, 100).join("\n");
		expect(text).toContain("Te▏");
		expect(footerFor(state)).toContain("Enter to confirm");
	});

	it("renders the submit tab summary", () => {
		const state = createWidgetState([previewQuestion, plainQuestion]);
		press(state, enter); // answer q1 only
		press(state, { kind: "nextTab" }); // Color → Submit
		expect(state.tab).toBe(2);
		const text = renderWidget(state, style, 100).join("\n");
		expect(text).toContain("→ Card grid");
		expect(text).toContain("(unanswered)");
		expect(text).toContain("Enter jumps to the first one");
	});

	it("stays within narrow widths", () => {
		const state = createWidgetState([previewQuestion, multiQuestion, plainQuestion]);
		for (const width of [30, 45, 60]) {
			expect(within(renderWidget(state, style, width), width)).toBe(true);
		}
	});
});

describe("formatAnswers", () => {
	const answer = (selected: string[], freeform = false, notes?: string): Answer => ({
		question: "Which database?",
		header: "Database",
		selected,
		freeform,
		notes,
	});

	it("renders one answer", () => {
		expect(formatAnswers([answer(["Postgres"])])).toBe("Which database?\n→ Postgres");
	});

	it("joins multi-select answers", () => {
		expect(formatAnswers([answer(["Postgres", "SQLite"])])).toContain("→ Postgres, SQLite");
	});

	it("marks a typed answer and appends notes", () => {
		expect(formatAnswers([answer(["DuckDB"], true)])).toContain("(typed by the user)");
		expect(formatAnswers([answer(["Postgres"], false, "must stay managed")])).toContain(
			"→ notes: must stay managed",
		);
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

describe("formatDecline", () => {
	it("lists the declined questions with their options", () => {
		const out = formatDecline([previewQuestion, plainQuestion]);
		expect(out).toContain("declined to answer");
		expect(out).toContain("· Which layout style do you like best? (Card grid / Top tabs)");
		expect(out).toContain("· Favorite color? (Blue / Red)");
		expect(out).toContain("don't call ask_user_question again");
	});
});
