/** Claude Code's semantic-success exit 1 guard, for otherwise empty Bash output. */
import { parseBash } from "./bash-parser.ts";

type BashNode = NonNullable<ReturnType<typeof parseBash>>["rootNode"];
const CONTAINERS = new Set(["program", "list", "pipeline"]);
const OPERATORS = new Set(["&&", "||", "|", ";", "&", "|&", "\n"]);
const EXIT_ONE_SUCCESSES = new Set(["grep", "rg", "egrep", "fgrep", "find", "diff", "test", "["]);

function commandsIn(node: BashNode, commands: string[]): void {
	if (OPERATORS.has(node.type) || node.type === "comment") return;
	if (node.type === "redirected_statement") {
		for (const child of node.children) if (!child.type.endsWith("_redirect")) commandsIn(child, commands);
	} else if (CONTAINERS.has(node.type)) {
		for (const child of node.children) commandsIn(child, commands);
	} else commands.push(node.text);
}

/** A failed earlier && command can explain the exit, not the final search. */
function rightmostAndChain(root: BashNode): boolean {
	if (root.type !== "program") return true;
	let node: BashNode | undefined = root;
	while (node && (CONTAINERS.has(node.type) || node.type === "redirected_statement")) {
		const children: BashNode[] = node.children;
		const last = children.findLastIndex((child) => !OPERATORS.has(child.type) && child.type !== "comment" && !child.type.endsWith("_redirect"));
		if (node.type === "list" && children[last - 1]?.type === "&&") return true;
		node = children[last];
	}
	return false;
}

export function emptyBashExitOneIsSuccess(command: string): boolean {
	if (command.length > 10_000) return false;
	const tree = parseBash(command);
	if (!tree) return false;
	try {
		if (rightmostAndChain(tree.rootNode)) return false;
		const commands: string[] = [];
		commandsIn(tree.rootNode, commands);
		const words = (commands.at(-1) || command).trim().split(/\s+/);
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
