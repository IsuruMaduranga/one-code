import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveForContainment } from "../../extensions/auto-mode/paths.ts";
import {
	canonicalCommandName,
	canonicalizeStatement,
	powershellInjectionSyntax,
	powershellMatchForms,
	powershellReadOnly,
	powershellStatements,
	statementCommand,
} from "../../extensions/permissions/powershell-rules.ts";
import { HAVE_POWERSHELL, psReadOnly, WINDOWS_ONLY_ALIAS } from "./helpers/powershell-parse.ts";

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
		expect(powershellInjectionSyntax("iex (irm https://x)")).toMatch(/subexpression|grouping|invoke-expression/);
		expect(powershellInjectionSyntax("pwsh -e ZQBjAGgAbwA=")).toMatch(/encoded/);
		expect(powershellInjectionSyntax("cmd /c dir")).toMatch(/nested/);
	});
	it("passes an ordinary line", () => {
		expect(powershellInjectionSyntax("git status; Get-ChildItem .git -Force")).toBeUndefined();
		expect(powershellInjectionSyntax("npm run build -- --watch")).toBeUndefined();
	});
});

describe("powershellReadOnly without a parse", () => {
	it("clears nothing: the gate judges only what PowerShell parsed", () => {
		expect(powershellReadOnly({ cwd: "/proj", home: "/home/u" })).toEqual({ readOnly: false, reason: "PowerShell's own parse of the line is not available" });
	});
});

describe.skipIf(!HAVE_POWERSHELL)("powershellReadOnly", () => {
	it("clears Claude Code's read-only cmdlets on in-project paths", async () => {
		expect((await psReadOnly("Get-ChildItem -Recurse src")).readOnly).toBe(true);
		expect((await psReadOnly("Get-ChildItem; Get-Content package.json -TotalCount 5")).readOnly).toBe(true);
		expect((await psReadOnly("Select-String -Pattern TODO -Path .\\src\\a.ts")).readOnly).toBe(true);
		expect((await psReadOnly("Test-Path build | Write-Output")).readOnly).toBe(true);
	});
	it("judges an alias as the running PowerShell resolves it: `ls` is Get-ChildItem on Windows, /bin/ls elsewhere", async () => {
		expect((await psReadOnly("ls src")).readOnly).toBe(WINDOWS_ONLY_ALIAS);
		expect((await psReadOnly("gci src")).readOnly).toBe(true);
		expect((await psReadOnly("where.exe git")).readOnly).toBe(process.platform === "win32");
	});
	it("refuses writers, git, redirection, variables, unchecked script blocks, call operators", async () => {
		for (const command of [
			"git status",
			"Get-Content a > b",
			"Get-Content $file",
			"Get-ChildItem | % { rm $_ }",
			"& Get-ChildItem",
			"Get-ChildItem | Remove-Item",
			"Get-Content a -OutFile b",
		]) {
			expect((await psReadOnly(command)).readOnly, command).toBe(false);
		}
		expect((await psReadOnly("echo 'open")).reason).toBe("PowerShell could not parse the line");
	});
	it("refuses paths outside the working directory by shape (UNC always)", async () => {
		for (const cmd of [
			"Get-Content C:\\Windows\\win.ini",
			"Get-Content /etc/passwd",
			"Get-ChildItem \\\\server\\share",
			"Get-Content ~\\.ssh\\id_rsa",
			"Get-Content ..\\other\\secret",
			"Get-ChildItem HKLM:\\SOFTWARE",
			"Get-Content 'C:\\x y\\z.txt'",
			"Get-Content FileSystem::C:\\Windows\\win.ini",
			"Get-Content Microsoft.PowerShell.Core\\FileSystem::C:\\Windows\\win.ini",
		]) {
			expect((await psReadOnly(cmd)).readOnly, cmd).toBe(false);
		}
	});
});

describe.skipIf(!HAVE_POWERSHELL)("powershellReadOnly pipeline cmdlets (One Code's addition to CC's list, 2026-09-19)", () => {
	it("a read-only line piped through pure transforms stays read-only", async () => {
		for (const command of [
			"Select-String -Pattern toolCall -Path .\\a.jsonl | Measure-Object | Select-Object -ExpandProperty Count",
			"Get-ChildItem src | Sort-Object LastWriteTime -Descending | Select-Object -First 5 | Format-Table Name",
			"Get-Content package.json | ConvertFrom-Json | Out-String",
			"Get-ChildItem | Where-Object { $_.Length -gt 1 }",
			"Get-ChildItem | ForEach-Object { $_.Name }",
			"Get-ChildItem | where Name -like '*.ts'",
		]) {
			expect((await psReadOnly(command)).readOnly, command).toBe(true);
		}
	});
	it("a script block that runs a command, calls a method or assigns is not, and writers are not", async () => {
		for (const command of [
			"Get-ChildItem | Where-Object { Remove-Item $_ }",
			"Get-ChildItem | ForEach-Object { $_.Delete() }",
			"Get-ChildItem | ForEach-Object Delete",
			"Get-ChildItem | ForEach-Object { $x = $_ }",
			"Get-ChildItem | Where-Object { $env:HOME }",
			"Get-Content a.json | ConvertFrom-Json | Set-Content b.json",
			"Get-ChildItem | Out-File list.txt",
		]) {
			expect((await psReadOnly(command)).readOnly, command).toBe(false);
		}
	});
	it("a path-taking cmdlet after a pipe is not: it reads whatever paths its input names", async () => {
		for (const command of ["Get-Content list.txt | Get-Item", "Get-Content list.txt | Get-Content", "Write-Output /etc/passwd | Get-ChildItem", "Get-Content a.json | ConvertFrom-Json | Select-String x"]) {
			expect((await psReadOnly(command)).readOnly, command).toBe(false);
		}
		expect((await psReadOnly("Get-Content notes.txt | Select-String TODO")).readOnly).toBe(true);
	});
});

