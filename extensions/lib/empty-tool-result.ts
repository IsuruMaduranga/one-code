/** Claude Code's empty tool_result guard and marker (toolResultStorage). */
import { ccToolName } from "../hooks/matcher.ts";

export function emptyToolResultText(toolName: string): string {
	return `(${ccToolName(toolName)} completed with no output)`;
}

/** Images and other non-text blocks are results, even without accompanying text. */
function isEmptyToolResultContent(content: unknown): boolean {
	if (!content) return true;
	if (typeof content === "string") return content.trim() === "";
	if (!Array.isArray(content)) return false;
	return content.every((block) => block !== null && typeof block === "object" && block.type === "text" &&
		"text" in block && (typeof block.text !== "string" || block.text.trim() === ""));
}

/** Replacement content, or undefined to retain the tool's own result verbatim. */
export function emptyToolResultContent(content: unknown, toolName: string): Array<{ type: "text"; text: string }> | undefined {
	const only = Array.isArray(content) && content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string" ? content[0] : undefined;
	// pi Read returns raw file bytes, not Claude Code's numbered lines. Leave
	// blank selections alone; file-tracker supplies the genuine empty-file warning.
	if (toolName === "read" && only) return undefined;
	if (isEmptyToolResultContent(content)) return [{ type: "text", text: emptyToolResultText(toolName) }];
	// pi's find is Claude Code's Glob; Grep already uses Claude Code's no-match text.
	if (toolName === "find" && only?.text === "No files found matching pattern") return [{ ...only, text: "No files found" }];
	return undefined;
}
