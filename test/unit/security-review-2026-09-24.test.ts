/**
 * Regression tests for AUTO-MODE-SECURITY-REVIEW-2026-09-24: every probe from
 * the review must reach the classifier (or be refused), and the everyday
 * reads the pre-gate exists to fast-path must stay "safe". M1 (the classifier
 * saw a clipped action) is covered in auto-mode-transcript.test.ts and
 * auto-mode-classifier-fallback.test.ts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conflictingPathArguments } from "../../extensions/auto-mode/paths.ts";
import { checkRecoverability } from "../../extensions/auto-mode/recoverability.ts";
import { analyzeShellCommand } from "../../extensions/auto-mode/shell-analysis.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { powershellInjectionSyntax, powershellReadOnly } from "../../extensions/permissions/powershell-rules.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

let root: string;
let cwd: string;
let home: string;
const posixOnly = it.skipIf(process.platform === "win32");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cc-sec-0924-"));
	cwd = join(root, "project");
	home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(cwd, "a.txt"), "a\n");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const analyze = (command: string) => analyzeShellCommand({ command, cwd, home });
const verdict = (command: string) => analyze(command).verdict;

describe("H1: one target per file-tool call", () => {
	it("names the conflict when path fields disagree, and only then", () => {
		expect(conflictingPathArguments({ path: "/outside.txt", file_path: "ordinary.txt" })).toMatch(/`path` and `file_path`/);
		expect(conflictingPathArguments({ path: "a.txt", file_path: "a.txt" })).toBeUndefined();
		expect(conflictingPathArguments({ path: "a.txt" })).toBeUndefined();
		expect(conflictingPathArguments({ file_path: "a.txt", notebook_path: "b.ipynb" })).toMatch(/`file_path` and `notebook_path`/);
	});

	it("blocks a write whose file_path is in-project and whose path is not, in the real auto-mode gate", async () => {
		vi.stubEnv("HOME", home);
		vi.stubEnv("ONECODE_STATE_DIR", join(root, "state"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
		const fake = createFakePi();
		permissionsExtension(fake.pi as never);
		const ctx = createFakeCtx({
			cwd,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(root, "sessions"), getBranch: () => [] },
			hasUI: false,
		});
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "auto" });
		const call = (input: Record<string, unknown>) =>
			fake.fireOne<{ block?: boolean; reason?: string }>("tool_call", { toolName: "write", toolCallId: "t1", input }, ctx);

		const conflicting = await call({ path: join(root, "outside.txt"), file_path: "ordinary.txt", content: "x" });
		expect(conflicting?.block).toBe(true);
		expect(conflicting?.reason).toMatch(/`path` and `file_path`/);
		// The ordinary in-project write still takes the fast path.
		expect(await call({ path: "ordinary.txt", content: "x" })).toBeUndefined();
	});
});

describe("H2: PowerShell grouping expressions run their own command", () => {
	it("is not read-only and is not covered by a wildcard allow rule", () => {
		for (const command of [
			"Write-Output (Set-Content audit-ps.txt nested-write)",
			"Get-Content -Path (Remove-Item x)",
			"Write-Output @(Set-Content f x)",
			"Get-ChildItem;(Set-Content f x)",
		]) {
			expect(powershellReadOnly(command, { cwd, home }).readOnly, command).toBe(false);
			expect(powershellInjectionSyntax(command), command).toMatch(/grouping/);
		}
	});

	it("keeps quoted parentheses literal", () => {
		expect(powershellReadOnly(`Get-ChildItem "Program Files (x86)"`, { cwd, home }).readOnly).toBe(true);
		expect(powershellReadOnly("Select-String -Pattern 'f(x)' -Path a.txt", { cwd, home }).readOnly).toBe(true);
		expect(powershellInjectionSyntax(`Get-ChildItem "Program Files (x86)"`)).toBeUndefined();
	});
});

describe("H3: printf's %n assigns a shell variable", () => {
	it("escalates every %n spelling bash accepts", () => {
		for (const command of ["printf '%n' PATH; ls", "printf %n PATH", "printf '%.0n' PATH", "printf '%ln' PATH", "printf '%s%n' a PATH", "printf -- '%n' PATH", "printf '%%%n' PATH"]) {
			expect(verdict(command), command).toBe("escalate");
		}
	});

	it("keeps ordinary formats safe", () => {
		for (const command of ["printf '%s\\n' hello", "printf '100%%n done\\n'", "printf 'n=%d\\n' 3"]) {
			expect(verdict(command), command).toBe("safe");
		}
	});

	posixOnly("proves the escalation matters: bash runs a project file named 0/ls", () => {
		mkdirSync(join(cwd, "0"));
		writeFileSync(join(cwd, "0", "ls"), `#!/bin/sh\necho ran > '${join(root, "marker")}'\n`, { mode: 0o755 });
		execFileSync("/bin/bash", ["-c", "printf '%n' PATH; ls"], { cwd });
		expect(existsSync(join(root, "marker"))).toBe(true);
	});
});

describe("H4: a glob changes the argument vector the tables judged", () => {
	it("escalates a glob in a command whose operand count decides a write", () => {
		writeFileSync(join(cwd, "sample-a"), "audit\n");
		writeFileSync(join(cwd, "sample-b"), "original fixture\n");
		expect(verdict("uniq sample-*")).toBe("escalate");
		expect(analyze("uniq sample-*").notes.join("\n")).toMatch(/glob sample-\*/);
	});

	it("escalates a glob that matches a filename starting with -", () => {
		writeFileSync(join(cwd, "victim"), "keep\n");
		writeFileSync(join(cwd, "--output=victim"), "");
		for (const command of ["sort *", "cat *", "git diff *", "ls ./*"]) {
			// `./*` expands to `./--output=victim`, which is not an option.
			expect(verdict(command), command).toBe(command === "ls ./*" ? "safe" : "escalate");
		}
	});

	it("escalates a glob where the pattern or program goes", () => {
		for (const command of ["grep *", "jq *", "printf *"]) expect(verdict(command), command).toBe("escalate");
	});

	it("keeps everyday glob reads safe", () => {
		writeFileSync(join(cwd, "b.txt"), "b\n");
		for (const command of ["cat *.txt", "wc -l *.txt", "grep a *.txt", "ls *", "head -n 1 *.txt", "grep --include=*.ts a ."]) {
			expect(verdict(command), command).toBe("safe");
		}
	});
});