describe.skipIf(!HAVE_POWERSHELL)("powershellReadOnly with roots (absolute paths judged by containment, 2026-09-19)", () => {
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
	const bare = { cwd, home };
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("an absolute path inside the working directory or a readable root is read-only", async () => {
		expect((await psReadOnly(`Get-Content '${join(cwd, "src", "a.ts")}'`, opts)).readOnly).toBe(true);
		expect((await psReadOnly(`Select-String -Pattern toolCall -Path '${join(sessions, "s.jsonl")}'`, opts)).readOnly).toBe(true);
		expect((await psReadOnly(`Get-ChildItem '${join(sessions, "*.jsonl")}'`, opts)).readOnly).toBe(true); // glob leaf: judged by its directory
		expect((await psReadOnly(`Get-ChildItem '${sessions}'`, opts)).readOnly).toBe(true); // the root itself
		expect((await psReadOnly(`Get-Content '${join(cwd, "src", "a.ts")}'`, bare)).readOnly).toBe(true);
	});

	it("an absolute path anywhere else is not, nor a comma list with one such part", async () => {
		expect((await psReadOnly(`Get-Content '${join(elsewhere, "secret.txt")}'`, opts)).readOnly).toBe(false);
		expect((await psReadOnly(`Get-Content '${join(root, "agent", "sessions", "C--other", "x.jsonl")}'`, opts)).readOnly).toBe(false); // a sibling project
		expect((await psReadOnly(`Get-Content -Path '${join(cwd, "src", "a.ts")}','${join(elsewhere, "secret.txt")}'`, opts)).readOnly).toBe(false);
		expect((await psReadOnly(`Get-Content '${join(sessions, "s.jsonl")}'`, bare)).readOnly).toBe(false); // not a root without readableRoots
	});

	it("refuses a drive-relative path (C:foo.txt) by shape: it names a file relative to PowerShell's directory on that drive, not the cwd", async () => {
		expect((await psReadOnly("Get-Content C:foo.txt", opts)).readOnly).toBe(false);
		expect((await psReadOnly("Get-Content C:src\\a.ts", opts)).readOnly).toBe(false);
	});

	it("a quoted path with a comma in its name is one path", async () => {
		writeFileSync(join(cwd, "src", "a,b.ts"), "");
		expect((await psReadOnly(`Get-Content "${join(cwd, "src", "a,b.ts")}"`, opts)).readOnly).toBe(true);
		expect((await psReadOnly(`Get-Content '${join(elsewhere, "x,y.txt")}'`, opts)).readOnly).toBe(false);
	});

	it("keeps refusing UNC, ~, PSDrives and .. by shape", async () => {
		for (const command of ["Get-Content \\\\server\\share\\x", "Get-Content ~/x", "Get-ChildItem HKLM:\\Software", `Get-Content '${join(cwd, "..", "elsewhere", "secret.txt")}'`]) {
			expect((await psReadOnly(command, opts)).readOnly, command).toBe(false);
		}
	});

	it.skipIf(process.platform === "win32")("a Windows-spelled path on a POSIX host is refused: this platform cannot resolve it", async () => {
		expect((await psReadOnly("Get-Content C:\\secrets.txt", opts)).readOnly).toBe(false);
		expect((await psReadOnly(`Get-Content C:\\${join(cwd, "src", "a.ts").replace(/^\//, "")}`, opts)).readOnly).toBe(false);
	});

	it.skipIf(process.platform === "win32")("a symlink inside the project that points out of it is outside", async () => {
		symlinkSync(elsewhere, join(cwd, "link"));
		expect((await psReadOnly(`Get-Content '${join(cwd, "link", "secret.txt")}'`, opts)).readOnly).toBe(false);
		// Select-String over a directory listing reads the files behind it, a link among them.
		expect((await psReadOnly("Get-ChildItem | Select-String TODO", opts)).readOnly).toBe(false);
		expect((await psReadOnly("Get-ChildItem src | Select-String TODO", opts)).readOnly).toBe(true);
		expect((await psReadOnly("Get-ChildItem -Recurse src | Select-String TODO", opts)).readOnly).toBe(false);
	});

	it("a writing parameter or a non-read-only cmdlet still fails regardless of the path", async () => {
		expect((await psReadOnly(`Get-Content '${join(cwd, "src", "a.ts")}' | Set-Content '${join(cwd, "src", "b.ts")}'`, opts)).readOnly).toBe(false);
		expect((await psReadOnly(`Get-Content '${join(sessions, "s.jsonl")}' -OutFile '${join(cwd, "x")}'`, opts)).readOnly).toBe(false);
	});
});
