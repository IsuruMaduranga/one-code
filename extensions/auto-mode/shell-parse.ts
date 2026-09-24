/**
 * Bash command lines turned into simple commands, on tree-sitter-bash
 * (pure apart from the grammar, lib/bash-parser.ts).
 *
 * `parseCommand` walks the syntax tree and returns one {@link Segment} per
 * simple command, in source order: its words with quoting removed, the files
 * its redirects write and read, and where it sits (inside a loop, a subshell,
 * a command substitution). Every consumer (the auto-mode pre-gate, the
 * permission matcher's deny forms, the bash and worktree guards, the safety
 * floor) judges those segments, so the walker only has to read bash right.
 *
 * ## Fail closed
 *
 * The grammar is not bash, and the walker trusts it only as far as it has to:
 *
 * - A tree with an ERROR or MISSING node is `parseFailed`. The segments found
 *   around the error are still returned, best effort, for the deny forms,
 *   which may only widen; every other caller ignores them.
 * - A construct the pre-gate does not model (a loop, a subshell, a function,
 *   `[[ ]]`, `$(( ))`, brace expansion, …) sets `complex`; the pre-gate
 *   escalates on it. The commands inside are still walked, so deny forms and
 *   guards see them.
 * - The grammar's known gaps are corrected here: words after a redirect's
 *   target belong to the command (`cmd 2>/dev/null arg`), `$"…"` keeps its
 *   `$` only as a separate token, and `{a,b}` is plain words to the grammar
 *   (findings §30).
 */

import { bashParserUnavailable, parseBash } from "../lib/bash-parser.ts";

type SyntaxNode = NonNullable<ReturnType<NonNullable<ReturnType<typeof parseBash>>["rootNode"]["child"]>>;

/**
 * What makes a word's value unknown until bash runs it, most telling first:
 * a parameter or arithmetic expansion (`$HOME`, `$1`, `$((…))`), whose value
 * comes from the environment; a command substitution (`$(…)`, a backtick,
 * `>(…)`), whose value is its command's output; or a whole word that is one
 * input process substitution (`<(cmd)`), which bash replaces with a pipe
 * path the command reads.
 */
export type Dynamic = "variable" | "substitution" | "process-input";

const DYNAMIC_RANK: Record<Dynamic, number> = { variable: 3, substitution: 2, "process-input": 1 };

/** The more telling of two kinds (see {@link Dynamic}). */
function mergeDynamic(a: Dynamic | undefined, b: Dynamic | undefined): Dynamic | undefined {
	if (!a) return b;
	if (!b) return a;
	return DYNAMIC_RANK[a] >= DYNAMIC_RANK[b] ? a : b;
}

export interface Token {
	/** The word with quotes removed, escapes applied and `$'…'` decoded; expansions keep their source text (`$HOME`). */
	value: string;
	/** True when the word used `$'…'` or `$"…"` quoting. */
	hadExpansion: boolean;
	/** True when an unquoted, unescaped `*`, `?` or `[` makes the token a glob bash expands. */
	glob?: boolean;
	/** Set when part of the value is only known when bash runs it. */
	dynamic?: Dynamic;
}

export interface Segment {
	/** Leading `NAME=value` assignments, then the command word, then its arguments. */
	tokens: Token[];
	/**
	 * Write targets (`>`, `>>`, `>|`, `&>`, `&>>`, `>&word`), in written order.
	 * A redirect on a compound command (`{ …; } > f`) gets a segment of its own
	 * with no tokens, like a bare `> f`.
	 */
	redirects: string[];
	/**
	 * Input targets (`<`, `<&word`): files the shell opens on the command's
	 * stdin, whatever the command is. Kept out of `tokens`, where `< f cmd` would
	 * make `f` the command word.
	 */
	inputs: Token[];
	/** The command's source text: its words and its own redirects (a heredoc up to its delimiter). */
	raw: string;
	/**
	 * The constructs around the command, outermost first, as tree-sitter node
	 * types (`while_statement`, `do_group`, `subshell`, `command_substitution`,
	 * …). Lists, pipelines and redirects are not constructs.
	 */
	enclosing: string[];
	/**
	 * The subshells the command runs in, outermost first, each by a number
	 * unique within the parse: `( … )`, a command or process substitution, and
	 * each command of a multi-command pipeline. A `cd` changes the directory of
	 * later commands only in its own scope.
	 */
	scopes: number[];
	/**
	 * Set for a command inside a command or process substitution: the index,
	 * in `ParseResult.substitutions`, of the outermost substitution around it.
	 */
	substitution?: number;
	/**
	 * True for a command in the last member of a multi-command pipeline. Bash
	 * runs that member in a subshell by default but in the current shell under
	 * `shopt -s lastpipe`, so a `cd` there may or may not move the commands
	 * after the pipeline; directory tracking treats it as unknown.
	 */
	lastInPipeline?: boolean;
	/** True when a redirect target's value is only known when bash runs it (`> "$f"`, `< $(ls)`). */
	unknownTarget?: boolean;
	/**
	 * True when a heredoc with an unquoted delimiter or a here-string expands a
	 * parameter into the command's input (`cat <<< "$TOKEN"`).
	 */
	expandsIntoInput?: boolean;
	/**
	 * The text each heredoc and here-string feeds the command's input, as
	 * written: data to most commands, a script to a shell reading its input
	 * (`sh <<'EOF'`, `cat <<EOF | sh`).
	 */
	stdin?: string[];
}

