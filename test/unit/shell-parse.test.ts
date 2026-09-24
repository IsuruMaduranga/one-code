import { describe, expect, it } from "vitest";
import { parseCommand } from "../../extensions/auto-mode/shell-parse.ts";
import { bashParserUnavailable } from "../../extensions/lib/bash-parser.ts";
import { bashMatchForms, bashSubcommands, findBashAllowRule, parseRules } from "../../extensions/permissions/matcher.ts";

const words = (command: string) => parseCommand(command).segments.map((segment) => segment.tokens.map((token) => token.value));

describe("bash grammar", () => {
	it("is loaded by the test setup", () => {
		expect(bashParserUnavailable()).toBeUndefined();
	});
});

describe("parseCommand on tree-sitter-bash", () => {
	it("splits lists, pipelines and substitutions into simple commands, in source order", () => {
		expect(words("a x && b | c; d &")).toEqual([["a", "x"], ["b"], ["c"], ["d"]]);
		expect(words("echo $(rm -f v) `id`")).toEqual([["echo", "$(rm -f v)", "`id`"], ["rm", "-f", "v"], ["id"]]);
		expect(words("(cd a && rm b) | { wc; }")).toEqual([["cd", "a"], ["rm", "b"], ["wc"]]);
	});

	it("gives the words after a redirect target back to the command", () => {
		// The grammar hangs `arg` on the redirect; bash passes it to `cmd`.
		const [segment] = parseCommand("cmd 2>/dev/null arg").segments;
		expect(segment.tokens.map((token) => token.value)).toEqual(["cmd", "arg"]);
		expect(segment.redirects).toEqual(["/dev/null"]);
		expect(words("echo x > out rm -rf /")).toEqual([["echo", "x", "rm", "-rf", "/"]]);
	});

	it("classifies redirects: writes, inputs, and descriptor duplication", () => {
		const [segment] = parseCommand("cmd >a >>b >|c &>d &>>e >&f <g <&h 2>&1 >&- <&3").segments;
		expect(segment.redirects).toEqual(["a", "b", "c", "d", "e", "f"]);
		expect(segment.inputs.map((token) => token.value)).toEqual(["g", "h"]);
		expect(parseCommand("< in.txt sort").segments[0].tokens.map((token) => token.value)).toEqual(["sort"]);
	});

	it("gives a redirect on a compound command a segment of its own", () => {
		const { segments } = parseCommand("{ ls; } > out");
		expect(segments.map((segment) => [segment.tokens.map((token) => token.value), segment.redirects])).toEqual([
			[["ls"], []],
			[[], ["out"]],
		]);
		expect(parseCommand("while read l; do :; done < in.txt").segments.at(-1)?.inputs.map((token) => token.value)).toEqual(["in.txt"]);
	});

	it("removes quoting, applies escapes, and notices unquoted globs only", () => {
		const [segment] = parseCommand(`echo a\\ b "x\\"y" 'q*' r*.ts \\* $'\\x2e\\x2e' "a"'b'c`).segments;
		expect(segment.tokens.map((token) => token.value)).toEqual(["echo", "a b", 'x"y', "q*", "r*.ts", "*", "..", "abc"]);
		expect(segment.tokens.map((token) => !!token.glob)).toEqual([false, false, false, false, true, false, false, false]);
		expect(words("\\rm -rf x")[0][0]).toBe("rm");
	});

	it("reads $\"…\" as locale quoting and a lone $ as a literal", () => {
		expect(parseCommand('cat $"/etc/passwd"').unknownQuoting).toContain("locale quoting");
		expect(parseCommand('cat a$"b"').unknownQuoting).toContain("locale quoting");
		const plain = parseCommand('grep "x$" f x$');
		expect(plain.unknownQuoting).toBeUndefined();
		expect(plain.segments[0].tokens.map((token) => token.value)).toEqual(["grep", "x$", "f", "x$"]);
	});

	it("flags a version-dependent $'…' escape", () => {
		expect(parseCommand("echo $'\\u2e'").unknownQuoting).toContain("bash version");
	});

	it("names the first construct the pre-gate does not model, and still walks inside it", () => {
		expect(parseCommand("for f in *; do rm $f; done").complex).toBe("uses a for loop");
		expect(parseCommand("(ls)").complex).toContain("subshell");
		expect(parseCommand("echo {a,b}").complex).toContain("brace expansion");
		expect(parseCommand("echo x{1..3}").complex).toContain("brace expansion");
		expect(parseCommand("[[ -f x ]] && rm y").complex).toContain("test");
		expect(parseCommand("f() { rm x; }").complex).toContain("function");
		expect(parseCommand("ls -la && git status | wc -l").complex).toBeUndefined();
		expect(words("if true; then rm a; else rm b; fi")).toEqual([["true"], ["rm", "a"], ["rm", "b"]]);
	});

	it("records the enclosing constructs and subshell scopes", () => {
		const { segments } = parseCommand("while true; do sleep 1; done; (cd a); echo $(pwd) | wc");
		expect(segments.map((segment) => segment.enclosing)).toEqual([
			["while_statement"],
			["while_statement", "do_group"],
			["subshell"],
			[],
			["command_substitution"],
			[],
		]);
		const [, , cd, echo, pwd, wc] = segments;
		expect(cd.scopes).toHaveLength(1);
		expect(echo.scopes).toHaveLength(1);
		expect(pwd.scopes).toHaveLength(2);
		expect(wc.scopes).toHaveLength(1);
		expect(new Set([cd.scopes[0], echo.scopes[0], wc.scopes[0]]).size).toBe(3);
	});

	it("marks the commands of a pipeline's last member", () => {
		const { segments } = parseCommand("a | b | { c; d; }; e");
		expect(segments.map((segment) => !!segment.lastInPipeline)).toEqual([false, false, true, true, false]);
	});

	it("detects only the background operator", () => {
		expect(parseCommand("a & b").background).toBe(true);
		expect(parseCommand("a && b 2>&1 &>log |& c").background).toBe(false);
	});

	it("fails closed on a syntax error or a construct the grammar lacks", () => {
		for (const command of ['echo "open', "echo $'open", "(ls", "if x; then y", "echo hi <> f"]) {
			expect(parseCommand(command).parseFailed, command).toBe(true);
		}
	});
});

