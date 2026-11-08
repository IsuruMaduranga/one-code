/**
 * Language-server diagnostics as a server publishes them, for the LSP tests
 * (lsp and One Code's lsp-wording).
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LspDiagnostic } from "../../../extensions/lsp/format.ts";

/** A diagnostic at a 0-indexed position; `severity` stays unset when not given, as a server may leave it. */
export const diag = (message: string, severity?: number, line = 0, character = 0, extra?: Partial<LspDiagnostic>): LspDiagnostic => ({
	message,
	severity,
	range: { start: { line, character } },
	...extra,
});

/** The project folder `/project` as this platform spells it (`D:\project` on Windows). */
export const PROJECT = resolve("/project");
/** A file URI for `/project/<name>`. */
export const uri = (name: string) => pathToFileURL(join(PROJECT, name)).href;
