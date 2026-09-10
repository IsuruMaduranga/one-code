import { describe, expect, it } from "vitest";
import { applyDoctorKey, decodeDoctorKey, renderDoctorViewer, VIEWER_CHROME_ROWS, visibleBodyRows } from "../../extensions/doctor/viewer.ts";

const paint = (_c: string, t: string) => t;
const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

describe("doctor viewer", () => {
	it("decodes arrows, paging, home/end, f and close keys", () => {
		expect(decodeDoctorKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodeDoctorKey("\x1b[5~")).toEqual({ kind: "pageUp" });
		expect(decodeDoctorKey(" ")).toEqual({ kind: "pageDown" });
		expect(decodeDoctorKey("b")).toEqual({ kind: "pageUp" });
		expect(decodeDoctorKey("G")).toEqual({ kind: "end" });
		expect(decodeDoctorKey("f")).toEqual({ kind: "fix" });
		expect(decodeDoctorKey("\x1b")).toEqual({ kind: "close" });
		expect(decodeDoctorKey("\r")).toEqual({ kind: "close" });
		expect(decodeDoctorKey("z")).toBeUndefined();
	});

	it("scrolls within bounds and pages by the visible height", () => {
		const state = { offset: 0 };
		applyDoctorKey(state, { kind: "up" }, 30, 10);
		expect(state.offset).toBe(0);
		applyDoctorKey(state, { kind: "pageDown" }, 30, 10);
		expect(state.offset).toBe(9);
		applyDoctorKey(state, { kind: "end" }, 30, 10);
		expect(state.offset).toBe(20);
		applyDoctorKey(state, { kind: "down" }, 30, 10);
		expect(state.offset).toBe(20);
		expect(applyDoctorKey(state, { kind: "fix" }, 30, 10)).toEqual({ kind: "fix" });
		expect(applyDoctorKey(state, { kind: "close" }, 30, 10)).toEqual({ kind: "close" });
	});

	it("renders exactly `height` rows with the position and key hints", () => {
		const state = { offset: 5 };
		const out = renderDoctorViewer({ lines, state, width: 60, height: 13, canFix: true }, paint);
		expect(out).toHaveLength(13);
		expect(visibleBodyRows(13)).toBe(13 - VIEWER_CHROME_ROWS);
		expect(out[1]).toBe("line 6");
		expect(out.at(-1)).toContain("6-15 of 30");
		expect(out.at(-1)).toContain("f ask the model to fix");
		expect(out.at(-1)).toContain("esc close");
		const noFix = renderDoctorViewer({ lines, state: { offset: 0 }, width: 60, height: 40, canFix: false }, paint);
		expect(noFix.at(-1)).not.toContain("f ask");
		expect(noFix.at(-1)).not.toContain(" of ");
	});

	it("clamps a stale offset when the terminal grows", () => {
		const state = { offset: 25 };
		renderDoctorViewer({ lines, state, width: 60, height: 40, canFix: false }, paint);
		expect(state.offset).toBe(0);
	});
});
