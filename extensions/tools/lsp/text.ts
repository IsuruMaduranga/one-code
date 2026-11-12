/**
 * The language-server tool's words. The extension decides what happened.
 * The profile words the tool itself (`LspText`: description, parameters);
 * the diagnostics, the failures and the new-diagnostics block's framing,
 * entries and cut label are here (`lspResultText`), with the block's caps
 * in the extension.
 */

/** Why a language server is not available, or stopped. */
export type LspFailure =
	/** The server's or the system's own message. */
	| { kind: "error"; osMessage: string }
	| { kind: "spawnFailed"; command: string; osMessage: string }
	/** The command is not on PATH; `plugin` names the plugin that configured it, `installHint` the built-in install command. */
	| { kind: "notInstalled"; command: string; plugin?: string; installHint?: string }
	/** An absolute command path that does not exist. */
	| { kind: "missingPath"; command: string; plugin?: string }
	| { kind: "stoppedInput"; command: string; osMessage: string }
	/** `detail`: the last lines of the server's stderr. */
	| { kind: "exited"; command: string; signal?: string; code?: number | null; detail?: string }
	/** The server exited with no failure recorded. */
	| { kind: "exitedQuietly" }
	| { kind: "timedOut"; method: string; ms: number }
	/** A server that kept crashing; `reason` is its last failure, when one was recorded. */
	| { kind: "gaveUp"; reason?: LspFailure; restarts: number }
	/** typescript-language-server cannot run here; `install` is the command that fixes it. */
	| { kind: "noTypescript"; install: string }
	| { kind: "noTsserver"; install: string }
	/** A server that runs the project's code, in a project not trusted. */
	| { kind: "notTrusted"; command: string };

/** One diagnostic as the texts show it (1-based line and column). */
export interface ShownDiagnostic {
	line: number;
	column: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	code?: string | number;
	source?: string;
}

export interface LspText {
	description: string;
	params: Record<"path" | "severity", string>;
}

/** The group's results, refusals and notes, which the base words (`lspResultText`). */
export interface LspResultText {
	/** What a server that runs project code runs (the trust dialog and the not-trusted failure). */
	projectCodeReason(command: string): string;
	cancelled: string;
	/** A language was recognised but no server is available and none failed. */
	noServer(p: { languageId: string; command: string; installHint?: string }): string;
	notConfigured: string;
	failure(failure: LspFailure): string;
	/** The tool's result. */
	diagnostics: {
		none: string;
		summary(p: { errors: number; warnings: number; total: number }): string;
		line(p: { path: string; diagnostic: ShownDiagnostic }): string;
		more(count: number): string;
	};
	/** The block new diagnostics ride in after a tool round. */
	newDiagnostics: {
		entry(diagnostic: ShownDiagnostic): string;
		section(p: { path: string; entries: readonly string[] }): string;
		more(count: number): string;
		/** The body past the cap: the kept head. */
		cut(head: string): string;
		block(body: string): string;
	};
}

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

/** The base's words of the group. */
export const lspResultText: LspResultText = {
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
