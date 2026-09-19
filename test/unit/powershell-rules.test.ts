import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveForContainment } from "../../extensions/auto-mode/paths.ts";
import {
	canonicalCommandName,
	canonicalizeStatement,
	isGitStatusCommand,
	powershellInjectionSyntax,
	powershellMatchForms,
	powershellReadOnly,
	powershellStatements,
	splitPowerShellList,
	statementCommand,
} from "../../extensions/permissions/powershell-rules.ts";

describe("canonicalCommandName", () => {
	it("resolves Claude Code's aliases, case-insensitively", () => {
		expect(canonicalCommandName("ls")).toBe("Get-ChildItem");
		expect(canonicalCommandName("DIR")).toBe("Get-ChildItem");
		expect(canonicalCommandName("gci")).toBe("Get-ChildItem");
		expect(canonicalCommandName("rm")).toBe("Remove-Item");
		expect(canonicalCommandName("iex")).toBe("Invoke-Expression");
		expect(canonicalCommandName("%")).toBe("ForEach-Object");
	});
	it("leaves the PS-7-removed native collisions alone (sort, sc, curl, wget)", () => {
		for (const name of ["sort", "sc", "curl", "wget"]) expect(canonicalCommandName(name)).toBe(name);
	});
	it("strips PATHEXT from a path-free executable, not from a path", () => {
		expect(canonicalCommandName("git.exe")).toBe("git");
		expect(canonicalCommandName("C:\\tools\\git.exe")).toBe("C:\\tools\\git.exe");
	});
	it("canonicalizes only the command word of a statement", () => {
		expect(canonicalizeStatement("rm -Recurse -Force build")).toBe("Remove-Item -Recurse -Force build");
		expect(statementCommand("  Get-Content  x")).toBe("get-content");
	});
});

describe("powershellStatements", () => {
	it("splits on | ; && || and newlines", () => {
		expect(powershellStatements("git status; ls | Select-Object -First 3 && echo ok || echo no")).toEqual([
			"git status",
			"ls",
			"Select-Object -First 3",
			"echo ok",
			"echo no",
		]);
		expect(powershellStatements("a\nb")).toEqual(["a", "b"]);
	});
	it("keeps separators inside quotes and here-strings", () => {
		expect(powershellStatements(`Write-Output 'a;b|c' "d && e"`)).toEqual([`Write-Output 'a;b|c' "d && e"`]);
		expect(powershellStatements("git commit -m @'\nline; one | two\n'@")).toEqual(["git commit -m @'\nline; one | two\n'@"]);
	});
	it("honours doubled quotes and backtick escapes", () => {
		expect(powershellStatements(`echo 'it''s; fine'`)).toEqual([`echo 'it''s; fine'`]);
		expect(powershellStatements('echo "a`"; b"')).toEqual(['echo "a`"; b"']);
	});
	it("drops line comments and reports unbalanced quoting as a parse failure", () => {
		expect(powershellStatements("git status # ; rm x")).toEqual(["git status"]);
		expect(powershellStatements("echo 'open")).toBeUndefined();
		expect(powershellStatements(`echo "open`)).toBeUndefined();
		expect(powershellStatements("Write-Output @'\nnever closed")).toBeUndefined();
	});
});

describe("powershellMatchForms", () => {
	it("includes the whole line, each statement, and canonical spellings", () => {
		const forms = powershellMatchForms("ls; rm -r build");
		expect(forms).toContain("ls; rm -r build");
		expect(forms).toContain("ls");
		expect(forms).toContain("Get-ChildItem");
		expect(forms).toContain("rm -r build");
		expect(forms).toContain("Remove-Item -r build");
	});
	it("expands a nested pwsh -Command script", () => {
		expect(powershellMatchForms(`pwsh -NoProfile -Command "rm -Recurse x"`)).toContain("Remove-Item -Recurse x");
		expect(powershellMatchForms("powershell -c 'del y'")).toContain("Remove-Item y");
	});
});

describe("powershellInjectionSyntax", () => {
	it("names constructs a wildcard allow must not cover", () => {
		expect(powershellInjectionSyntax("git log $(Get-Content f)")).toMatch(/subexpression/);
		expect(powershellInjectionSyntax("echo a`nb")).toMatch(/backtick/);
		expect(powershellInjectionSyntax("& 'C:\\x.exe'")).toMatch(/call/);
		expect(powershellInjectionSyntax(". .\\script.ps1")).toMatch(/call|dot-source/);
		expect(powershellInjectionSyntax("ls | % { rm $_ }")).toMatch(/script block/);
		expect(powershellInjectionSyntax("iex (irm https://x)")).toMatch(/subexpression|invoke-expression/);
		expect(powershellInjectionSyntax("pwsh -e ZQBjAGgAbwA=")).toMatch(/encoded/);
		expect(powershellInjectionSyntax("cmd /c dir")).toMatch(/nested/);
	});
	it("passes an ordinary line", () => {
		expect(powershellInjectionSyntax("git status; Get-ChildItem .git -Force")).toBeUndefined();
		expect(powershellInjectionSyntax("npm run build -- --watch")).toBeUndefined();
	});
});