export interface ParseResult {
	segments: Segment[];
	/**
	 * The command did not parse cleanly (an unbalanced quote, a syntax error, a
	 * construct the grammar lacks such as `<>`), or the grammar is not loaded.
	 * Nothing about it is known; `segments` is a best-effort reading that only
	 * the deny forms may use.
	 */
	parseFailed: boolean;
	/** Set with `parseFailed` when the grammar is not loaded: why. */
	unavailable?: string;
	/**
	 * Why a word was quoted in a way whose value this check cannot know, or
	 * undefined: `$"…"` locale quoting (bash translates it through a message
	 * catalog), or a `$'…'` escape whose meaning differs between bash
	 * versions. The whole command escalates.
	 */
	unknownQuoting?: string;
	/** The first construct the pre-gate does not model, as a reason ("uses a for loop"), or undefined. */
	complex?: string;
	/** True when a command runs in the background (`cmd &`). */
	background: boolean;
	/**
	 * The command text of each outermost substitution (inside `$(…)`, the
	 * backticks or `<(…)`), indexed by `Segment.substitution`.
	 */
	substitutions: string[];
}

const ANSI_C_SIMPLE: Record<string, string> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"?": "?",
};

/** Consecutive characters from `body[from]` that match `pattern`, at most `max` of them. */
function scanWhile(body: string, from: number, pattern: RegExp, max: number): string {
	let j = from;
	while (j < body.length && j < from + max && pattern.test(body[j])) j++;
	return body.slice(from, j);
}

/**
 * Decode a `$'…'` string starting at `start` (the character after the opening
 * quote) the way bash does: the simple escapes, `\NNN` (one to three octal
 * digits), `\xHH`, `\uHHHH`, `\UHHHHHHHH` and `\cX`; a backslash escapes the
 * closing quote (`$'it\'s'`); any other backslash stays literal. The word ends
 * at a decoded NUL, as bash's C strings do. Returns the decoded text, the index
 * just past the closing quote (`body.length` when it is unterminated), and
 * whether an escape's meaning depends on the bash version.
 *
 * Until 2026-09-24 `\0` matched alone, so `\057` decoded to NUL plus "57"
 * instead of `/`, and a path spelled that way skipped every path check
 * (PREGATE-REVIEW-2026-09-23 P1).
 */
export function decodeAnsiC(body: string, start = 0): { text: string; end: number; versionDependent: boolean } {
	let out = "";
	let versionDependent = false;
	// Set once a decoded NUL ends the string value; the scan continues to the
	// real closing quote so the caller resumes the command in the right place.
	let truncated = false;
	const emit = (text: string) => {
		if (!truncated) out += text;
	};
	let i = start;
	for (; i < body.length; i++) {
		const ch = body[i];
		if (ch === "'") return { text: out, end: i + 1, versionDependent };
		if (ch !== "\\" || i + 1 >= body.length) {
			emit(ch);
			continue;
		}
		const next = body[i + 1];
		let decoded: string | undefined;
		let width = 2;
		if (next in ANSI_C_SIMPLE) {
			decoded = ANSI_C_SIMPLE[next];
		} else if (/[0-7]/.test(next)) {
			const octal = scanWhile(body, i + 1, /[0-7]/, 3);
			decoded = String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
			width = 1 + octal.length;
		} else if (next === "x" || next === "u" || next === "U") {
			if (next !== "x") versionDependent = true;
			const hex = scanWhile(body, i + 2, /[0-9a-fA-F]/, next === "x" ? 2 : next === "u" ? 4 : 8);
			if (hex) {
				decoded = String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff));
				width = 2 + hex.length;
			}
		} else if (next === "c" && i + 2 < body.length) {
			const target = body[i + 2];
			if (target === "?" || target === "\\") versionDependent = true;
			decoded = target === "?" ? "\x7f" : String.fromCharCode(target.toUpperCase().charCodeAt(0) & 0x1f);
			width = 3;
		}
		if (decoded === undefined) {
			emit(ch);
			continue;
		}
		if (decoded === "\0") truncated = true;
		else emit(decoded);
		i += width - 1;
	}
	return { text: out, end: body.length, versionDependent };
}

