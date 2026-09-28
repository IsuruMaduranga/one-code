/**
 * The parse server against a real PowerShell: the walker script, the
 * bootstrap on each platform's command line, and the model a gate reads
 * (decisions/windows.md "The PowerShell pre-gate reads PowerShell's own
 * parse"). The lines are the ones tree-sitter got wrong (findings §41), so
 * each assertion is a place where the model must show what PowerShell runs.
 *
 * Runs against `pwsh` on PATH (or `ONECODE_TEST_PWSH`), and on Windows also
 * against Windows PowerShell 5.1; CI has both. Skips when neither exists.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type PowerShellAstNode, type PowerShellParse, PowerShellParser } from "../../extensions/lib/powershell-parser.ts";
import { POWERSHELL_ARGS, spawnShellCommand } from "../../extensions/lib/shell-spawn.ts";
import { whichOnPath } from "../../extensions/lib/which.ts";

function executables(): string[] {
	const found: string[] = [];
	const pwsh = process.env.ONECODE_TEST_PWSH ?? whichOnPath("pwsh", process.env, process.platform);
	if (pwsh) found.push(pwsh);
	if (process.platform === "win32") {
		const desktop = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (existsSync(desktop)) found.push(desktop);
	}
	return found;
}

const EXECUTABLES = executables();
const parsers: PowerShellParser[] = [];

afterAll(() => {
	for (const parser of parsers) parser.stop();
});

function commands(parse: PowerShellParse): string[] {
	return parse.nodes.filter((n) => n.type === "CommandAst").map((n) => n.name ?? "<dynamic>");
}

function ofType(parse: PowerShellParse, type: string): PowerShellAstNode[] {
	return parse.nodes.filter((n) => n.type === type);
}

describe.skipIf(EXECUTABLES.length === 0)("PowerShell parse server (live)", () => {
	for (const executable of EXECUTABLES) {
		describe(executable, () => {
			const parser = new PowerShellParser({
				spawnServer: (bootstrap) => spawnShellCommand({ shell: executable, args: [...POWERSHELL_ARGS] }, bootstrap, { stdio: ["pipe", "pipe", "pipe"] }),
				// A cold start on a CI runner can be slow; production uses 5 s.
				startTimeoutMs: 60_000,
				requestTimeoutMs: 20_000,
			});
			parsers.push(parser);

			const parse = async (command: string): Promise<PowerShellParse> => {
				const outcome = await parser.parse(command);
				if (!outcome.ok) throw new Error(outcome.reason);
				return outcome.parse;
			};

			it("parses a pipeline into commands, parameters and resolved arguments", { timeout: 90_000 }, async () => {
				const result = await parse("Get-ChildItem -Recurse 'src dir' | Where-Object { $_.Length -gt 1kb }");
				expect(result.errors).toEqual([]);
				expect(commands(result)).toEqual(["Get-ChildItem", "Where-Object"]);
				expect(ofType(result, "CommandParameterAst").map((n) => n.name)).toEqual(["Recurse"]);
				expect(ofType(result, "StringConstantExpressionAst").find((n) => n.kind === "SingleQuoted")?.value).toBe("src dir");
				expect(ofType(result, "ScriptBlockExpressionAst")).toHaveLength(1);
			});

			it("keeps the tree consistent: pre-order, parents before children, extents nested", { timeout: 90_000 }, async () => {
				const command = "ls a; if ($x) { rm \"b$(Get-Date)\" } else { cat c }";
				const result = await parse(command);
				expect(result.nodes[0].parent).toBe(-1);
				expect(result.nodes[0].type).toBe("ScriptBlockAst");
				result.nodes.forEach((node, i) => {
					if (i === 0) return;
					expect(node.parent).toBeGreaterThanOrEqual(0);
					expect(node.parent).toBeLessThan(i);
					const parent = result.nodes[node.parent];
					expect(node.start).toBeGreaterThanOrEqual(parent.start);
					expect(node.end).toBeLessThanOrEqual(parent.end);
				});
				expect(commands(result)).toEqual(["ls", "rm", "Get-Date", "cat"]);
			});

			it("reports offsets in JS string units, through non-ASCII text", { timeout: 90_000 }, async () => {
				const command = "Get-Content '日本語 ✓ 😀.txt' -Tail 3";
				const result = await parse(command);
				const quoted = ofType(result, "StringConstantExpressionAst").find((n) => n.kind === "SingleQuoted")!;
				expect(quoted.value).toBe("日本語 ✓ 😀.txt");
				expect(command.slice(quoted.start, quoted.end)).toBe("'日本語 ✓ 😀.txt'");
			});

			it("reads an en dash, em dash or horizontal bar as a parameter dash", { timeout: 90_000 }, async () => {
				for (const dash of ["\u2013", "\u2014", "\u2015"]) {
					const result = await parse(`Get-Content ${dash}LiteralPath C:\\secret`);
					expect(ofType(result, "CommandParameterAst").map((n) => n.name)).toEqual(["LiteralPath"]);
				}
			});

			it("reads curly quotes as quotes, so a `;` inside them splits nothing", { timeout: 90_000 }, async () => {
				const result = await parse("Write-Output \u2018a; rm x\u2019");
				expect(result.errors).toEqual([]);
				expect(commands(result)).toEqual(["Write-Output"]);
				expect(ofType(result, "StringConstantExpressionAst").find((n) => n.kind === "SingleQuoted")?.value).toBe("a; rm x");
			});

			it("reports mismatched quotes as a parse error", { timeout: 90_000 }, async () => {
				const result = await parse("Write-Output 'a\u2019; rm x'");
				expect(result.errors.length).toBeGreaterThan(0);
			});

			it("shows every redirection spelling as a redirection", { timeout: 90_000 }, async () => {
				for (const line of ["ls 1> out.txt", "ls 2>err.txt", "ls 2>>err.txt", "ls *>x.txt", "ls >x.txt", "ls 2>$null", "ls 'a'>x"]) {
					const result = await parse(line);
					expect(result.errors, line).toEqual([]);
					expect(ofType(result, "FileRedirectionAst"), line).toHaveLength(1);
				}
				const merge = await parse("ls 2>&1");
				expect(ofType(merge, "MergingRedirectionAst")[0]).toMatchObject({ from: "Error", to: "Output" });
			});

			it("ends a stop-parsing argument at a pipe", { timeout: 90_000 }, async () => {
				const result = await parse("echo --% a | rm x");
				expect(commands(result)).toEqual(["echo", "rm"]);
			});

			it("separates on Unicode whitespace and a bare CR", { timeout: 90_000 }, async () => {
				expect(commands(await parse("Get-Content\u00a0x;\u00a0Remove-Item y"))).toEqual(["Get-Content", "Remove-Item"]);
				expect(commands(await parse("ls # x\rrm y"))).toEqual(["ls", "rm"]);
			});

			it("finds commands nested in strings, subexpressions and script blocks", { timeout: 90_000 }, async () => {
				expect(commands(await parse('ls "x$(rm y)"'))).toEqual(["ls", "rm"]);
				expect(commands(await parse("ls '$(rm y)'"))).toEqual(["ls"]);
				expect(commands(await parse("Invoke-Command -ScriptBlock { rm x }"))).toEqual(["Invoke-Command", "rm"]);
			});

			it("marks call operators, splatting, and static .NET calls", { timeout: 90_000 }, async () => {
				const call = await parse("& $cmd @args");
				expect(ofType(call, "CommandAst")[0]).toMatchObject({ operator: "Ampersand", name: null });
				expect(ofType(call, "VariableExpressionAst").find((n) => n.splatted)?.name).toBe("args");
				const dotnet = await parse("[IO.File]::Delete('x')");
				expect(ofType(dotnet, "InvokeMemberExpressionAst")[0]).toMatchObject({ static: true });
				expect(ofType(dotnet, "TypeExpressionAst")[0].name).toBe("IO.File");
			});

			it("answers a line of only whitespace, and restarts after stop()", { timeout: 90_000 }, async () => {
				expect(commands(await parse("  "))).toEqual([]);
				parser.stop();
				expect(commands(await parse("ls"))).toEqual(["ls"]);
			});
		});
	}
});
