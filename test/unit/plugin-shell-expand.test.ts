/**
 * Plugin command `!` placeholders: found before arguments go in, arguments
 * quoted into the command, and run in the harness's bash rather than Node's
 * `shell: true` (`/bin/sh` or `cmd.exe`).
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expandTemplate, runPlaceholderCommand } from "../../extensions/plugins/shell-expand.ts";

const cwd = mkdtempSync(join(tmpdir(), "plugin-expand-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe("expandTemplate", () => {
	it("never runs a placeholder that arrived inside an argument", async () => {
		const ran: string[] = [];
		const run = async (command: string) => {
			ran.push(command);
			return "out";
		};
		const text = await expandTemplate("Review $ARGUMENTS\n\n!`git log -1`", "this !`touch pwned` please", cwd, { run });
		expect(ran).toEqual(["git log -1"]);
		expect(text).toBe("Review this !`touch pwned` please\n\nout");
	});

	it("quotes an argument that lands inside a command, so it stays one word of text", async () => {
		const marker = join(cwd, "injected");
		const text = await expandTemplate("!`echo $ARGUMENTS`", `"$(touch ${marker})";x`, cwd);
		expect(existsSync(marker)).toBe(false);
		expect(text).toBe(`"$(touch ${marker})";x`);
	});

	it("does not read placeholders or arguments out of a command's output", async () => {
		const text = await expandTemplate("!`make-output`", "arg", cwd, { run: async () => "$1 !`id`" });
		expect(text).toBe("$1 !`id`");
	});
});

describe("runPlaceholderCommand", () => {
	it("runs in bash, so bash syntax works where /bin/sh would fail", async () => {
		if (process.platform === "win32") return;
		expect(await runPlaceholderCommand("[[ -n x ]] && cat <(echo from-bash)", cwd)).toBe("from-bash");
		expect(await runPlaceholderCommand("echo $BASH_VERSION | cut -c1", cwd)).toMatch(/^\d$/);
	});

	it("returns the error text for a failing command and stops at the timeout", async () => {
		if (process.platform === "win32") return;
		expect(await runPlaceholderCommand("echo oops >&2; exit 3", cwd)).toBe("oops");
		expect(await runPlaceholderCommand("sleep 5", cwd, { timeoutMs: 200 })).toContain("timed out");
	});
});