/** Nodes that are commands or hold commands; everything else in command position is a word. */
const STATEMENTS = new Set([
	"program",
	"list",
	"pipeline",
	"redirected_statement",
	"command",
	"declaration_command",
	"unset_command",
	"test_command",
	"variable_assignment",
	"variable_assignments",
	"negated_command",
	"subshell",
	"compound_statement",
	"for_statement",
	"c_style_for_statement",
	"while_statement",
	"if_statement",
	"elif_clause",
	"else_clause",
	"case_statement",
	"case_item",
	"do_group",
	"function_definition",
]);

/** Constructs the pre-gate does not model, and how its escalation note names them. */
const COMPLEX: Record<string, string> = {
	subshell: "runs commands in a ( … ) subshell",
	compound_statement: "groups commands in { … }",
	for_statement: "uses a for loop",
	c_style_for_statement: "uses a for loop",
	while_statement: "uses a while/until loop",
	if_statement: "uses an if statement",
	case_statement: "uses a case statement",
	function_definition: "defines a shell function",
	test_command: "uses a [ ]/[[ ]] test",
	declaration_command: "declares or exports variables",
	unset_command: "unsets variables",
	arithmetic_expansion: "uses $(( )) arithmetic expansion",
	brace_expression: "uses brace expansion, whose expanded paths cannot be checked",
};

/** Constructs recorded in `Segment.enclosing`. */
const ENCLOSING = new Set([
	...Object.keys(COMPLEX),
	"elif_clause",
	"else_clause",
	"case_item",
	"do_group",
	"negated_command",
	"command_substitution",
	"process_substitution",
]);

const LOCALE_QUOTING = 'uses $"…" locale quoting, whose translation this check cannot see';

interface Context {
	enclosing: string[];
	scopes: number[];
	/** The outermost substitution the walk is inside, as an index into `Walker.substitutions`. */
	substitution?: number;
	/** Inside the last member of a multi-command pipeline (`Segment.lastInPipeline`). */
	lastInPipeline?: boolean;
}

class Walker {
	readonly segments: (Segment & { start: number })[] = [];
	unknownQuoting: string | undefined;
	complex: string | undefined;
	background = false;
	/** Set when a part parsed on its own (a heredoc's backtick body) did not parse. */
	failed = false;
	readonly substitutions: string[] = [];
	private nextScope = 1;
	private readonly source: string;

	constructor(source: string) {
		this.source = source;
	}

	private markComplex(type: string): void {
		this.complex ??= COMPLEX[type] ?? `uses ${type.replace(/_/g, " ")}, which this check does not model`;
	}

	private enter(ctx: Context, node: SyntaxNode, subshell: boolean): Context {
		return {
			enclosing: ENCLOSING.has(node.type) ? [...ctx.enclosing, node.type] : ctx.enclosing,
			scopes: subshell ? [...ctx.scopes, this.nextScope++] : ctx.scopes,
			substitution: ctx.substitution,
			lastInPipeline: ctx.lastInPipeline,
		};
	}

	/** Enter a command or process substitution whose command text is `body`. */
	private enterSubstitution(ctx: Context, type: string, body: string): Context {
		const inner = this.enter(ctx, { type } as SyntaxNode, true);
		if (inner.substitution === undefined) {
			inner.substitution = this.substitutions.length;
			this.substitutions.push(body);
		}
		return inner;
	}

