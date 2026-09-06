import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedSince, FORMATTER_NOTICE, fileToolTarget, snapshotFile } from "../../extensions/hooks/formatter-notice.ts";

const dir = () => mkdtempSync(join(tmpdir(), "formatter-notice-"));

describe("fileToolTarget", () => {
	it("resolves a file tool's target against the cwd", () => {
		expect(fileToolTarget("edit", { path: "src/a.py" }, "/repo")).toBe("/repo/src/a.py");
		expect(fileToolTarget("write", { path: "/abs/b.py" }, "/repo")).toBe("/abs/b.py");
		expect(fileToolTarget("notebook_edit", { path: "n.ipynb" }, "/repo")).toBe("/repo/n.ipynb");
	});

	it("ignores tools that do not write a file, and calls with no path", () => {
		expect(fileToolTarget("bash", { command: "ls" }, "/repo")).toBeUndefined();
		expect(fileToolTarget("read", { path: "src/a.py" }, "/repo")).toBeUndefined();
		expect(fileToolTarget("edit", {}, "/repo")).toBeUndefined();
		expect(fileToolTarget("edit", { path: "   " }, "/repo")).toBeUndefined();
	});
});

describe("changedSince", () => {
	it("detects a hook rewriting the file after the edit", () => {
		const path = join(dir(), "a.py");
		writeFileSync(path, 'def f():\n    """doc"""\n');
		const before = snapshotFile(path);
		writeFileSync(path, "def f():\n    '''doc'''\n");
		expect(changedSince(path, before)).toBe(true);
	});

	it("says nothing changed when the hook left the file alone", () => {
		const path = join(dir(), "b.py");
		writeFileSync(path, "x = 1\n");
		const before = snapshotFile(path);
		expect(changedSince(path, before)).toBe(false);
	});

	it("claims nothing about a file it could not read either side", () => {
		const path = join(dir(), "missing.py");
		expect(changedSince(path, snapshotFile(path))).toBe(false);
		const real = join(dir(), "c.py");
		writeFileSync(real, "x = 1\n");
		const before = snapshotFile(real);
		expect(changedSince(join(dir(), "gone.py"), before)).toBe(false);
	});

	it("reports changed when the file crossed the compare-size boundary (kind mismatch)", () => {
		// The file grew past MAX_COMPARE_BYTES since the snapshot: `before` is a
		// stamp, `after` is content — a kind mismatch that means the size changed,
		// so the file changed. Must not be swallowed as "no change" (code-review F5).
		const path = join(dir(), "grew.py");
		writeFileSync(path, "x = 1\n"); // small: snapshotFile returns content
		expect(changedSince(path, { kind: "stamp", value: "123:9999999" })).toBe(true);
	});
});

describe("FORMATTER_NOTICE", () => {
	it("names the file, forbids a revert, and asks for a read before reporting", () => {
		const text = FORMATTER_NOTICE("/repo/src/a.py");
		expect(text).toContain("/repo/src/a.py");
		expect(text).toMatch(/do not revert/i);
		expect(text).toMatch(/read the file first/i);
	});
});
