import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import bashExtension from "../../extensions/bash/index.ts";
import { startBackgroundBash } from "../../extensions/bash/background.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

describe("background shell output survives the memory cap and spool failure", () => {
	const dirs: string[] = [];
	afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
	const directory = () => { const dir = mkdtempSync(join(tmpdir(), "shell-output-")); dirs.push(dir); return dir; };

	it.each([false, true])("a one-shot shell persists its entire output (session-less: %s)", async (sessionless) => {
		const dir = directory();
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		const result = await fake.tools.get("bash")!.execute("large", {
			command: "printf 'BEGIN\\n'; for ((i=0; i<12000; i++)); do printf 'line-%s-padding-padding\\n' \"$i\"; done; printf 'END\\n'",
			run_in_background: true,
		}, undefined, undefined, createFakeCtx({ cwd: dir, mode: "print", sessionManager: { getSessionDir: () => sessionless ? undefined : dir, getSessionId: () => `large-shell-${process.pid}` } })) as { content: Array<{ text: string }> };
		const text = result.content[0].text;
		const file = text.match(/Full output saved to: (.+)/)?.[1];
		expect(file).toBeDefined();
		const saved = readFileSync(file!, "utf8");
		expect(saved.startsWith("BEGIN\n")).toBe(true);
		expect(saved.endsWith("END\n")).toBe(true);
		expect(saved).not.toContain("earlier output truncated");
	});

	it("reports timeout as an error even when a TERM handler exits zero", async () => {
		const dir = directory();
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		const result = await fake.tools.get("bash")!.execute("timeout", {
			command: "trap 'exit 0' TERM; while :; do sleep 0.05; done",
			run_in_background: true,
			timeout: 200,
		}, undefined, undefined, createFakeCtx({ cwd: dir, mode: "print", sessionManager: { getSessionDir: () => dir } })) as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.content[0].text).toContain("failed (timed out after 0.2s)");
		expect(result.isError).toBe(true);
	});

	it("does not advertise a failed spool as the full output", async () => {
		const dir = directory();
		const task = startBackgroundBash({ id: "spool-fail", command: "printf 'kept output'", description: "failed spool", cwd: dir, logPath: join(dir, "missing", "output.log"), onFinished() {} });
		await task.finished;
		expect(task.output()).toBe("kept output");
		expect(task.logPath).toBeUndefined();
	});
});
