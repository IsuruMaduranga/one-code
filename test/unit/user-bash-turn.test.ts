/**
 * A user's `!` command starts a turn once pi has recorded it
 * (lib/shell-run/user-bash-turn.ts, extensions/tools/bash-turn).
 */
import { describe, expect, it } from "vitest";
import { BASH_TURN_MESSAGE, type RunOutcome, startsTurn, USER_BASH_CHANNEL, type UserBashTurnRequest, withTurnAfterRun } from "../../extensions/lib/shell-run/user-bash-turn.ts";
import bashTurnExtension from "../../extensions/tools/bash-turn/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/** A deferral the test runs by hand, so it can see what happened before it. */
function manualDefer() {
	const queued: Array<() => void> = [];
	return { defer: (run: () => void) => queued.push(run), flush: () => queued.splice(0).forEach((run) => run()), queued };
}

const noData = { onData: () => {} };

describe("withTurnAfterRun", () => {
	it("passes the run's result through and reports it settled only after the deferral", async () => {
		const { defer, flush, queued } = manualDefer();
		const outcomes: RunOutcome[] = [];
		const ops = withTurnAfterRun({ exec: async () => ({ exitCode: 3 }) }, (o) => outcomes.push(o), defer);
		expect(await ops.exec("false", "/", noData)).toEqual({ exitCode: 3 });
		expect(outcomes).toEqual([]);
		expect(queued).toHaveLength(1);
		flush();
		expect(outcomes).toEqual([{ exitCode: 3, failed: false, cancelled: false }]);
	});

	it("reports a run the user cancelled as cancelled, whether the shell resolved or threw", async () => {
		const { defer, flush } = manualDefer();
		const outcomes: RunOutcome[] = [];
		const controller = new AbortController();
		controller.abort();
		const resolved = withTurnAfterRun({ exec: async () => ({ exitCode: null }) }, (o) => outcomes.push(o), defer);
		await resolved.exec("sleep 9", "/", { ...noData, signal: controller.signal });
		const thrown = withTurnAfterRun({ exec: async () => Promise.reject(new Error("aborted")) }, (o) => outcomes.push(o), defer);
		await expect(thrown.exec("sleep 9", "/", { ...noData, signal: controller.signal })).rejects.toThrow("aborted");
		flush();
		expect(outcomes.map((o) => [o.cancelled, o.failed])).toEqual([
			[true, false],
			[true, false],
		]);
	});

	it("reports a shell that could not run the command as failed and rethrows its error", async () => {
		const { defer, flush } = manualDefer();
		const outcomes: RunOutcome[] = [];
		const ops = withTurnAfterRun({ exec: async () => Promise.reject(new Error("no shell")) }, (o) => outcomes.push(o), defer);
		await expect(ops.exec("ls", "/", noData)).rejects.toThrow("no shell");
		flush();
		expect(outcomes).toEqual([{ exitCode: undefined, failed: true, cancelled: false }]);
	});

	it("defers past pi's recording by default (a macrotask, after the awaiting code's microtasks)", async () => {
		const order: string[] = [];
		const ops = withTurnAfterRun({ exec: async () => ({ exitCode: 0 }) }, () => order.push("settled"));
		await ops.exec("pwd", "/", noData).then(() => Promise.resolve().then(() => order.push("recorded")));
		await new Promise((resolve) => setImmediate(resolve));
		expect(order).toEqual(["recorded", "settled"]);
	});
});

describe("startsTurn", () => {
	const ok: RunOutcome = { exitCode: 0, cancelled: false, failed: false };
	it("starts a turn after a finished run, a non-zero exit included, in the idle session that ran it", () => {
		expect(startsTurn(ok, { idle: true, current: true })).toBe(true);
		expect(startsTurn({ ...ok, exitCode: 3 }, { idle: true, current: true })).toBe(true);
	});
	it("starts none after a cancel or a failed run, while busy, or in another session", () => {
		expect(startsTurn({ ...ok, cancelled: true }, { idle: true, current: true })).toBe(false);
		expect(startsTurn({ ...ok, failed: true }, { idle: true, current: true })).toBe(false);
		expect(startsTurn(ok, { idle: false, current: true })).toBe(false);
		expect(startsTurn(ok, { idle: true, current: false })).toBe(false);
	});
});

describe("bash-turn extension", () => {
	async function setup(idle: () => boolean = () => true) {
		const fake = createFakePi();
		bashTurnExtension(fake.pi as never);
		await fake.fire("session_start", {}, createFakeCtx({ isIdle: idle }));
		const ask = (excludeFromContext = false) => {
			const request: UserBashTurnRequest = { command: "pwd", excludeFromContext };
			fake.events.emit(USER_BASH_CHANNEL, request);
			return request;
		};
		return { fake, ask };
	}
	const ok: RunOutcome = { exitCode: 0, cancelled: false, failed: false };

	it("starts a turn with an empty, hidden message once an idle `!` run settles", async () => {
		const { fake, ask } = await setup();
		ask().onSettled?.(ok);
		expect(fake.sentMessages).toEqual([{ message: { customType: BASH_TURN_MESSAGE, content: [], display: false }, options: { triggerTurn: true } }]);
	});

	it("asks for nothing for a `!!` run or while the model is working", async () => {
		expect((await setup()).ask(true).onSettled).toBeUndefined();
		expect((await setup(() => false)).ask().onSettled).toBeUndefined();
	});

	it("starts nothing when the session became busy, after a cancel, or once the session ended", async () => {
		let idle = true;
		const { fake, ask } = await setup(() => idle);
		const busy = ask();
		idle = false;
		busy.onSettled?.(ok);
		idle = true;
		ask().onSettled?.({ ...ok, cancelled: true });
		const ended = ask();
		await fake.fire("session_shutdown", {});
		ended.onSettled?.(ok);
		expect(fake.sentMessages).toEqual([]);
	});

	it("starts nothing for a run that settles in a session started after it", async () => {
		const { fake, ask } = await setup();
		const earlier = ask();
		await fake.fire("session_start", {}, createFakeCtx({ isIdle: () => true }));
		earlier.onSettled?.(ok);
		expect(fake.sentMessages).toEqual([]);
	});
});