describe("heredocs", () => {
	it("keeps a heredoc body out of the commands, but not the rest of its line", () => {
		const { segments } = parseCommand("cat <<EOF | sh\nrm -rf x\nEOF");
		expect(segments.map((segment) => segment.raw)).toEqual(["cat <<EOF", "sh"]);
		const [cat] = parseCommand("cat <<EOF > out.txt\nbody\nEOF").segments;
		expect(cat.redirects).toEqual(["out.txt"]);
		expect(cat.raw).toBe("cat <<EOF > out.txt");
	});

	it("walks the substitutions of an unquoted body, backticks included", () => {
		// The grammar parses $(…) in the body but leaves backticks as text.
		expect(words("cat <<EOF\nx `rm -rf a` $(rm b)\nEOF")).toEqual([["cat"], ["rm", "-rf", "a"], ["rm", "b"]]);
	});

	it("treats a quoted delimiter's body as data", () => {
		for (const delimiter of ["'EOF'", '"EOF"', "E\\OF"]) {
			expect(words(`cat <<${delimiter}\n\`rm x\` $(rm y)\nEOF`), delimiter).toEqual([["cat"]]);
		}
	});

	it("reads the usual commit-message form as git plus a cat of literal text", () => {
		const { segments, parseFailed } = parseCommand(`git commit -m "$(cat <<'EOF'\nFix \`rm\` handling\nEOF\n)"`);
		expect(parseFailed).toBe(false);
		expect(segments.map((segment) => segment.tokens[0].value)).toEqual(["git", "cat"]);
	});
});

describe("deny forms on the tree", () => {
	it("still meet a command on a line the grammar cannot parse", () => {
		// The heredoc's body comes after `; rm y`, which the grammar rejects.
		expect(parseCommand("cat <<EOF; rm y\nbody\nEOF").parseFailed).toBe(true);
		expect(bashMatchForms("cat <<EOF; rm y\nbody\nEOF")).toContain("rm y");
		expect(bashMatchForms("ls <> f; rm -f x")).toContain("rm -f x");
	});

	it("see the script a heredoc or here-string feeds a shell, and only a shell (PR #12 review)", () => {
		for (const command of ["sh <<'EOF'\nrm -rf x\nEOF", "cat <<EOF | sh\nrm -rf x\nEOF", "bash <<< 'rm -rf x'", "env bash -s <<'EOF'\nrm -rf x\nEOF"]) {
			expect(bashMatchForms(command), command).toContain("rm -rf x");
		}
		expect(bashMatchForms("git commit -F - <<'EOF'\nrm -rf x\nEOF")).not.toContain("rm -rf x");
		expect(bashMatchForms("echo 'rm -rf x'")).not.toContain("rm -rf x");
	});

	it("see what a -c script or a pipe from echo feeds a shell (PR #12 review)", () => {
		for (const command of [`sh -c 'eval "$(cat)"' <<< 'rm -rf x'`, "sh -c 'ls' <<'EOF'\nrm -rf x\nEOF", "echo 'rm -rf x' | sh", "printf 'rm -rf x' | bash", "echo -n rm -rf x | sh"]) {
			expect(bashMatchForms(command), command).toContain("rm -rf x");
		}
	});

	it("fail closed on a heredoc backtick the grammar cannot parse (PR #12 review)", () => {
		expect(parseCommand("cat <<EOF\nx `echo hi <> f`\nEOF").parseFailed).toBe(true);
		const allow = parseRules(["Bash(cat:*)", "Bash(echo:*)"]);
		expect(findBashAllowRule(allow, "cat <<EOF\nx `echo hi <> f`\nEOF")).toBeUndefined();
	});

	it("see the command a time group runs", () => {
		expect(bashMatchForms("time { rm -f v; }")).toContain("rm -f v");
	});

	it("leave allow rules to lines without unmodelled constructs", () => {
		expect(bashSubcommands("npm test && git status")).toEqual(["npm test", "git status"]);
		expect(bashSubcommands("(npm test)")).toBeUndefined();
		expect(bashSubcommands("for x in a; do npm test; done")).toBeUndefined();
	});
});