	/** Walk a node that holds commands. */
	statement(node: SyntaxNode, ctx: Context): void {
		switch (node.type) {
			case "comment":
				return;
			case "program":
			case "list":
				for (const child of node.children) {
					if (child.type === "&") this.background = true;
					else if (child.isNamed) this.statement(child, ctx);
				}
				return;
			case "pipeline": {
				const members = node.namedChildren.filter((child) => child.type !== "comment");
				for (const [index, child] of members.entries()) {
					if (members.length === 1) {
						this.statement(child, ctx);
						continue;
					}
					const member = this.enter(ctx, node, true);
					if (index === members.length - 1) member.lastInPipeline = true;
					this.statement(child, member);
				}
				return;
			}
			case "redirected_statement":
				this.redirected(node, ctx);
				return;
			case "command":
			case "declaration_command":
			case "unset_command":
			case "test_command":
			case "variable_assignment":
			case "variable_assignments":
				this.simple(node, [], ctx);
				return;
			case "negated_command":
				for (const child of node.namedChildren) this.statement(child, this.enter(ctx, node, false));
				return;
			case "subshell":
				this.markComplex(node.type);
				this.container(node, this.enter(ctx, node, true));
				return;
			case "ERROR":
				this.container(node, ctx);
				return;
			default:
				if (!STATEMENTS.has(node.type)) {
					// A word in statement position (a `for` list, a `case` subject):
					// only the commands it substitutes matter.
					this.word(node, ctx);
					return;
				}
				this.markComplex(node.type);
				this.container(node, this.enter(ctx, node, false));
		}
	}

	/** Walk every child of a construct: statements as statements, words for their substitutions. */
	private container(node: SyntaxNode, ctx: Context): void {
		for (const child of node.children) {
			if (child.type === "&") this.background = true;
			else if (child.isNamed) this.statement(child, ctx);
		}
	}

	private redirected(node: SyntaxNode, ctx: Context): void {
		const body = node.childForFieldName("body");
		// Node objects are fresh wrappers on every access: compare ids, not identity.
		const redirects = node.children.filter((child) => child.id !== body?.id && child.isNamed && child.type !== "comment");
		if (body && (body.type === "command" || body.type === "declaration_command" || body.type === "unset_command" || body.type === "test_command" || body.type === "variable_assignment")) {
			this.simple(body, redirects, ctx);
			return;
		}
		// A bare redirect (`> f`) or one on a compound command (`{ …; } > f`,
		// `while …; done < f`): the redirect is a segment of its own.
		if (body) this.statement(body, ctx);
		this.simple(undefined, redirects, ctx, redirects[0]?.startIndex ?? node.startIndex);
	}

	/**
	 * One simple command, with the redirects that apply to it. `node` is
	 * undefined for a redirect-only segment.
	 */
	private simple(node: SyntaxNode | undefined, outerRedirects: SyntaxNode[], ctx: Context, at = node?.startIndex ?? 0): void {
		const segment: Segment & { start: number } = { tokens: [], redirects: [], inputs: [], raw: "", enclosing: ctx.enclosing, scopes: ctx.scopes, start: at };
		if (ctx.substitution !== undefined) segment.substitution = ctx.substitution;
		if (ctx.lastInPipeline) segment.lastInPipeline = true;
		if (node?.type === "variable_assignment" || node?.type === "variable_assignments") {
			// A line that only assigns: `a=1`, `a=1 b=2`.
			const assignments = node.type === "variable_assignment" ? [node] : node.namedChildren.filter((child) => child.type === "variable_assignment");
			for (const assignment of assignments) segment.tokens.push(this.assignment(assignment, ctx));
		} else if (node) {
			if (node.type in COMPLEX) this.markComplex(node.type);
			let locale = false;
			for (const child of node.children) {
				if (child.type === "$") {
					// `$"…"`: the grammar leaves the `$` outside the string node.
					locale = true;
					continue;
				}
				if (!child.isNamed) {
					// The keyword of `export`/`unset`/`[[`: part of the command's words.
					if (node.type !== "command" && /^[A-Za-z[\]]/.test(child.type)) segment.tokens.push({ value: child.text, hadExpansion: false });
					continue;
				}
				if (child.type === "comment") continue;
				if (child.type === "file_redirect") {
					this.redirect(child, segment, ctx);
					continue;
				}
				if (child.type === "herestring_redirect") {
					this.redirect(child, segment, ctx);
					continue;
				}
				if (child.type === "variable_assignment") {
					segment.tokens.push(this.assignment(child, ctx));
					continue;
				}
				// `[[ -f x ]]`: its expressions are words for the deny forms.
				if (child.type.endsWith("_expression") && node.type === "test_command") {
					for (const leaf of leaves(child)) segment.tokens.push(this.word(leaf, ctx));
					continue;
				}
				const target = child.type === "command_name" ? (child.firstNamedChild ?? child) : child;
				const word = this.word(target, ctx);
				if (locale && target.type === "string") {
					this.unknownQuoting ??= LOCALE_QUOTING;
					word.hadExpansion = true;
				}
				locale = false;
				segment.tokens.push(word);
			}
		}
		for (const redirect of outerRedirects) this.redirect(redirect, segment, ctx);
		segment.raw = this.rawText(node, outerRedirects, at);
		this.segments.push(segment);
	}

