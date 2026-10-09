import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import askUserExtension from "../../extensions/ask-user/index.ts";
import { askThroughDialogs, TYPE_OWN } from "../../extensions/ask-user/dialogs.ts";
import { selectPlanChoice } from "../../extensions/plan-mode/viewer.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/permissions/modes.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

function rpcDialog(options?: { signal?: AbortSignal }): Promise<undefined> {
	return new Promise((resolve) => {
		if (options?.signal?.aborted) resolve(undefined);
		else options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
	});
}

function bounded<T>(work: Promise<T>): Promise<T | "hung"> {
	return Promise.race([work, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100))]);
}

describe("RPC tool dialog cancellation", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "rpc-dialog-"));
		vi.stubEnv("ONECODE_STATE_DIR", join(root, "state"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	for (const abortAt of ["select", "input"] as const) {
		it(`aborting ask_user_question's ${abortAt} returns cancellation`, async () => {
			const fake = createFakePi();
			askUserExtension(fake.pi as never);
			const abort = new AbortController();
			let opened!: () => void;
			const shown = new Promise<void>((resolve) => { opened = resolve; });
			const ctx = createFakeCtx({
				cwd: root, mode: "rpc", hasUI: true, signal: abort.signal,
				ui: {
					select: (_title: string, _rows: string[], options?: { signal?: AbortSignal }) => {
						if (abortAt === "input") return Promise.resolve(TYPE_OWN);
						opened(); return rpcDialog(options);
					},
					input: (_title: string, _placeholder: string, options?: { signal?: AbortSignal }) => {
						opened(); return rpcDialog(options);
					},
				},
			});
			const result = fake.tools.get("ask_user_question")!.execute("question", { questions: [{ question: "Which?", header: "Q", options: [{ label: "A" }, { label: "B" }] }] }, abort.signal, undefined, ctx);
			await shown;
			abort.abort();
			expect(await bounded(result)).toMatchObject({ details: { cancelled: true } });
		});
	}

	it("a plan approval racing with abort is dismissed", async () => {
		const abort = new AbortController();
		const ui = { select: async (_title: string, choices: string[]) => { abort.abort(); return choices[0]; } };
		expect(await selectPlanChoice(ui, "plan", "plan.md", ["Approve", "Keep planning"], abort.signal)).toBeNull();
	});

	for (const at of ["select", "input"] as const) {
		it(`an ask_user_question ${at} answer racing with abort is not submitted`, async () => {
			const abort = new AbortController();
			const ui = {
				select: async (_title: string, choices: string[]) => {
					if (at === "input") return TYPE_OWN;
					abort.abort(); return choices[0];
				},
				input: async () => { abort.abort(); return "custom answer"; },
			};
			expect(await askThroughDialogs([{ question: "Which?", header: "Q", options: [{ label: "A" }, { label: "B" }] }], ui, abort.signal)).toEqual({ kind: "cancel", answers: [] });
		});
	}

	it("aborting exit_plan_mode dismisses approval and never changes permission mode", async () => {
		const fake = createFakePi();
		planModeExtension(fake.pi as never);
		const abort = new AbortController();
		let opened!: () => void;
		const shown = new Promise<void>((resolve) => { opened = resolve; });
		const ctx = createFakeCtx({
			cwd: root, mode: "rpc", hasUI: true, signal: abort.signal,
			modelRegistry: { getAvailable: () => [] },
			ui: { select: (_title: string, _rows: string[], options?: { signal?: AbortSignal }) => { opened(); return rpcDialog(options); } },
		});
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const entered = await fake.tools.get("enter_plan_mode")!.execute("enter", {}, undefined, undefined, ctx) as { details: { planFilePath: string } };
		mkdirSync(dirname(entered.details.planFilePath), { recursive: true });
		writeFileSync(entered.details.planFilePath, "# Plan\n\n1. Test it.\n");
		const modeChanges: unknown[] = [];
		fake.events.on(MODE_CHANNEL, (data) => modeChanges.push(data));
		const result = fake.tools.get("exit_plan_mode")!.execute("exit", {}, abort.signal, undefined, ctx);
		await shown;
		abort.abort();
		expect(await bounded(result)).toMatchObject({ isError: true, details: { approved: false } });
		expect(modeChanges).toEqual([]);
	});
});