describe("H5: jq reads the environment through $ENV", () => {
	it("escalates env, $ENV in every spelling jq accepts, and module loads", () => {
		for (const command of [
			"jq -n '$ENV.AUTOMODE_AUDIT_SENTINEL'",
			"jq -n '$ ENV.X'",
			`jq -n '$ENV["X"]'`,
			"jq -n 'env.X'",
			`jq -n '"\\(env.X)"'`,
			`jq -n 'import "a" as a; 1'`,
			`jq -n 'include "a"; 1'`,
		]) {
			expect(verdict(command), command).toBe("escalate");
		}
	});

	it("keeps ordinary filters safe", () => {
		writeFileSync(join(cwd, "p.json"), '{"name":"x"}\n');
		expect(verdict("jq .name p.json")).toBe("safe");
		expect(verdict("jq -r '.name' p.json")).toBe("safe");
	});
});

/** A committed repository at `cwd` with one tracked file. */
function repo(): void {
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "a.txt"], { cwd });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd });
}

describe("M2: a recoverable reset still runs the checkout's programs", () => {
	it("escalates git reset --hard, uncontained, when the checkout configures a hooks path", () => {
		repo();
		mkdirSync(join(cwd, "hooks"));
		writeFileSync(join(cwd, "hooks", "post-index-change"), "#!/bin/sh\ntouch hook-ran\n", { mode: 0o755 });
		execFileSync("git", ["config", "core.hooksPath", "hooks"], { cwd });
		const evidence = analyze("git reset --hard HEAD");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.containedNonNetwork).toBe(false);
		expect(evidence.notes.join("\n")).toMatch(/hook/);
	});

	it("escalates a reference-transaction hook too, which only a ref update runs", () => {
		repo();
		writeFileSync(join(cwd, ".git", "hooks", "reference-transaction"), "#!/bin/sh\n", { mode: 0o755 });
		expect(analyze("git reset --hard HEAD").containedNonNetwork).toBe(false);
		// A read does not update refs, so the same hook does not stop it.
		expect(verdict("git status")).toBe("safe");
	});

	it("keeps a plain clean reset contained", () => {
		repo();
		const evidence = analyze("git reset --hard HEAD");
		expect(evidence.containedNonNetwork).toBe(true);
		expect(evidence.wholeTree).toBe(true);
	});
});

describe("M3: a clean status does not prove recoverable bytes", () => {
	for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
		it(`calls a ${flag} file with unique bytes unrecoverable, for a delete and a reset`, () => {
			repo();
			writeFileSync(join(cwd, "a.txt"), "uncommitted unique fixture\n");
			execFileSync("git", ["update-index", flag, "a.txt"], { cwd });
			expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })).toBe("");
			expect(checkRecoverability(cwd, { targets: [join(cwd, "a.txt")], wholeTree: false }).verdict).toBe("unrecoverable");
			expect(checkRecoverability(cwd, { targets: [], wholeTree: true }).verdict).toBe("unrecoverable");
		});
	}

	it("still clears a tracked, clean, unflagged file", () => {
		repo();
		expect(checkRecoverability(cwd, { targets: [join(cwd, "a.txt")], wholeTree: false }).verdict).toBe("recoverable");
		expect(checkRecoverability(cwd, { targets: [], wholeTree: true }).verdict).toBe("recoverable");
	});
});

describe("M4: PowerShell resolves relative paths before vouching for them", () => {
	posixOnly("refuses a relative name that is a symlink out of the project", () => {
		mkdirSync(join(root, "outside"));
		writeFileSync(join(root, "outside", "data.txt"), "synthetic-outside-data\n");
		symlinkSync(join(root, "outside", "data.txt"), join(cwd, "notes.txt"));
		mkdirSync(join(cwd, "sub"));
		symlinkSync(join(root, "outside"), join(cwd, "sub", "link"));
		for (const command of ["Get-Content notes.txt", "Get-Content -Path:notes.txt", "Get-Content *.txt", "Get-ChildItem sub\\link", "Get-Content sub/link/data.txt"]) {
			expect(powershellReadOnly(command, { cwd, home }).readOnly, command).toBe(false);
		}
	});

	posixOnly("refuses a relative link to an in-project credential file", () => {
		writeFileSync(join(cwd, ".env"), "TOKEN=x\n");
		symlinkSync(join(cwd, ".env"), join(cwd, "notes.txt"));
		expect(powershellReadOnly("Get-Content notes.txt", { cwd, home })).toEqual({ readOnly: false, reason: "a credential or secret path" });
	});

	it("keeps ordinary in-project reads read-only", () => {
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "b.ts"), "b\n");
		for (const command of ["Get-Content a.txt", "Get-ChildItem src", "Get-Content src\\b.ts", "Get-ChildItem *.txt", "Get-Content missing.txt"]) {
			expect(powershellReadOnly(command, { cwd, home }).readOnly, command).toBe(true);
		}
	});
});