	/** The source of a command plus its own redirects, a heredoc cut at its delimiter word. */
	private rawText(node: SyntaxNode | undefined, redirects: SyntaxNode[], at: number): string {
		let end = node?.endIndex ?? at;
		for (const redirect of redirects) {
			if (redirect.type === "heredoc_redirect") {
				// Up to the delimiter word, and any redirect after it (`cat <<EOF > f`),
				// but not the body or a pipeline the grammar nests there.
				for (const child of redirect.children) {
					if (child.type === "heredoc_start" || child.type === "file_redirect" || child.type === "herestring_redirect") end = Math.max(end, child.endIndex);
				}
			} else {
				end = Math.max(end, redirect.endIndex);
			}
		}
		return this.source.slice(node?.startIndex ?? at, end).trim();
	}

	private assignment(node: SyntaxNode, ctx: Context): Token {
		const value = node.childForFieldName("value");
		const operator = node.children.find((child) => !child.isNamed && (child.type === "=" || child.type === "+="));
		const name = node.childForFieldName("name")?.text ?? "";
		if (!value) return { value: `${name}${operator?.type ?? "="}`, hadExpansion: false };
		const word = this.word(value, ctx);
		return { value: `${name}${operator?.type ?? "="}${word.value}`, hadExpansion: word.hadExpansion, glob: word.glob, dynamic: word.dynamic };
	}

	private redirect(node: SyntaxNode, segment: Segment, ctx: Context): void {
		if (node.type === "heredoc_redirect") {
			this.heredoc(node, segment, ctx);
			return;
		}
		if (node.type === "herestring_redirect") {
			for (const part of node.namedChildren) {
				const word = this.word(part, ctx);
				if (word.dynamic === "variable") segment.expandsIntoInput = true;
				(segment.stdin ??= []).push(word.value);
			}
			return;
		}
		if (node.type !== "file_redirect") {
			this.statement(node, ctx);
			return;
		}
		const operator = node.children.find((child) => !child.isNamed)?.type ?? "";
		const destinations = node.childrenForFieldName("destination");
		const [target, ...rest] = destinations;
		// The grammar hangs every word after the target on the redirect; in bash
		// they are the command's own arguments (`cmd 2>/dev/null arg`).
		for (const word of rest) segment.tokens.push(this.word(word, ctx));
		if (!target) return; // `>&-`, `<&-`: close a descriptor.
		const word = this.word(target, ctx);
		if (word.dynamic) segment.unknownTarget = true;
		// `>&2`, `<&3`, `>&-`: descriptor duplication, no file involved.
		const duplication = (operator === ">&" || operator === "<&") && /^[0-9]*-?$/.test(word.value) && word.value !== "";
		if (duplication) return;
		if (operator === "<" || operator === "<&") segment.inputs.push(word);
		else segment.redirects.push(word.value);
	}

