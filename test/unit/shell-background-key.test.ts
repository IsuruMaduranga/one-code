import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import backgroundExtension from "../../extensions/tools/background/index.ts";
import bashExtension from "../../extensions/tools/bash/index.ts";
import { taskOutputPath } from "../../extensions/lib/request/persisted-output.ts";
import { shellResultText } from "../../extensions/lib/shell-run/shell-text.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

type Result = { content: Array<{ text: string }>; details: { taskId?: string; logPath?: string }; isError?: boolean };
const CTRL_B = "\x02";

// The fixtures are bash loops; Windows runs this path in the live checks.
describe.skipIf(process.platform === "win32")("the key that sends a running command to the background", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "background-key-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	async function mount(mode = "tui") {
		const fake = createFakePi();
		backgroundExtension(fake.pi as never);
		bashExtension(fake.pi as never);
		let key: (data: string) => { consume?: boolean } | undefined = () => undefined;
		const ctx = createFakeCtx({
			cwd: dir, mode, hasUI: true,
			sessionManager: { getSessionDir: () => dir },
			ui: { onTerminalInput: (handler: typeof key) => { key = handler; return () => {}; } },
		});
		await fake.fire("session_start", {}, ctx);
		/** Run `command`, resolving `printed` once its first output reached the transcript. */
		const run = (command: string) => {
			let seen!: () => void;
			const printed = new Promise<void>((resolve) => { seen = resolve; });
			const result = fake.tools.get("bash")!.execute("call-1", { command, description: "Count" }, undefined, (update: { content: Array<{ text?: string }> }) => {
				if (update.content[0]?.text) seen();
			}, ctx) as Promise<Result>;
			return { printed, result };
		};
		const notifications = () => fake.sentMessages.map((sent) => JSON.stringify(sent.message.content)).join("\n");
		return { fake, ctx, key: (data: string) => key(data), run, notifications };
	}

	const settled = async (check: () => boolean) => {
		for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
		expect(check()).toBe(true);
	};

	it("returns at once with Claude Code's text, keeps the command running, and notifies when it exits", async () => {
		const h = await mount();
		const { printed, result } = h.run("echo before; sleep 1; echo after");
		await printed;
		expect(h.key(CTRL_B)).toEqual({ consume: true });
		const reply = await result;
		const { taskId, logPath } = reply.details;
		expect(taskId).toMatch(/^b[0-9a-z]{8}$/);
		expect(reply.content[0].text).toBe(shellResultText().manuallyBackgrounded({ id: taskId!, logPath }));
		expect(reply.content[0].text).toBe(`Command was manually backgrounded by user with ID: ${taskId}. Output is being written to: ${logPath}.`);
		expect(reply.isError).toBeUndefined();
		await settled(() => readFileSync(logPath!, "utf8").startsWith("before\n"));
		// No notification while the command still runs (a slow runner may reach here after it ended).
		if (readFileSync(logPath!, "utf8") === "before\n") expect(h.notifications()).toBe("");
		await settled(() => h.notifications().includes("<status>completed</status>"));
		expect(h.notifications()).toContain(`<task-id>${taskId}</task-id>`);
		expect(h.notifications()).toContain("<tool-use-id>call-1</tool-use-id>");
		expect(h.notifications()).toContain('Background command \\"Count\\" completed (exit code 0)');
		expect(readFileSync(logPath!, "utf8")).toBe("before\nafter\n");
		await h.fake.fire("session_shutdown", { reason: "quit" }, h.ctx);
	});

	it("leaves the key to the editor when no command runs", async () => {
		const h = await mount();
		expect(h.key(CTRL_B)).toBeUndefined();
		const reply = await h.run("echo done").result;
		expect(reply.content[0].text).toBe("done");
		expect(reply.details?.taskId).toBeUndefined();
		expect(h.key(CTRL_B)).toBeUndefined();
	});

	it("leaves no output file behind a command that ends in the foreground", async () => {
		const h = await mount();
		const { printed, result } = h.run("echo before; sleep 1.5; echo after");
		await printed;
		// The file is there while the command runs, as in Claude Code.
		const tasks = dirname(taskOutputPath(h.ctx as never, "probe")!);
		// The stream writes behind the transcript update, so wait for the bytes.
		const holds = (file: string) => {
			try {
				return readFileSync(join(tasks, file), "utf8") === "before\n";
			} catch {
				return false; // gone between the listing and the read
			}
		};
		await settled(() => readdirSync(tasks).some(holds));
		expect((await result).content[0].text).toBe("before\nafter");
		expect(readdirSync(tasks)).toEqual([]);
	});

	it("stops a backgrounded command at the session's end", async () => {
		const h = await mount();
		const { printed, result } = h.run("echo before; sleep 30; echo after");
		await printed;
		h.key(CTRL_B);
		const { logPath } = (await result).details;
		await h.fake.fire("session_shutdown", { reason: "quit" }, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(readFileSync(logPath!, "utf8")).toBe("before\n");
	});

	it("still stops a foreground command on the call's abort, through pi's own tool", async () => {
		const h = await mount();
		const abort = new AbortController();
		const result = h.fake.tools.get("bash")!.execute("call-2", { command: "echo before; sleep 30; echo after" }, abort.signal, undefined, h.ctx) as Promise<Result>;
		setTimeout(() => abort.abort(), 300);
		await expect(result).rejects.toThrow(/before[\s\S]*Command aborted/);
	});

	it("takes no key in a one-shot run, which has nowhere to deliver a completion", async () => {
		const h = await mount("print");
		const { printed, result } = h.run("echo before; sleep 0.3; echo after");
		await printed;
		expect(h.key(CTRL_B)).toBeUndefined();
		expect((await result).content[0].text).toBe("before\nafter");
	});
});
