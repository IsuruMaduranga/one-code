/**
 * The PowerShell pre-gate's tree verdicts (permissions/powershell-tree.ts)
 * against PowerShell's own parse: Claude Code's acceptEdits cmdlets as the
 * contained-edit fast path, the tier and mode it is offered in through
 * decide(), and the read-only verdict's binding and script-block checks.
 * decisions/windows.md "The PowerShell pre-gate reads PowerShell's own parse".
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveForContainment } from "../../extensions/auto-mode/paths.ts";
import { decide } from "../../extensions/permissions/matcher.ts";
import { applicationArgument } from "../../extensions/permissions/powershell-cmdlets.ts";
import { powershellTreeContainedEdits, powershellTreeReadOnly } from "../../extensions/permissions/powershell-tree.ts";
import { HAVE_POWERSHELL, psParse } from "./helpers/powershell-parse.ts";

const root = resolveForContainment(mkdtempSync(join(tmpdir(), "ps-tree-"))) as string;
const cwd = join(root, "project");
const outside = join(root, "outside");
const home = join(root, "home");
for (const dir of [join(cwd, "src"), join(cwd, ".git"), join(cwd, "vendor", "lib", ".git"), join(cwd, ".claude"), join(cwd, ".github", "workflows"), outside, home]) {
	mkdirSync(dir, { recursive: true });
}
writeFileSync(join(cwd, "src", "a.txt"), "a\n");
writeFileSync(join(cwd, "notes.txt"), "n\n");
writeFileSync(join(cwd, ".claude", "settings.json"), "{}\n"); // removing .claude takes a protected file with it
writeFileSync(join(outside, "secret.txt"), "s\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const opts = { cwd, home };
const edits = async (command: string) => powershellTreeContainedEdits(await psParse(command), opts);
const reads = async (command: string) => powershellTreeReadOnly(await psParse(command), opts);

describe.skipIf(!HAVE_POWERSHELL)("contained edits: Claude Code's acceptEdits cmdlets on the working space", () => {
	it("clears Set-Content, Add-Content, Remove-Item and Clear-Content inside the working directory", async () => {
		for (const command of [
			"Set-Content -Path src/b.txt -Value hello",
			"Set-Content src/b.txt 'two words'",
			"Add-Content notes.txt more",
			"Remove-Item src/a.txt",
			"Remove-Item -Recurse -Force src",
			"Clear-Content notes.txt",
			"Set-Content src/b.txt x; Remove-Item notes.txt",
			"Set-Content src/b.txt x | Out-Null",
			"Remove-Item -LiteralPath src/a.txt -ErrorAction SilentlyContinue",
		]) {
			expect(await edits(command), command).toEqual({ ok: true });
		}
	});

	it("refuses every other cmdlet, however contained: New-Item, Copy-Item, Move-Item stay with the classifier", async () => {
		for (const command of ["New-Item src/c.txt", "Copy-Item src/a.txt src/b.txt", "Move-Item src/a.txt src/b.txt", "Rename-Item src/a.txt b.txt", "Out-File src/b.txt", "Get-Content src/a.txt"]) {
			expect((await edits(command)).ok, command).toBe(false);
		}
	});

	it("refuses a write outside the working space, through a link, or by shape", async () => {
		symlinkSync(outside, join(cwd, "link"));
		for (const command of [
			`Set-Content '${join(outside, "x.txt")}' y`,
			"Set-Content link/x.txt y",
			"Remove-Item link/secret.txt",
			"Set-Content ../x.txt y",
			"Set-Content ~/x.txt y",
			"Set-Content Env:\\PATH y",
			"Remove-Item \\\\server\\share\\x",
			"Set-Content FileSystem::/tmp/x y",
		]) {
			expect((await edits(command)).ok, command).toBe(false);
		}
	});

	it("refuses a recursive removal or listing over a tree with a link in it (Windows PowerShell 5.1 follows it)", async () => {
		mkdirSync(join(cwd, "build", "deep"), { recursive: true });
		expect(await edits("Remove-Item -Recurse build")).toEqual({ ok: true });
		expect(await reads("Get-ChildItem -Recurse build")).toEqual({ ok: true });
		symlinkSync(outside, join(cwd, "build", "deep", "out"));
		expect(await edits("Remove-Item -Recurse build")).toMatchObject({ ok: false, reason: expect.stringMatching(/link/) });
		expect(await reads("Get-ChildItem -Recurse build")).toMatchObject({ ok: false, reason: expect.stringMatching(/link/) });
		expect(await reads("Get-ChildItem -Depth 2 build")).toMatchObject({ ok: false });
		expect(await reads("Get-ChildItem build")).toEqual({ ok: true }); // one level: each entry is judged where it resolves elsewhere
	});

	it("refuses a wildcard target, which it does not enumerate", async () => {
		expect(await edits("Remove-Item src/*.txt")).toMatchObject({ ok: false, reason: expect.stringMatching(/wildcard/) });
		expect((await edits("Remove-Item -Path src/[ab].txt")).ok).toBe(false);
	});

	it("refuses removing a working root, a .git, a directory holding one, or a guarded path", async () => {
		for (const command of ["Remove-Item -Recurse .", "Remove-Item -Recurse .git", "Remove-Item -Recurse vendor", "Remove-Item -Recurse .claude", "Remove-Item .github/workflows"]) {
			expect(await edits(command), command).toMatchObject({ ok: false });
		}
	});

	it("refuses a credential, execution-primitive or protected target", async () => {
		for (const command of ["Set-Content .env TOKEN=x", "Set-Content .github/workflows/ci.yml x", "Set-Content .claude/settings.json '{}'", "Set-Content .git/config x"]) {
			expect(await edits(command), command).toMatchObject({ ok: false });
		}
	});

	it("refuses values computed at run time, redirections, script blocks and piped input", async () => {
		for (const command of [
			"Set-Content src/b.txt $env:SECRET",
			"Set-Content src/b.txt (Get-Content ../outside/secret.txt)",
			"Set-Content src/b.txt \"$(whoami)\"",
			"Remove-Item $path",
			"Set-Content src/b.txt x > ../y.txt",
			"Get-ChildItem | Remove-Item",
			"Remove-Item src/a.txt | Remove-Item notes.txt",
			"Remove-Item",
			"Remove-Item -Credential x src/a.txt",
		]) {
			expect((await edits(command)).ok, command).toBe(false);
		}
	});
});

describe.skipIf(!HAVE_POWERSHELL)("contained edits through decide(): capable tiers in acceptEdits and auto only", () => {
	const base = { toolName: "powershell", cwd, deny: [], ask: [], allow: [] };
	const at = async (subject: string, mode: "default" | "acceptEdits" | "auto" | "plan", claudeCodeFastPaths: boolean) =>
		decide({ ...base, subject, mode, claudeCodeFastPaths, powershellParse: await psParse(subject) });

	it("allows a contained edit for a frontier or workhorse model in acceptEdits and auto mode", async () => {
		for (const mode of ["acceptEdits", "auto"] as const) {
			expect(await at("Remove-Item src/a.txt", mode, true), mode).toMatchObject({ decision: "allow", cause: "mode" });
		}
	});

	it("keeps it off for cheap and tiny models, in default and plan mode, and without a parse", async () => {
		expect((await at("Remove-Item src/a.txt", "auto", false)).decision).toBe("classify");
		expect((await at("Remove-Item src/a.txt", "acceptEdits", false)).decision).toBe("ask");
		expect((await at("Remove-Item src/a.txt", "default", true)).decision).toBe("ask");
		expect((await at("Remove-Item src/a.txt", "plan", true)).decision).toBe("deny");
		expect(decide({ ...base, subject: "Remove-Item src/a.txt", mode: "auto", claudeCodeFastPaths: true }).decision).toBe("classify");
	});

	it("a deny rule still wins", async () => {
		const subject = "Remove-Item src/a.txt";
		const denied = decide({ ...base, subject, mode: "auto", claudeCodeFastPaths: true, deny: [{ tool: "powershell", pattern: "Remove-Item:*" }] as never, powershellParse: await psParse(subject) });
		expect(denied.decision).toBe("deny");
	});

	it("an edit into a workspace directory is contained", async () => {
		const extra = join(root, "extra");
		mkdirSync(extra, { recursive: true });
		const subject = `Set-Content '${join(extra, "x.txt")}' y`;
		const result = decide({ ...base, subject, mode: "auto", claudeCodeFastPaths: true, workspaceDirs: [extra], powershellParse: await psParse(subject) });
		expect(result).toMatchObject({ decision: "allow", cause: "mode" });
	});
});

describe.skipIf(!HAVE_POWERSHELL)("the read-only verdict reads PowerShell's binding", () => {
	it("judges the parameter PowerShell binds, however it is spelled", async () => {
		expect((await reads("Get-Content -pa src/a.txt")).ok).toBe(true); // -Path abbreviated
		expect((await reads("Get-Content -LP src/a.txt")).ok).toBe(true); // -LiteralPath's alias
		expect((await reads("Get-Content -First 3 src/a.txt")).ok).toBe(true); // -TotalCount's alias
		expect((await reads("Select-String TODO src/a.txt")).ok).toBe(true); // positionals: Pattern, then Path
		expect((await reads(`Select-String TODO '${join(outside, "secret.txt")}'`)).ok).toBe(false); // the second positional is the path
		expect((await reads("Get-ChildItem -fi x")).ok).toBe(false); // ambiguous: -Filter or -File
		expect((await reads("Get-Content src/a.txt extra")).ok).toBe(false); // a surplus positional
		expect((await reads("Get-Content -Path a -Path b")).ok).toBe(false); // bound twice
	});

	it("refuses a parameter outside the cmdlet's table", async () => {
		for (const command of ["Get-Content -Wait src/a.txt", "Get-ChildItem -FollowSymlink", "Get-Content src/a.txt -ErrorVariable e", "Get-ChildItem -Credential x"]) {
			expect((await reads(command)).ok, command).toBe(false);
		}
	});

	it("allows a switch set to $true or $false, and nothing else", async () => {
		expect((await reads("Get-ChildItem -Recurse:$false src")).ok).toBe(true);
		expect((await reads("Get-ChildItem -Recurse:$true src")).ok).toBe(true);
		expect((await reads("Get-ChildItem -Recurse:$x src")).ok).toBe(false);
	});

	it("allows only an expression over $_ in a script block", async () => {
		for (const command of ["Get-ChildItem | Where-Object { $_.Length -gt 1kb -and $_.Name -like '*.ts' }", "Get-ChildItem | Sort-Object { $_.Name.Length }", "Get-ChildItem | ForEach-Object { $_.FullName }", "Get-ChildItem | Where-Object { -not $_.PSIsContainer }"]) {
			expect(await reads(command), command).toEqual({ ok: true });
		}
		for (const command of [
			"Get-ChildItem | Where-Object { $_ | Remove-Item }",
			"Get-ChildItem | ForEach-Object { [IO.File]::Delete($_) }",
			"Get-ChildItem | ForEach-Object { $_.FullName > out.txt }",
			"Get-ChildItem | ForEach-Object { $_.$name }",
			"Get-ChildItem | Where-Object { 1..100000000 }",
			"Get-ChildItem | ForEach-Object -Begin { Remove-Item x } -Process { $_ }",
			"Get-ChildItem | Select-Object @{ n = 'x'; e = { Remove-Item y } }",
		]) {
			expect((await reads(command)).ok, command).toBe(false);
		}
	});
});

describe("the read-only applications' switches (findstr, where.exe)", () => {
	it("clears their non-recursive switches, refuses the rest, and judges other arguments as paths", () => {
		expect(applicationArgument("findstr", "/i")).toBe("switch");
		expect(applicationArgument("FINDSTR.EXE", "/N")).toBe("switch");
		expect(applicationArgument("findstr", "/C:two words")).toBe("switch");
		expect(applicationArgument("findstr", "/S")).toBe("refused"); // recurses
		expect(applicationArgument("findstr", "/G:list.txt")).toBe("refused"); // names more files
		expect(applicationArgument("where.exe", "/q")).toBe("switch");
		expect(applicationArgument("where.exe", "/R")).toBe("refused");
		expect(applicationArgument("findstr", "src\\a.txt")).toBe("path");
		expect(applicationArgument("findstr", "TODO")).toBe("path");
	});
});