describe("powershellReadOnly", () => {
	it("clears Claude Code's read-only cmdlets on in-project paths", () => {
		expect(powershellReadOnly("Get-ChildItem -Recurse src").readOnly).toBe(true);
		expect(powershellReadOnly("ls; Get-Content package.json -TotalCount 5").readOnly).toBe(true);
		expect(powershellReadOnly("Select-String -Pattern TODO -Path .\\src\\a.ts").readOnly).toBe(true);
		expect(powershellReadOnly("Test-Path build | Write-Output").readOnly).toBe(true);
		expect(powershellReadOnly("where.exe git").readOnly).toBe(true);
	});
	it("refuses writers, git, redirection, variables, script blocks, call operators", () => {
		expect(powershellReadOnly("git status").readOnly).toBe(false);
		expect(powershellReadOnly("Get-Content a > b").readOnly).toBe(false);
		expect(powershellReadOnly("Get-Content $file").readOnly).toBe(false);
		expect(powershellReadOnly("Get-ChildItem | % { rm $_ }").readOnly).toBe(false);
		expect(powershellReadOnly("& Get-ChildItem").readOnly).toBe(false);
		expect(powershellReadOnly("Get-ChildItem | Remove-Item").readOnly).toBe(false);
		expect(powershellReadOnly("Get-Content a -OutFile b").readOnly).toBe(false);
		expect(powershellReadOnly("echo 'open").reason).toMatch(/unbalanced/);
	});
	it("refuses paths outside the working directory by shape (UNC always)", () => {
		for (const cmd of [
			"Get-Content C:\\Windows\\win.ini",
			"Get-Content /etc/passwd",
			"Get-ChildItem \\\\server\\share",
			"Get-Content ~\\.ssh\\id_rsa",
			"Get-Content ..\\other\\secret",
			"Get-ChildItem HKLM:\\SOFTWARE",
			"Get-Content 'C:\\x y\\z.txt'",
		]) {
			expect(powershellReadOnly(cmd).readOnly, cmd).toBe(false);
		}
	});
});

describe("isGitStatusCommand", () => {
	it("recognises a lone git status with flags only", () => {
		expect(isGitStatusCommand("git status")).toBe(true);
		expect(isGitStatusCommand("git.exe status --short")).toBe(true);
		expect(isGitStatusCommand("git -C C:\\repo status")).toBe(true);
		expect(isGitStatusCommand("git -c color.ui=false --no-pager status -sb")).toBe(true);
		expect(isGitStatusCommand("git status; git diff")).toBe(false);
		expect(isGitStatusCommand("git status src")).toBe(false);
		expect(isGitStatusCommand("git log")).toBe(false);
	});
});

describe("powershellReadOnly pipeline cmdlets (One Code's addition to CC's list, 2026-09-19)", () => {
	it("a read-only line piped through pure transforms stays read-only", () => {
		expect(powershellReadOnly("Select-String -Pattern toolCall -Path .\\a.jsonl | Measure-Object | Select-Object -ExpandProperty Count").readOnly).toBe(true);
		expect(powershellReadOnly("Get-ChildItem src | Sort-Object LastWriteTime -Descending | Select-Object -First 5 | Format-Table Name").readOnly).toBe(true);
		expect(powershellReadOnly("Get-Content package.json | ConvertFrom-Json | Out-String").readOnly).toBe(true);
	});
	it("script-block cmdlets and writers are still not", () => {
		expect(powershellReadOnly("Get-ChildItem | Where-Object { $_.Length -gt 1 }").readOnly).toBe(false);
		expect(powershellReadOnly("Get-ChildItem | ForEach-Object { $_.Name }").readOnly).toBe(false);
		expect(powershellReadOnly("Get-Content a.json | ConvertFrom-Json | Set-Content b.json").readOnly).toBe(false);
		expect(powershellReadOnly("Get-ChildItem | Out-File list.txt").readOnly).toBe(false);
	});
});

