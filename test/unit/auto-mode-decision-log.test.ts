import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDecision, decisionEntry } from "../../extensions/auto-mode/decision-log.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cc-decision-log-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("decision log", () => {
	it("appends one JSON line per decision, creating the directory", () => {
		const file = join(dir, "nested", "auto-mode-decisions.jsonl");
		appendDecision(file, decisionEntry({ tool: "bash", subject: "npm test", outcome: "allow", source: "pre-gate" }));
		appendDecision(
			file,
			decisionEntry({
				tool: "bash",
				subject: "git push --force",
				outcome: "block",
				source: "classifier",
				tier: "soft_deny",
				ruleId: "S1",
				model: "openai/gpt-5-mini",
			}),
		);
		const lines = readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ tool: "bash", outcome: "allow", source: "pre-gate" });
		expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(lines[1]).toMatchObject({ ruleId: "S1", model: "openai/gpt-5-mini" });
	});

	it("clips the subject so a huge command cannot bloat the log", () => {
		const entry = decisionEntry({ tool: "bash", subject: "x".repeat(5000), outcome: "allow", source: "pre-gate" });
		expect(entry.subject.length).toBeLessThan(350);
		expect(entry.subject.endsWith("…")).toBe(true);
	});

	it("swallows write failures rather than breaking the gate", () => {
		// A gate that blocks tool calls because its diary is unwritable has its
		// priorities backwards.
		expect(() =>
			appendDecision(
				join("/nonexistent-root-for-tests", "x.jsonl"),
				decisionEntry({ tool: "bash", subject: "ls", outcome: "allow", source: "pre-gate" }),
			),
		).not.toThrow();
	});
});
