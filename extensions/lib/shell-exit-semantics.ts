/**
 * Claude Code's semantic exit codes (pure): a nonzero exit that is not an
 * error, such as grep's "no matches" or diff's "files differ", which Claude
 * Code reports as plain output with no `Exit code N` line. Bash and
 * PowerShell keep separate tables and separate last-command rules.
 */
import { parseBash } from "./bash-parser.ts";

type BashNode = NonNullable<ReturnType<typeof parseBash>>["rootNode"];
const CONTAINERS = new Set(["program", "list", "pipeline"]);
const OPERATORS = new Set(["&&", "||", "|", ";", "&", "|&", "\n"]);
const EXIT_ONE_SUCCESSES = new Set(["grep", "rg", "egrep", "fgrep", "find", "diff", "test", "["]);

/**
 * The rightmost command's text, or undefined when an `&&` precedes it: a failed
 * earlier step can explain the exit, not the final search. Redirects and
 * comments are skipped, as Claude Code's last-command walk does.
 */
function lastCommand(root: BashNode): string | undefined {
	let node: BashNode | undefined = root;
	while (node && (CONTAINERS.has(node.type) || node.type === "redirected_statement")) {
		const children: BashNode[] = node.children;
		const last = children.findLastIndex((child) => !OPERATORS.has(child.type) && child.type !== "comment" && !child.type.endsWith("_redirect"));
		if (node.type === "list" && children[last - 1]?.type === "&&") return undefined;
		node = children[last];
	}
	return node?.text;
}

/** Bash: exit 1 from a final grep, rg, egrep, fgrep, find, diff, test, `[` or git grep/diff. */
export function bashExitOneIsSuccess(command: string): boolean {
	if (command.length > 10_000) return false;
	const tree = parseBash(command);
	if (!tree) return false;
	try {
		if (tree.rootNode.type !== "program") return false;
		const last = lastCommand(tree.rootNode);
		if (last === undefined) return false;
		// Claude Code matches the literal first word: no unwrapping of env, assignments or quotes.
		const words = last.trim().split(/\s+/);
		if (words[0] !== "git") return EXIT_ONE_SUCCESSES.has(words[0]);
		for (let i = 1; i < words.length; i++) {
			if (words[i].startsWith("-")) {
				if (words[i] === "-C" || words[i] === "-c") i++;
				continue;
			}
			return words[i] === "grep" || words[i] === "diff";
		}
		return false;
	} finally {
		tree.delete();
	}
}

// PowerShell. The last segment splits on `;`, `|`, newlines, `&&` and a
// spaced `&`, outside quotes and comments; `&&` before it means an earlier
// step can explain the exit.
type Segment = { text: string; andGated: boolean };

function lastSegment(command: string): Segment {
	const segments: Segment[] = [];
	let start = 0;
	let andGated = false;
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (inSingle) {
			if (c === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (c === "`") i++;
			else if (c === '"') inDouble = false;
			continue;
		}
		if (c === "#" && (i === 0 || " \t\n\r".includes(command[i - 1]))) {
			segments.push({ text: command.slice(start, i), andGated });
			while (i + 1 < command.length && command[i + 1] !== "\n" && command[i + 1] !== "\r") i++;
			start = i + 1;
			continue;
		}
		if (c === "'") {
			inSingle = true;
			continue;
		}
		if (c === '"') {
			inDouble = true;
			continue;
		}
		if (c === ";" || c === "|" || c === "\n" || c === "\r") {
			segments.push({ text: command.slice(start, i), andGated });
			start = i + 1;
			if (c !== "|") andGated = false;
			continue;
		}
		if (c === "&") {
			if (command[i + 1] === "&") {
				segments.push({ text: command.slice(start, i), andGated });
				i++;
				start = i + 1;
				andGated = true;
				continue;
			}
			const before = command[i - 1];
			if ((before === " " || before === "\t") && command.slice(start, i).trim() !== "") {
				segments.push({ text: command.slice(start, i), andGated });
				start = i + 1;
				andGated = false;
			}
		}
	}
	segments.push({ text: command.slice(start), andGated });
	return segments.findLast((segment) => segment.text.trim()) ?? { text: command, andGated: false };
}

/** The command's file name, lowercased, without a native .exe/.cmd/.bat extension. */
function baseCommand(segment: string): { base: string; nativeExt: string | undefined } {
	const line = segment.trim().replace(/^[&.]\s+/, "");
	const quoted = /^"([^"]*)"|^'([^']*)'/.exec(line);
	const word = quoted?.[1] ?? quoted?.[2] ?? (line.split(/\s+/)[0] || "").replace(/^["']|["']$/g, "");
	const file = (word.split(/[\\/]/).pop() || word).toLowerCase();
	const nativeExt = ["exe", "cmd", "bat"].find((ext) => file.endsWith(`.${ext}`));
	return { base: nativeExt ? file.slice(0, -(nativeExt.length + 1)) : file, nativeExt };
}

function gitSubcommand(segment: string): string | undefined {
	let line = segment.trim().replace(/^[&.]\s+/, "");
	const first = /^"[^"]*"|^'[^']*'/.exec(line)?.[0] ?? line.split(/\s+/)[0] ?? "";
	if (baseCommand(first).base !== "git") return undefined;
	line = line.slice(first.length);
	const words = ["git", ...line.trim().split(/\s+/).filter(Boolean)];
	for (let i = 1; i < words.length; i++) {
		if (words[i].startsWith("-")) {
			if (words[i] === "-C" || words[i] === "-c") i++;
			continue;
		}
		return words[i];
	}
	return undefined;
}

const exitOneOk = (code: number) => code === 0 || code === 1;
const POWERSHELL_SEMANTICS = new Map<string, (code: number) => boolean>([
	["grep", exitOneOk],
	["rg", exitOneOk],
	["egrep", exitOneOk],
	["fgrep", exitOneOk],
	["findstr", exitOneOk],
	["robocopy", (code) => code >= 0 && code < 8],
]);
// Only as `<name>.exe` with output: bare `where` is Where-Object, bare `fc` Format-Custom.
const POWERSHELL_EXE_WITH_OUTPUT = new Map<string, (code: number) => boolean>([
	["where", exitOneOk],
	["fc", exitOneOk],
	["diff", exitOneOk],
]);
const NOT_RECOGNIZED = /is not recognized as (a name of a cmdlet|the name of a cmdlet|an? internal)/i;

/** PowerShell: a nonzero exit the final command's table calls success. `output` is stdout and stderr merged. */
export function powershellExitIsSuccess(command: string, exitCode: number, output: string): boolean {
	if (exitCode === 0) return true;
	const { text, andGated } = lastSegment(command);
	const { base, nativeExt } = baseCommand(text);
	const sub = base === "git" ? gitSubcommand(text) : undefined;
	const ok =
		sub === "grep" || sub === "diff"
			? exitOneOk
			: ((nativeExt === "exe" && output.trim() !== "" ? POWERSHELL_EXE_WITH_OUTPUT.get(base) : undefined) ?? POWERSHELL_SEMANTICS.get(base));
	if (!ok?.(exitCode)) return false;
	// A command that never ran, or findstr's own error, is a failure after all.
	return !(andGated || NOT_RECOGNIZED.test(output) || /CommandNotFoundException/.test(output) || /^FINDSTR: /m.test(output));
}
