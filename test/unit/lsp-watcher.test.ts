import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { LspDiagnostic } from "../../extensions/lsp/format.ts";
import type { ShownDiagnostic } from "../../extensions/lsp/text.ts";
import {
	computeDelta,
	DeliveredTracker,
	fingerprintDiagnostic,
	formatNewDiagnostics as formatWith,
	markDelivered,
	MAX_CHARS,
} from "../../extensions/lsp/watcher.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";

const lspText = requireText("lsp");

const diag = (message: string, severity?: number, line = 0, character = 0, extra?: Partial<LspDiagnostic>): LspDiagnostic => ({
	message,
	severity,
	range: { start: { line, character } },
	...extra,
});

// A file URI for `/project/<name>` as this platform spells it (`D:\project\…` on Windows).
const PROJECT = resolve("/project");
const uri = (name: string) => pathToFileURL(join(PROJECT, name)).href;


/** The block with the profile's words, as the extension passes them (One Code's: profile/test/lsp-wording.test.ts). */
const formatNewDiagnostics = (delta: Map<string, LspDiagnostic[]>, cwd: string) => formatWith(delta, cwd, lspText.newDiagnostics);

describe("fingerprintDiagnostic", () => {
	it("is stable for identical content and differs when any field changes", () => {
		const base = diag("Cannot find name 'Token'.", 1, 50, 28, { code: 2304, source: "typescript" });
		expect(fingerprintDiagnostic(base)).toBe(fingerprintDiagnostic({ ...base }));
		expect(fingerprintDiagnostic(base)).not.toBe(fingerprintDiagnostic({ ...base, message: "other" }));
		expect(fingerprintDiagnostic(base)).not.toBe(fingerprintDiagnostic({ ...base, severity: 2 }));
		expect(fingerprintDiagnostic(base)).not.toBe(fingerprintDiagnostic({ ...base, code: 2305 }));
		expect(fingerprintDiagnostic(base)).not.toBe(
			fingerprintDiagnostic({ ...base, range: { start: { line: 51, character: 28 } } }),
		);
	});
});

describe("delta and tracker", () => {
	it("reports only fingerprints not yet delivered; unchanged files contribute nothing", () => {
		const tracker = new DeliveredTracker();
		const all = new Map([[uri("a.ts"), [diag("first", 1)]]]);
		const delta1 = computeDelta(all, tracker);
		expect([...delta1.keys()]).toEqual([uri("a.ts")]);
		markDelivered(delta1, tracker);

		expect(computeDelta(all, tracker).size).toBe(0);

		all.set(uri("a.ts"), [diag("first", 1), diag("second", 2)]);
		const delta2 = computeDelta(all, tracker);
		expect(delta2.get(uri("a.ts"))).toEqual([diag("second", 2)]);
	});

	it("computeDelta does not mutate; only markDelivered commits", () => {
		const tracker = new DeliveredTracker();
		const all = new Map([[uri("a.ts"), [diag("x", 1)]]]);
		computeDelta(all, tracker);
		expect(computeDelta(all, tracker).size).toBe(1);
	});

	it("clear(uri) lets a previously delivered diagnostic resurface", () => {
		const tracker = new DeliveredTracker();
		const all = new Map([[uri("a.ts"), [diag("x", 1)]]]);
		markDelivered(computeDelta(all, tracker), tracker);
		expect(computeDelta(all, tracker).size).toBe(0);

		tracker.clear(uri("a.ts"));
		expect(computeDelta(all, tracker).size).toBe(1);
	});

	it("evicts the least-recently-touched file past the cap", () => {
		const tracker = new DeliveredTracker(2);
		tracker.markDelivered(uri("old.ts"), ["fp"]);
		tracker.markDelivered(uri("mid.ts"), ["fp"]);
		tracker.markDelivered(uri("old.ts"), ["fp2"]); // touch: old is now most recent
		tracker.markDelivered(uri("new.ts"), ["fp"]); // evicts mid, not old
		expect(tracker.delivered(uri("mid.ts"))).toBeUndefined();
		expect(tracker.delivered(uri("old.ts"))).toBeDefined();
		expect(tracker.delivered(uri("new.ts"))).toBeDefined();
	});
});

