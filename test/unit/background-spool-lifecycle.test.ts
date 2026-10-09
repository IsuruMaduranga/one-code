import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const spool = vi.hoisted(() => ({ reached: () => {}, release: () => {} }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs, createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
		const stream = fs.createWriteStream(...args);
		const end = stream.end;
		stream.end = ((...endArgs: unknown[]) => {
			spool.release = () => {
				spool.release = () => {};
				Reflect.apply(end, stream, endArgs);
			};
			spool.reached();
			return stream;
		}) as typeof stream.end;
		return stream;
	} };
});
import backgroundExtension from "../../extensions/background/index.ts";
import bashExtension from "../../extensions/bash/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

describe("background spool completion", () => {
	it.each(["bash", "monitor"])("%s does not report finalized output before its spool flushes", async (name) => {
		const dir = mkdtempSync(join(tmpdir(), "spool-finish-"));
		const fake = createFakePi();
		backgroundExtension(fake.pi as never);
		bashExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: dir, mode: "rpc", sessionManager: { getSessionDir: () => dir } });
		const draining = new Promise<void>((resolve) => { spool.reached = resolve; });
		let output: Promise<unknown> | undefined;
		try {
			const start = await fake.tools.get(name)!.execute("start", { command: "echo final-output", description: "slow spool", run_in_background: true }, undefined, undefined, ctx) as { details: { taskId: string } };
			await draining;
			let returned = false;
			output = fake.tools.get("task_output")!.execute("output", { task_id: start.details.taskId, timeout: 5000 }, undefined, undefined, ctx).then((result) => { returned = true; return result; });
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(returned).toBe(false);
			spool.release();
			const result = await output as { details: { status: string }; content: Array<{ text: string }> };
			expect(result.details.status).toBe("completed");
			expect(result.content[0].text).toContain("final-output");
		} finally {
			spool.release();
			await output;
			await fake.fire("session_shutdown", { reason: "quit" }, ctx);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
