/**
 * One Code's language-server text (the profile's `text.lsp`): the
 * lsp_diagnostics tool, its results and failures, and the new-diagnostics
 * block (Claude Code's `<new-diagnostics>` shape).
 */

import type { LspFailure, LspText, ShownDiagnostic } from "../../../extensions/lsp/text.ts";

const PROJECT_CODE_REASON: Record<string, string> = {
	"rust-analyzer": "runs this project's build scripts and proc macros",
	jdtls: "runs this project's Gradle or Maven build to import it",
};
const projectCodeReason = (command: string) => PROJECT_CODE_REASON[command] ?? "runs this project's code";

const SYMBOLS: Record<ShownDiagnostic["severity"], string> = { error: "✘", warning: "⚠", info: "ℹ", hint: "★" };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const configuredBy = (plugin?: string) => (plugin ? ` (configured by the ${plugin} plugin)` : "");

function failure(f: LspFailure): string {
	switch (f.kind) {
		case "error":
			return f.osMessage;
		case "spawnFailed":
			return `Could not start ${f.command}: ${f.osMessage}`;
		case "notInstalled":
			return f.installHint
				? `${f.command} is not installed${configuredBy(f.plugin)}. Install it with: ${f.installHint}`
				: `${f.command} is not installed${configuredBy(f.plugin)}. Install it and make sure it is on your PATH${f.plugin ? " (the plugin's documentation should say how)" : ""}.`;
		case "missingPath":
			return `${f.command} does not exist${configuredBy(f.plugin)}. ${f.plugin ? "Check the plugin's installation." : "Check the configured path."}`;
		case "stoppedInput":
			return `${f.command} stopped accepting input: ${f.osMessage}`;
		case "exited":
			return `${f.command} exited (${f.signal ?? `code ${f.code}`})${f.detail ? `: ${f.detail}` : ""}`;
		case "exitedQuietly":
			return "language server exited";
		case "timedOut":
			return `${f.method} timed out after ${f.ms}ms`;
		case "gaveUp":
			return `${f.reason ? failure(f.reason) : "language server stopped unexpectedly"} (gave up after ${f.restarts} restarts)`;
		case "noTypescript":
			return `No TypeScript installation is reachable from this project (typescript-language-server resolves \`typescript\` from the project's node_modules upward and never uses a global install). Run \`${f.install}\` in the project for LSP diagnostics.`;
		case "noTsserver":
			return `The project's TypeScript has no lib/tsserver.js (TypeScript 7's native compiler removed it), so typescript-language-server cannot analyse this project. Run \`${f.install}\` for LSP diagnostics.`;
		case "notTrusted":
			return `not started: ${f.command} ${projectCodeReason(f.command)}, and this project is not trusted (run /lsp trust to allow it)`;
	}
}

const codeAndSource = (d: ShownDiagnostic, code: (c: string | number) => string, source: (s: string) => string) =>
	`${d.code !== undefined ? code(d.code) : ""}${d.source ? source(d.source) : ""}`;

export const lsp: LspText = {
	description:
		"Ask the language server for diagnostics (type errors, warnings) on a file. Reflects the file's current contents. Supported: TypeScript/JavaScript, Python, Go, Rust, Java — plus any language a plugin's .lsp.json configures — when that language's server is installed.",
	params: {
		path: "File to analyse (absolute or workspace-relative)",
		severity: "Minimum severity (default: all)",
	},
	projectCodeReason,
	cancelled: "Diagnostics cancelled because the turn was stopped.",
	noServer: ({ languageId, command, installHint }) =>
		`No language server available for ${languageId}. ${installHint ? `Install it with: ${installHint}` : `Install ${command}.`}`,
	notConfigured: "No language server is configured for this file type.",
	failure,
	diagnostics: {
		none: "No diagnostics.",
		summary: ({ errors, warnings, total }) =>
			[errors ? plural(errors, "error") : "", warnings ? plural(warnings, "warning") : ""].filter(Boolean).join(", ") || `${total} diagnostics`,
		line: ({ path, diagnostic: d }) =>
			`${path}:${d.line}:${d.column} ${d.severity}: ${d.message}${codeAndSource(d, (c) => ` (${c})`, (s) => ` [${s}]`)}`,
		more: (count) => `… ${count} more`,
	},
	newDiagnostics: {
		entry: (d) => `  ${SYMBOLS[d.severity]} [Line ${d.line}:${d.column}] ${d.message}${codeAndSource(d, (c) => ` [${c}]`, (s) => ` (${s})`)}`,
		section: ({ path, entries }) => `${path}:\n${entries.join("\n")}`,
		more: (count) => `… ${count} more`,
		cut: (head) => `${head}…[truncated]`,
		block: (body) => `<new-diagnostics>The following new diagnostic issues were detected:\n\n${body}\n</new-diagnostics>`,
	},
};