	private heredoc(node: SyntaxNode, segment: Segment, ctx: Context): void {
		// A quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<E\OF`) makes the body literal.
		const start = node.namedChildren.find((child) => child.type === "heredoc_start");
		const literal = !start || /['"\\]/.test(start.text);
		for (const child of node.namedChildren) {
			if (child.type === "heredoc_start" || child.type === "heredoc_end") continue;
			if (child.type === "heredoc_body") {
				(segment.stdin ??= []).push(child.text);
				if (literal) continue;
				for (const part of child.namedChildren) {
					if (part.type !== "heredoc_content" && this.word(part, ctx).dynamic === "variable") segment.expandsIntoInput = true;
				}
				this.heredocBackticks(child, ctx);
				continue;
			}
			// `cat <<EOF > out`, `cat <<EOF | sh`: the grammar nests the rest of the
			// line inside the heredoc redirect.
			if (child.type === "file_redirect" || child.type === "herestring_redirect") this.redirect(child, segment, ctx);
			else this.statement(child, ctx);
		}
	}

	/**
	 * The grammar parses `$(…)` in an unquoted heredoc body but leaves
	 * backticks as plain text (findings §30), though bash runs them. The body's
	 * text outside its parsed expansions is scanned, each backtick body parsed
	 * on its own, and its commands join the segments.
	 */
	private heredocBackticks(body: SyntaxNode, ctx: Context): void {
		let text = "";
		let at = body.startIndex;
		for (const part of body.namedChildren) {
			if (part.type === "heredoc_content") continue;
			// A parsed expansion is blanked out, keeping every other offset.
			text += this.source.slice(at, part.startIndex) + " ".repeat(part.endIndex - part.startIndex);
			at = part.endIndex;
		}
		text += this.source.slice(at, body.endIndex);
		for (let i = 0; i < text.length; i++) {
			if (text[i] === "\\") {
				i++;
				continue;
			}
			if (text[i] !== "`") continue;
			let end = i + 1;
			while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
			if (end >= text.length) {
				// An unterminated backtick: bash reports a syntax error.
				this.failed = true;
				return;
			}
			const inner = parseCommand(text.slice(i + 1, end));
			const scope = this.enterSubstitution(ctx, "command_substitution", text.slice(i + 1, end));
			for (const segment of inner.segments) {
				this.segments.push({
					...segment,
					enclosing: [...scope.enclosing, ...segment.enclosing],
					scopes: [...scope.scopes, ...segment.scopes],
					substitution: scope.substitution,
					start: body.startIndex + i,
				});
			}
			this.unknownQuoting ??= inner.unknownQuoting;
			this.complex ??= inner.complex;
			this.background ||= inner.background;
			// `echo hi <> f` in the backticks is as unparseable as it is on its own line.
			this.failed ||= inner.parseFailed;
			i = end;
		}
	}

	/** Read a word node: its value, and the commands it substitutes. */
	word(node: SyntaxNode, ctx: Context): Token {
		// Punctuation the grammar keeps as its own node (a `$` before a closing
		// quote) is literal text.
		if (!node.isNamed) return { value: node.text, hadExpansion: false };
		switch (node.type) {
			case "word":
				return unquotedWord(node.text);
			case "number":
				return { value: node.text, hadExpansion: false };
			case "raw_string":
				return { value: node.text.slice(1, -1), hadExpansion: false };
			case "ansi_c_string": {
				const decoded = decodeAnsiC(node.text, 2);
				if (decoded.versionDependent) this.unknownQuoting ??= "uses a $'…' escape (\\u, \\U or \\c?) whose meaning depends on the bash version";
				return { value: decoded.text, hadExpansion: true };
			}
			case "string": {
				let value = "";
				let dynamic: Dynamic | undefined;
				for (const child of node.children) {
					if (child.type === '"') continue;
					if (child.type === "string_content") {
						value += doubleQuoted(child.text);
						continue;
					}
					const piece = this.word(child, ctx);
					value += piece.value;
					// Quoted, `"<(x)"` is the literal text, never a pipe path.
					dynamic = mergeDynamic(dynamic, piece.dynamic === "process-input" ? undefined : piece.dynamic);
				}
				return { value, hadExpansion: false, dynamic };
			}
			case "concatenation": {
				let value = "";
				let glob = false;
				let hadExpansion = false;
				let dynamic: Dynamic | undefined;
				let locale = false;
				const pieces = node.children;
				for (const child of pieces) {
					if (child.type === "$") {
						locale = true;
						continue;
					}
					const piece = this.word(child, ctx);
					if (locale) {
						// `x$"y"` is locale quoting; any other `$` is literal (`x$`).
						if (child.type === "string") {
							this.unknownQuoting ??= LOCALE_QUOTING;
							hadExpansion = true;
						} else value += "$";
						locale = false;
					}
					value += piece.value;
					glob ||= !!piece.glob;
					hadExpansion ||= piece.hadExpansion;
					// Joined to other text, a process substitution's pipe path is part of an unknown word.
					dynamic = mergeDynamic(dynamic, piece.dynamic === "process-input" ? "substitution" : piece.dynamic);
				}
				if (locale) value += "$";
				// `{a,b}` is three plain words to the grammar; bash expands it.
				if (pieces.some((child) => child.type === "word" && child.text === "{") && pieces.some((child) => child.type === "word" && child.text.includes(","))) {
					this.markComplex("brace_expression");
				}
				return { value, hadExpansion, glob: glob || undefined, dynamic };
			}
			case "command_substitution":
			case "process_substitution": {
				// The command text between `$(`/`<(`/`>(` or a backtick and the close.
				const opener = node.text.startsWith("`") ? 1 : 2;
				this.container(node, this.enterSubstitution(ctx, node.type, node.text.slice(opener, -1)));
				const dynamic: Dynamic = node.type === "process_substitution" && node.text.startsWith("<(") ? "process-input" : "substitution";
				return { value: node.text, hadExpansion: false, dynamic };
			}
			case "simple_expansion":
			case "expansion":
			case "variable_name":
			case "special_variable_name":
				// `${x:-$(cmd)}`: the default's command still runs.
				for (const child of node.namedChildren) if (child.type !== "variable_name" && child.type !== "special_variable_name") this.word(child, ctx);
				return { value: node.text, hadExpansion: false, dynamic: "variable" };
			default:
				// Arithmetic, brace expansion and anything unrecognised: unknown value.
				this.markComplex(node.type);
				for (const child of node.namedChildren) {
					if (STATEMENTS.has(child.type)) this.statement(child, ctx);
					else this.word(child, ctx);
				}
				return { value: node.text, hadExpansion: false, dynamic: "variable" };
		}
	}
}

/** The named leaves of a test expression, in order. */
function leaves(node: SyntaxNode): SyntaxNode[] {
	if (node.namedChildCount === 0 || !node.type.endsWith("_expression")) return [node];
	return node.namedChildren.flatMap(leaves);
}

/** An unquoted word: backslash escapes applied, a line continuation removed, globs noticed. */
function unquotedWord(text: string): Token {
	let value = "";
	let glob = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\" && i + 1 < text.length) {
			if (text[i + 1] !== "\n") value += text[i + 1];
			i++;
			continue;
		}
		if (ch === "*" || ch === "?" || ch === "[") glob = true;
		value += ch;
	}
	return { value, hadExpansion: false, glob: glob || undefined };
}

