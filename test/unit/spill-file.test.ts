/**
 * pi's foreground shell spills a long output to os.tmpdir(), outside every
 * readable root. The wrapper moves the file into the session's results dir
 * and rewrites the path, on success, on the error result pi 0.99 returns for a
 * failing command and on the error older pi throws, so reading the full
 * output is a working-space read in every mode.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { keepSpillReadable, piSpillPath, relocateSpillIn } from "../../extensions/lib/spill-file.ts";
import { decide } from "../../extensions/permissions/matcher.ts";
import { createFakeCtx } from "./helpers/fake-pi.ts";

const cwd = mkdtempSync(join(tmpdir(), "spill-cwd-"));
const resultsDir = mkdtempSync(join(tmpdir(), "spill-results-"));
afterAll(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(resultsDir, { recursive: true, force: true });
});

const bash = createBashToolDefinition(cwd);
const run = (command: string) =>
	keepSpillReadable(() => bash.execute("t1", { command }, undefined, undefined, createFakeCtx({ cwd }) as never) as Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>, resultsDir);

describe("keepSpillReadable", () => {
	it("moves a successful run's spill file into the results dir and rewrites the path", async () => {
		const result = await run("seq 1 6000");
		const text = result.content[0].text ?? "";
		const path = /Full output: ([^\]]+)\]/.exec(text)?.[1];
		expect(path?.startsWith(resultsDir)).toBe(true);
		expect(readFileSync(path!, "utf8").split("\n")[0]).toBe("1");
		expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe(path);
		expect(text).not.toContain(tmpdir() + "/pi-bash-");
	});

	it("rewrites the path in the error result pi returns for a failing command", async () => {
		const result = (await run("seq 1 6000; exit 3")) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		const text = result.content[0].text ?? "";
		expect(text).toContain("Command exited with code 3");
		const path = /Full output: ([^\]]+)\]/.exec(text)?.[1];
		expect(path?.startsWith(resultsDir)).toBe(true);
		expect(existsSync(path!)).toBe(true);
	});

	it("rewrites the path in the error pi before 0.99 throws for a failing command", async () => {
		const spill = (await run("seq 1 6000")).content[0].text ?? "";
		// Recreate a spill file in the temp dir, as pi 0.87 names it in the error it throws.
		const piPath = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
		writeFileSync(piPath, spill);
		const failure = await keepSpillReadable(() => Promise.reject(new Error(`out\n\nCommand exited with code 3 [Full output: ${piPath}]`)), resultsDir).catch((error: Error) => error);
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
		const result = await run("seq 1 6000");
		const path = /Full output: ([^\]]+)\]/.exec(result.content[0].text ?? "")![1];
		for (const mode of ["default", "dontAsk"] as const) {
			const decision = decide({ toolName: "read", subject: path, cwd, mode, deny: [], ask: [], allow: [], resultsDirPath: resultsDir });
			expect(decision.decision, mode).toBe("allow");
		}
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
		expect(relocateSpillIn(`[Full output: ${decoy}]`, resultsDir)).toBe(`[Full output: ${decoy}]`);
		expect(existsSync(decoy)).toBe(true);
		rmSync(decoy);
	});
});
