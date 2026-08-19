import { describe, expect, it } from "vitest";
import type { LspDiagnostic } from "../../extensions/lsp/format.ts";
import {
	computeDelta,
	DeliveredTracker,
	fingerprintDiagnostic,
	formatNewDiagnostics,
	markDelivered,
	MAX_CHARS,
} from "../../extensions/lsp/watcher.ts";

const diag = (message: string, severity?: number, line = 0, character = 0, extra?: Partial<LspDiagnostic>): LspDiagnostic => ({
	message,
	severity,
	range: { start: { line, character } },
	...extra,
});

const uri = (name: string) => `file:///project/${name}`;

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
	it("matches the exact block layout: tag into preamble, blank lines between files, two-space indent", () => {
		const delta = new Map([
			[uri("guards.ts"), [diag("Cannot find name 'Token'.", 1, 50, 28, { code: 2304, source: "typescript" })]],
			[uri("index.ts"), [diag("'ctx' is declared but its value is never read.", 4, 203, 57, { code: 6133, source: "typescript" })]],
		]);
		expect(formatNewDiagnostics(delta, "/project")).toBe(
			"<new-diagnostics>The following new diagnostic issues were detected:\n\n" +
				"guards.ts:\n" +
				"  ✘ [Line 51:29] Cannot find name 'Token'. [2304] (typescript)\n" +
				"\n" +
				"index.ts:\n" +
				"  ★ [Line 204:58] 'ctx' is declared but its value is never read. [6133] (typescript)\n" +
				"</new-diagnostics>",
		);
	});

	it("uses cwd-relative headers, not basenames (deliberate divergence)", () => {
		const delta = new Map([[`file:///project/src/deep/index.ts`, [diag("x", 1)]]]);
		expect(formatNewDiagnostics(delta, "/project")).toContain("\nsrc/deep/index.ts:\n");
	});

	it("maps severities to ✘ ⚠ ℹ ★ and treats missing severity as error", () => {
		const delta = new Map([
			[uri("a.ts"), [diag("e", 1), diag("w", 2), diag("i", 3), diag("h", 4), diag("u", undefined)]],
		]);
		const text = formatNewDiagnostics(delta, "/project")!;
		for (const sym of ["✘ [Line 1:1] e", "⚠ [Line 1:1] w", "ℹ [Line 1:1] i", "★ [Line 1:1] h", "✘ [Line 1:1] u"]) {
			expect(text).toContain(sym);
		}
	});

	it("caps at 10 per file, errors surviving first", () => {
		const list = [
			...Array.from({ length: 8 }, (_, i) => diag(`warn-${i}`, 2, i)),
			...Array.from({ length: 8 }, (_, i) => diag(`err-${i}`, 1, i)),
		];
		const text = formatNewDiagnostics(new Map([[uri("a.ts"), list]]), "/project")!;
		for (let i = 0; i < 8; i++) expect(text).toContain(`err-${i}`);
		expect(text).toContain("warn-0");
		expect(text).toContain("warn-1");
		expect(text).not.toContain("warn-2");
		expect(text).toContain("… 6 more");
	});

	it("caps at 30 total across files, worst-severity files first, with a remainder note", () => {
		const delta = new Map(
			Array.from({ length: 5 }, (_, f) => [
				uri(`f${f}.ts`),
				Array.from({ length: 10 }, (_, i) => diag(`f${f}-d${i}`, f === 4 ? 1 : 2, i)),
			] as const),
		);
		const text = formatNewDiagnostics(delta, "/project")!;
		// f4 is all errors → sorted first; then f0, f1 fill the 30-cap.
		expect(text).toContain("f4.ts:");
		expect(text).toContain("f0.ts:");
		expect(text).toContain("f1.ts:");
		expect(text).not.toContain("f2.ts:");
		expect(text).toContain("… 20 more");
	});

	it("caps the body at 4000 chars with a truncation marker", () => {
		const delta = new Map([[uri("a.ts"), Array.from({ length: 10 }, (_, i) => diag("x".repeat(600), 1, i))]]);
		const text = formatNewDiagnostics(delta, "/project")!;
		expect(text.length).toBeLessThan(MAX_CHARS + 200);
		expect(text).toContain("…[truncated]");
		expect(text.endsWith("</new-diagnostics>")).toBe(true);
	});

	it("returns undefined for an empty delta", () => {
		expect(formatNewDiagnostics(new Map(), "/project")).toBeUndefined();
	});
});
