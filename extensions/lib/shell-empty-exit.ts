/** Claude Code's semantic-success exit 1 guard, for otherwise empty Bash output. */
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

export function emptyBashExitOneIsSuccess(command: string): boolean {
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