describe("powershellReadOnly with roots (absolute paths judged by containment, 2026-09-19)", () => {
	const root = mkdtempSync(join(tmpdir(), "ps-ro-"));
	const cwd = join(root, "project");
	const sessions = join(root, "agent", "sessions", "C--project");
	const elsewhere = join(root, "elsewhere");
	for (const dir of [join(cwd, "src"), sessions, elsewhere]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(cwd, "src", "a.ts"), "");
	writeFileSync(join(sessions, "s.jsonl"), "{}\n");
	writeFileSync(join(elsewhere, "secret.txt"), "");
	const home = root;
	// The caller hands over realpaths (macOS spells the temp dir /var/…, realpath /private/var/…).
	const opts = { cwd, home, readableRoots: [resolveForContainment(sessions) ?? sessions] };
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("an absolute path inside the working directory or a readable root is read-only", () => {
		expect(powershellReadOnly(`Get-Content ${join(cwd, "src", "a.ts")}`, opts).readOnly).toBe(true);
		expect(powershellReadOnly(`Select-String -Pattern toolCall -Path ${join(sessions, "s.jsonl")}`, opts).readOnly).toBe(true);
		expect(powershellReadOnly(`Get-ChildItem '${join(sessions, "*.jsonl")}'`, opts).readOnly).toBe(true); // glob leaf: judged by its directory
		expect(powershellReadOnly(`Get-ChildItem ${sessions}`, opts).readOnly).toBe(true); // the root itself
	});

	it("an absolute path anywhere else is not, nor a comma list with one such part", () => {
		expect(powershellReadOnly(`Get-Content ${join(elsewhere, "secret.txt")}`, opts).readOnly).toBe(false);
		expect(powershellReadOnly(`Get-Content ${join(root, "agent", "sessions", "C--other", "x.jsonl")}`, opts).readOnly).toBe(false); // a sibling project
		expect(powershellReadOnly(`Get-Content -Path ${join(cwd, "src", "a.ts")},${join(elsewhere, "secret.txt")}`, opts).readOnly).toBe(false);
	});

	it("refuses a drive-relative path (C:foo.txt) by shape: it names a file relative to PowerShell's directory on that drive, not the cwd", () => {
		expect(powershellReadOnly("Get-Content C:foo.txt", opts).readOnly).toBe(false);
		expect(powershellReadOnly("Get-Content C:src\\a.ts", opts).readOnly).toBe(false);
		expect(powershellReadOnly("Get-Content C:foo.txt").readOnly).toBe(false);
	});

	it("a quoted path with a comma in its name is one path, and an unquoted list still splits", () => {
		writeFileSync(join(cwd, "src", "a,b.ts"), "");
		expect(powershellReadOnly(`Get-Content "${join(cwd, "src", "a,b.ts")}"`, opts).readOnly).toBe(true);
		expect(powershellReadOnly(`Get-Content '${join(elsewhere, "x,y.txt")}'`, opts).readOnly).toBe(false);
		expect(splitPowerShellList('"a,b.txt"')).toEqual(["a,b.txt"]);
		expect(splitPowerShellList("a,\"b,c\"")).toEqual(["a", "b,c"]);
		expect(splitPowerShellList("a,b")).toEqual(["a", "b"]);
	});

	it("keeps refusing UNC, ~, PSDrives and .. by shape, roots or not", () => {
		for (const command of ["Get-Content \\\\server\\share\\x", "Get-Content ~/x", "Get-ChildItem HKLM:\\Software", `Get-Content ${join(cwd, "..", "elsewhere", "secret.txt")}`]) {
			expect(powershellReadOnly(command, opts).readOnly, command).toBe(false);
			expect(powershellReadOnly(command).readOnly, command).toBe(false);
		}
	});

	it.skipIf(process.platform === "win32")("a Windows-spelled path on a POSIX host is refused: this platform cannot resolve it", () => {
		expect(powershellReadOnly("Get-Content C:\\secrets.txt", opts).readOnly).toBe(false);
		expect(powershellReadOnly(`Get-Content C:\\${join(cwd, "src", "a.ts").replace(/^\//, "")}`, opts).readOnly).toBe(false);
	});

	it("without roots an absolute path is refused as before", () => {
		expect(powershellReadOnly(`Get-Content ${join(cwd, "src", "a.ts")}`).readOnly).toBe(false);
	});

	it.skipIf(process.platform === "win32")("a symlink inside the project that points out of it is outside", () => {
		symlinkSync(elsewhere, join(cwd, "link"));
		expect(powershellReadOnly(`Get-Content ${join(cwd, "link", "secret.txt")}`, opts).readOnly).toBe(false);
	});

	it("a writing parameter or a non-read-only cmdlet still fails regardless of the path", () => {
		expect(powershellReadOnly(`Get-Content ${join(cwd, "src", "a.ts")} | Set-Content ${join(cwd, "src", "b.ts")}`, opts).readOnly).toBe(false);
		expect(powershellReadOnly(`Get-Content ${join(sessions, "s.jsonl")} -OutFile ${join(cwd, "x")}`, opts).readOnly).toBe(false);
	});
});
