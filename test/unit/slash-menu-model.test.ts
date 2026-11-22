import { describe, expect, it } from "vitest";
import { arrangeSlashItems, fitSlashDescriptions, hiddenMenuCommands, slashMenuRows, stripSourceTag } from "../../extensions/lib/ui/slash-menu-model.ts";
import { visibleWidth } from "../../extensions/lib/ui/text-width.ts";

const item = (value: string, description?: string) => ({ value, label: value, ...(description === undefined ? {} : { description }) });

describe("stripSourceTag", () => {
	it("drops pi's source tags in every form", () => {
		expect(stripSourceTag("[t] Configure includes")).toBe("Configure includes");
		expect(stripSourceTag("[u] Mine")).toBe("Mine");
		expect(stripSourceTag("[p:npm:@scope/pkg] From a package")).toBe("From a package");
		expect(stripSourceTag("[u:git:github.com/a/b@v1] From git")).toBe("From git");
		expect(stripSourceTag("[t]")).toBe("");
	});

	it("drops the tag after a template's argument hint", () => {
		expect(stripSourceTag("<file> — [u] Review a file")).toBe("<file> — Review a file");
		expect(stripSourceTag("<file> — [u]")).toBe("<file>");
	});

	it("leaves a description that only looks like a tag alone", () => {
		expect(stripSourceTag("[path] to open")).toBe("[path] to open");
		expect(stripSourceTag("<provider/model> — Select model")).toBe("<provider/model> — Select model");
		expect(stripSourceTag("[t]ools list")).toBe("[t]ools list");
	});
});

describe("arrangeSlashItems", () => {
	const piOrder = [item("settings", "Open settings menu"), item("thinking", "<level> — Set thinking level"), item("model"), item("auto-mode", "[t] Auto mode"), item("autocompact", "[t] Compact"), item("btw", "[t] Side question")];

	it("sorts the bare menu alphabetically, with /name labels and no tags", () => {
		const rows = arrangeSlashItems(piOrder, "/", hiddenMenuCommands(true));
		expect(rows.map((row) => row.label)).toEqual(["/auto-mode", "/autocompact", "/btw", "/model", "/settings"]);
		expect(rows.map((row) => row.description)).toEqual(["Auto mode", "Compact", "Side question", undefined, "Open settings menu"]);
		// The value is what pi completes and runs; it keeps no slash.
		expect(rows[0]?.value).toBe("auto-mode");
	});

	it("drops a hidden built-in but keeps pi's ranking once a filter is typed", () => {
		const ranked = [item("btw", "[t] x"), item("auto-mode", "[t] y"), item("thinking")];
		expect(arrangeSlashItems(ranked, "/t", hiddenMenuCommands(true)).map((row) => row.value)).toEqual(["btw", "auto-mode"]);
	});

	it("keeps /thinking when the effort feature that replaces it is off", () => {
		expect(arrangeSlashItems(piOrder, "/", hiddenMenuCommands(false)).map((row) => row.value)).toContain("thinking");
	});

	it("leaves argument and file completions alone", () => {
		const args = [item("high", "[t] not a command")];
		expect(arrangeSlashItems(args, "/effort h", hiddenMenuCommands(true))).toBe(args);
		expect(arrangeSlashItems(args, "@src", hiddenMenuCommands(true))).toBe(args);
	});
});

describe("fitSlashDescriptions", () => {
	const long = "Health-check your setup and fix issues: installation, unused extensions, duplicated memory files";

	it("ends a cut description with an ellipsis, within the columns pi-tui gives it", () => {
		const width = 70;
		const [row] = fitSlashDescriptions([item("/doctor", long)], width);
		// Name column: the 12-column minimum, after the 2-column pointer; a 2-column margin at the end.
		const room = width - 2 - 12 - 2;
		expect(row?.description?.endsWith("…")).toBe(true);
		expect(visibleWidth(row?.description ?? "")).toBe(room);
	});

	it("measures terminal columns, not code units", () => {
		const wide = "設定を開いてモデルを選び直すための長い説明文です。さらに続きます。";
		const [row] = fitSlashDescriptions([item("/x", wide)], 50);
		expect(visibleWidth(row?.description ?? "")).toBeLessThanOrEqual(50 - 2 - 12 - 2);
		expect(row?.description?.endsWith("…")).toBe(true);
	});

	it("sizes the name column from the widest name, up to 32 columns", () => {
		const name = "/a-rather-long-command-name";
		const width = 100;
		const [, row] = fitSlashDescriptions([item(name), item("/x", long)], width);
		expect(visibleWidth(row?.description ?? "")).toBe(width - 2 - (name.length + 2) - 2);
	});

	it("leaves a fitting description, and a narrow list pi draws without descriptions, untouched", () => {
		const rows = [item("/x", "short")];
		expect(fitSlashDescriptions(rows, 80)[0]).toBe(rows[0]);
		const narrow = [item("/x", long)];
		expect(fitSlashDescriptions(narrow, 40)).toBe(narrow);
	});
});

describe("slashMenuRows", () => {
	it("grows with the terminal to Claude Code's count, within pi's limit", () => {
		expect(slashMenuRows(45, 5)).toBe(20);
		expect(slashMenuRows(34, 5)).toBe(10);
		expect(slashMenuRows(60, 5)).toBe(20);
	});

	it("never goes below pi's five rows on a short terminal", () => {
		expect(slashMenuRows(24, 5)).toBe(5);
		expect(slashMenuRows(12, 5)).toBe(5);
		expect(slashMenuRows(Number.NaN, 5)).toBe(5);
	});

	it("keeps a count the user set in pi's settings", () => {
		expect(slashMenuRows(45, 8)).toBe(8);
		expect(slashMenuRows(20, 12)).toBe(12);
	});
});
