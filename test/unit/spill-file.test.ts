/**
 * pi's foreground shell spills a long output to os.tmpdir(), outside every
 * readable root. The wrapper moves the file into the session's results dir
 * and rewrites the path, on success, on the error result pi 0.99 returns for a
 * failing command and on the error older pi throws, so reading the full
 * output is a working-space read in every mode.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { boundSpillIn, keepSpillReadable, piSpillPath } from "../../extensions/lib/spill-file.ts";
import { requireText } from "../../extensions/lib/profile.ts";
import { decide } from "../../extensions/lib/rules/matcher.ts";
import { createFakeCtx } from "./helpers/fake-pi.ts";

const cwd = mkdtempSync(join(tmpdir(), "spill-cwd-"));
const resultsDir = mkdtempSync(join(tmpdir(), "spill-results-"));
afterAll(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(resultsDir, { recursive: true, force: true });
});

const bash = createBashToolDefinition(cwd);
const cap = 30_000;
const bound = { inlineMax: cap, id: "bash-t1" };
const run = (command: string) =>
	keepSpillReadable(() => bash.execute("t1", { command }, undefined, undefined, createFakeCtx({ cwd }) as never) as Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>, resultsDir, bound);
/** A saved output's size as the persisted block gives it. */
const shownSize = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`);
/** The profile's line naming a saved output, as the base writes it for `file`. */
const persistedLine = (file: string) => requireText("toolResults").persisted({ size: shownSize(statSync(file).size), file });
/** The file in the results dir a persisted block names, by the profile's line for it. */
const savedPath = (text: string) =>
	(readdirSync(resultsDir, { recursive: true }) as string[])
		.map((name) => join(resultsDir, name))
		.find((file) => statSync(file).isFile() && text.includes(persistedLine(file)));
/** The profile's heading over a 2 KB preview, with the line break the block puts after it. */
const previewHeading = () => `${requireText("toolResults").previewHeading({ kb: 2 })}\n`;

describe("keepSpillReadable", () => {
	it("moves a successful run's spill file into the results dir and rewrites the path", async () => {
		const result = await run("seq 1 20000");
		const text = result.content[0].text ?? "";
		const path = savedPath(text);
		expect(path?.startsWith(resultsDir)).toBe(true);
		expect(readFileSync(path!, "utf8").split("\n")[0]).toBe("1");
		expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe(path);
		expect(text).not.toContain(tmpdir() + "/pi-bash-");
	});

	it("rewrites the path in the error result pi returns for a failing command", async () => {
		const result = (await run("seq 1 20000; exit 3")) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		const text = result.content[0].text ?? "";
		expect(text).toContain("Command exited with code 3");
		const path = savedPath(text);
		expect(path?.startsWith(resultsDir)).toBe(true);
		expect(existsSync(path!)).toBe(true);
	});

	it("rewrites the path in the error pi before 0.99 throws for a failing command", async () => {
		const spill = (await run("seq 1 6000")).content[0].text ?? "";
		// Recreate a spill file in the temp dir, as pi 0.87 names it in the error it throws.
		const piPath = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
		writeFileSync(piPath, spill);
		const failure = await keepSpillReadable(() => Promise.reject(new Error(`out\n\nCommand exited with code 3 [Full output: ${piPath}]`)), resultsDir, bound).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		const path = /Full output: ([^\]]+)\]/.exec((failure as Error).message)?.[1];
		expect(path?.startsWith(resultsDir)).toBe(true);
		expect(existsSync(path!)).toBe(true);
		expect(existsSync(piPath)).toBe(false);
	});

	it("leaves a short output alone", async () => {
		const result = await run("echo hi");
		expect(result.content[0].text).toBe("hi\n");
	});

	it("makes the full output a working-space read in default and dontAsk mode", async () => {
		const result = await run("seq 1 20000");
		const path = savedPath(result.content[0].text ?? "")!;
		for (const mode of ["default", "dontAsk"] as const) {
			const decision = decide({ toolName: "read", subject: path, cwd, mode, deny: [], ask: [], allow: [], resultsDirPath: resultsDir });
			expect(decision.decision, mode).toBe("allow");
		}
	});
});

// Claude Code keeps a shell output's head: whole up to 30,000, past it a
// persisted block whose preview is the first 2 KB. pi keeps the last 2,000
// lines or 50 KB, which lost a batched command's first outputs.
describe("keepSpillReadable with Claude Code's cut", () => {
	const cut = run;

	it("returns a long output that fits the cap whole, with no truncation note", async () => {
		// 6,000 lines, 28,893 bytes: over pi's 2,000 lines, under the cap.
		const text = (await cut("seq 1 6000")).content[0].text ?? "";
		const lines = text.trimEnd().split("\n");
		expect(lines[0]).toBe("1");
		expect(lines.at(-1)).toBe("6000");
		expect(text).not.toContain("[Showing");
	});

	it("persists an output past the cap with its head as the preview", async () => {
		const text = (await cut("seq 1 20000")).content[0].text ?? "";
		const path = savedPath(text);
		expect(text.startsWith(`<persisted-output>\n${persistedLine(path!)}\n`)).toBe(true);
		expect(text).toContain(`${previewHeading()}1\n2\n3\n`);
		expect(path?.startsWith(resultsDir)).toBe(true);
		const saved = readFileSync(path!, "utf8").trimEnd().split("\n");
		expect([saved[0], saved.at(-1)]).toEqual(["1", "20000"]);
		expect(text).not.toContain("[Showing");
	});

	it("keeps pi's exit status after the persisted block", async () => {
		const result = (await cut("seq 1 20000; exit 3")) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
		const text = result.content[0].text ?? "";
		expect(result.isError).toBe(true);
		expect(text.startsWith("<persisted-output>")).toBe(true);
		expect(text.endsWith("</persisted-output>\n\nCommand exited with code 3")).toBe(true);
	});

	it("keeps a successful command's status-shaped last line in the saved output", async () => {
		const text = (await cut("for i in $(seq 1 1000); do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done; printf '\\nCommand exited with code 3'")).content[0].text ?? "";
		expect(text.endsWith("</persisted-output>")).toBe(true);
		expect(readFileSync(savedPath(text)!, "utf8").endsWith("Command exited with code 3")).toBe(true);
	});

	it("persists an output pi did not spill once it passes the cap", async () => {
		// 1,000 lines of 44 bytes: under pi's limits, over the cap.
		const text = (await cut("for i in $(seq 1 1000); do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done")).content[0].text ?? "";
		const file = join(resultsDir, "tool-results", "bash-t1.txt");
		expect(text.startsWith(`<persisted-output>\n${requireText("toolResults").persisted({ size: "43.0KB", file })}\n`)).toBe(true);
	});

	it("bounds the output in the error pi throws on a timeout", async () => {
		const failure = await keepSpillReadable(
			() => bash.execute("t3", { command: "seq 1 20000; sleep 5", timeout: 1 }, undefined, undefined, createFakeCtx({ cwd }) as never) as Promise<{ content: Array<{ type: string; text?: string }> }>,
			resultsDir,
			bound,
		).catch((error: Error) => error);
		const message = (failure as Error).message;
		expect(message.startsWith("<persisted-output>")).toBe(true);
		expect(message).toContain(`${previewHeading()}1\n2\n`);
		expect(message.endsWith("\n\nCommand timed out after 1 seconds")).toBe(true);
	});

});

describe("piSpillPath", () => {
	it("accepts only a pi-named file directly in the temp dir", () => {
		const tmp = "/tmp/t";
		expect(piSpillPath("x\n\n[Showing lines 1-2 of 9. Full output: /tmp/t/pi-bash-0123456789abcdef.log]", tmp)).toBe("/tmp/t/pi-bash-0123456789abcdef.log");
		expect(piSpillPath("[Showing lines 1-2 of 9. Full output: /etc/passwd]", tmp)).toBeUndefined();
		expect(piSpillPath("[Full output: /tmp/t/sub/pi-bash-0123456789abcdef.log]", tmp)).toBeUndefined();
		expect(piSpillPath("[Full output: /tmp/t/pi-bash-short.log]", tmp)).toBeUndefined();
		expect(piSpillPath("no marker", tmp)).toBeUndefined();
	});

	it("does not move a file a command merely names", () => {
		const decoy = join(tmpdir(), "decoy.log");
		writeFileSync(decoy, "x");
		expect(boundSpillIn(`[Full output: ${decoy}]`, resultsDir, bound)).toBe(`[Full output: ${decoy}]`);
		expect(existsSync(decoy)).toBe(true);
		rmSync(decoy);
	});
});