describe("formatNewDiagnostics", () => {
	const words = lspText.newDiagnostics;
	/** One shown entry: 1-indexed position, the severity's name. */
	const entry = (message: string, severity: ShownDiagnostic["severity"], line = 1, column = 1, extra: Partial<ShownDiagnostic> = {}) =>
		words.entry({ line, column, severity, message, ...extra });
	/** The block for these sections (and remainder note), as the base joins them. */
	const block = (...parts: string[]) => words.block(parts.join("\n\n"));

	it("puts each file's section in the block, separated by blank lines, entries 1-indexed", () => {
		const delta = new Map([
			[uri("guards.ts"), [diag("Cannot find name 'Token'.", 1, 50, 28, { code: 2304, source: "typescript" })]],
			[uri("index.ts"), [diag("'ctx' is declared but its value is never read.", 4, 203, 57, { code: 6133, source: "typescript" })]],
		]);
		expect(formatNewDiagnostics(delta, PROJECT)).toBe(
			block(
				words.section({ path: "guards.ts", entries: [entry("Cannot find name 'Token'.", "error", 51, 29, { code: 2304, source: "typescript" })] }),
				words.section({ path: "index.ts", entries: [entry("'ctx' is declared but its value is never read.", "hint", 204, 58, { code: 6133, source: "typescript" })] }),
			),
		);
	});

	it("uses cwd-relative headers, not basenames (deliberate divergence)", () => {
		const delta = new Map([[uri("src/deep/index.ts"), [diag("x", 1)]]]);
		expect(formatNewDiagnostics(delta, PROJECT)).toBe(block(words.section({ path: join("src", "deep", "index.ts"), entries: [entry("x", "error")] })));
	});

	it("names each severity, treats a missing severity as an error, and lists the worst first", () => {
		const delta = new Map([
			[uri("a.ts"), [diag("e", 1), diag("w", 2), diag("i", 3), diag("h", 4), diag("u", undefined)]],
		]);
		expect(formatNewDiagnostics(delta, PROJECT)).toBe(
			block(words.section({ path: "a.ts", entries: [entry("e", "error"), entry("u", "error"), entry("w", "warning"), entry("i", "info"), entry("h", "hint")] })),
		);
	});

	it("caps at 10 per file, errors surviving first", () => {
		const list = [
			...Array.from({ length: 8 }, (_, i) => diag(`warn-${i}`, 2, i)),
			...Array.from({ length: 8 }, (_, i) => diag(`err-${i}`, 1, i)),
		];
		const kept = [...Array.from({ length: 8 }, (_, i) => entry(`err-${i}`, "error", i + 1)), entry("warn-0", "warning", 1), entry("warn-1", "warning", 2)];
		expect(formatNewDiagnostics(new Map([[uri("a.ts"), list]]), PROJECT)).toBe(block(words.section({ path: "a.ts", entries: kept }), words.more(6)));
	});

	it("caps at 30 total across files, worst-severity files first, with a remainder note", () => {
		const delta = new Map(
			Array.from({ length: 5 }, (_, f) => [
				uri(`f${f}.ts`),
				Array.from({ length: 10 }, (_, i) => diag(`f${f}-d${i}`, f === 4 ? 1 : 2, i)),
			] as const),
		);
		const section = (f: number) =>
			words.section({ path: `f${f}.ts`, entries: Array.from({ length: 10 }, (_, i) => entry(`f${f}-d${i}`, f === 4 ? "error" : "warning", i + 1)) });
		// f4 is all errors → sorted first; then f0, f1 fill the 30-cap.
		expect(formatNewDiagnostics(delta, PROJECT)).toBe(block(section(4), section(0), section(1), words.more(20)));
	});

	it("caps the body at MAX_CHARS, handing the kept head to the cut", () => {
		const delta = new Map([[uri("a.ts"), Array.from({ length: 10 }, (_, i) => diag("x".repeat(600), 1, i))]]);
		const body = words.section({ path: "a.ts", entries: Array.from({ length: 10 }, (_, i) => entry("x".repeat(600), "error", i + 1)) });
		expect(body.length).toBeGreaterThan(MAX_CHARS);
		expect(formatNewDiagnostics(delta, PROJECT)).toBe(words.block(words.cut(body.slice(0, MAX_CHARS))));
	});

	it("returns undefined for an empty delta", () => {
		expect(formatNewDiagnostics(new Map(), PROJECT)).toBeUndefined();
	});
});
