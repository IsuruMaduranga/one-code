/**
 * Claude Code's shell result text, made from pi's (pure). pi ends a failing
 * command's output with `\n\nCommand exited with code N` and keeps the
 * output's trailing newline; Claude Code starts a failure with `Exit code N`
 * on its own line and trims the output's leading blank lines and trailing
 * whitespace, and an empty success reads `(<tool> completed with no output)`.
 * pi's truncation notes stay where they are, at the end of the output.
 */

type Block = { type: string; text?: string };
type ShellResult = { content?: Block[]; structuredContent?: unknown; isError?: boolean };

/** pi's text for an empty output. */
const PI_NO_OUTPUT = "(no output)";

/** Claude Code's text for one foreground result, or undefined to keep pi's. */
export function claudeCodeShellText(text: string, exitCode: unknown, toolName: string): string | undefined {
	if (typeof exitCode !== "number") return undefined;
	if (exitCode === 0) {
		if (text === PI_NO_OUTPUT) return `(${toolName} completed with no output)`;
		return text.replace(/^(\s*\n)+/, "").trimEnd();
	}
	const status = `Command exited with code ${exitCode}`;
	if (text !== status && !text.endsWith(`\n\n${status}`)) return undefined;
	const output = text.slice(0, Math.max(0, text.length - status.length - 2));
	return (output === PI_NO_OUTPUT || output === "" ? `Exit code ${exitCode}` : `Exit code ${exitCode}\n${output}`).trimEnd();
}

/** A foreground result with its first text block in Claude Code's words; other results pass through. */
export function withClaudeCodeShellText<R extends ShellResult>(result: R, toolName: string): R {
	const first = result?.content?.[0];
	if (first?.type !== "text" || typeof first.text !== "string") return result;
	const exitCode = (result.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
	const text = claudeCodeShellText(first.text, exitCode, toolName);
	if (text === undefined || text === first.text) return result;
	return { ...result, content: [{ ...first, text }, ...(result.content ?? []).slice(1)] };
}