/** Double-quoted text: a backslash escapes only `$`, `` ` ``, `"`, `\` and a newline. */
function doubleQuoted(text: string): string {
	return text.replace(/\\([$`"\\\n])/g, (_, ch: string) => (ch === "\n" ? "" : ch));
}

/**
 * A value tracked per subshell scope (`Segment.scopes`), such as the
 * directory a `cd` sets. A scope starts with its parent's current value, and
 * setting it never reaches the parent or a sibling: in `echo "$(cd /tmp)";
 * cat x`, `x` is still read from the starting directory. Segments must be
 * visited in source order.
 */
export function scopedTracker<T>(initial: T): { get(segment: Pick<Segment, "scopes">): T; set(segment: Pick<Segment, "scopes">, value: T): void } {
	const values = new Map<string, T>([["", initial]]);
	return {
		get(segment) {
			for (let n = segment.scopes.length; n >= 0; n--) {
				const key = segment.scopes.slice(0, n).join(".");
				if (values.has(key)) return values.get(key) as T;
			}
			return initial;
		},
		set(segment, value) {
			values.set(segment.scopes.join("."), value);
		},
	};
}

/** Loop constructs, as `Segment.enclosing` names them: their bodies run more than once. */
export const LOOPS = new Set(["for_statement", "c_style_for_statement", "while_statement"]);

/**
 * Split a command into its simple commands (see the module header). Returns
 * `parseFailed` with no segments while the grammar is not loaded.
 */
export function parseCommand(command: string): ParseResult {
	const tree = parseBash(command);
	if (!tree) return { segments: [], parseFailed: true, unavailable: bashParserUnavailable(), background: false, substitutions: [] };
	try {
		const walker = new Walker(command);
		walker.statement(tree.rootNode, { enclosing: [], scopes: [] });
		const segments = walker.segments
			.filter((segment) => segment.tokens.length > 0 || segment.redirects.length > 0 || segment.inputs.length > 0)
			.sort((a, b) => a.start - b.start)
			.map(({ start: _start, ...segment }) => segment);
		return {
			segments,
			parseFailed: tree.rootNode.hasError || walker.failed,
			unknownQuoting: walker.unknownQuoting,
			complex: walker.complex,
			background: walker.background,
			substitutions: walker.substitutions,
		};
	} finally {
		tree.delete();
	}
}
