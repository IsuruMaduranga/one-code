/**
 * What the language-server tool needs from a profile (types only). The
 * extension decides what happened; the profile words it
 * (working-docs/features/profiles/). The caps on the new-diagnostics block
 * stay in the base; the profile words its framing, entries and cut label.
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
