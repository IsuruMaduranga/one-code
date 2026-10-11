/**
 * Claude Code's shell result text, made from pi's (pure). pi ends a failing
 * command's output with `\n\nCommand exited with code N` and keeps the
 * output's trailing newline; Claude Code starts a failure with `Exit code N`
 * on its own line and trims the output's leading blank lines and trailing
 * whitespace, and an empty success reads `(<tool> completed with no output)`.
 * A nonzero exit Claude Code's semantics call success (grep's no match, a
 * diff that found differences) reads as a success. pi's truncation notes
 * stay where they are, at the end of the output.
 */

import { emptyToolResultText } from "./empty-tool-result.ts";
import { bashExitOneIsSuccess, powershellExitIsSuccess } from "./shell-exit-semantics.ts";

type Block = { type: string; text?: string };
type ShellResult = { content?: Block[]; structuredContent?: unknown; isError?: boolean };

/** pi's text for an empty output. */
const PI_NO_OUTPUT = "(no output)";

function successText(output: string, toolName: string): string {
	if (output === PI_NO_OUTPUT) return emptyToolResultText(toolName);
	return output.replace(/^(\s*\n)+/, "").trimEnd() || emptyToolResultText(toolName);
}

/** The output before pi's `Command exited with code N` trailer, or undefined when the text is not pi's failure shape. */
function failureOutput(text: string, exitCode: number): string | undefined {
	const status = `Command exited with code ${exitCode}`;
	if (text !== status && !text.endsWith(`\n\n${status}`)) return undefined;
	return text.slice(0, Math.max(0, text.length - status.length - 2));
}

/** Claude Code's failure text: `Exit code N`, then the output on its own lines. */
function failureText(output: string, exitCode: number): string {
	return (output === PI_NO_OUTPUT || output === "" ? `Exit code ${exitCode}` : `Exit code ${exitCode}\n${output}`).trimEnd();
}

/** Claude Code's text for one foreground result, or undefined to keep pi's. */
export function claudeCodeShellText(text: string, exitCode: unknown, toolName: string): string | undefined {
	if (typeof exitCode !== "number") return undefined;
	if (exitCode === 0) return successText(text, toolName);
	const output = failureOutput(text, exitCode);
	return output === undefined ? undefined : failureText(output, exitCode);
}

function semanticSuccess(toolName: string, command: string, exitCode: number, output: string): boolean {
	if (toolName === "bash") return exitCode === 1 && bashExitOneIsSuccess(command);
	if (toolName === "powershell") return powershellExitIsSuccess(command, exitCode, output === PI_NO_OUTPUT ? "" : output);
	return false;
}

/** A foreground result with its first text block in Claude Code's words; other results pass through. */
export function withClaudeCodeShellText<R extends ShellResult>(result: R, toolName: string, command: string): R {
	const first = result?.content?.[0];
	if (first?.type !== "text" || typeof first.text !== "string") return result;
	const exitCode = (result.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
	const rest = (result.content ?? []).slice(1);
	let text: string | undefined;
	if (typeof exitCode === "number" && exitCode !== 0) {
		const output = failureOutput(first.text, exitCode);
		if (output !== undefined && semanticSuccess(toolName, command, exitCode, output)) {
			return { ...result, content: [{ ...first, text: successText(output, toolName) }, ...rest], isError: false };
		}
		text = output === undefined ? undefined : failureText(output, exitCode);
	} else {
		text = claudeCodeShellText(first.text, exitCode, toolName);
	}
	if (text === undefined || text === first.text) return result;
	return { ...result, content: [{ ...first, text }, ...rest] };
}
