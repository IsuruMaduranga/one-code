/**
 * One Code's language-server wording (profile/text/lsp/) for the texts the golden
 * snapshot cannot reach: a server that crashes, times out or is missing, a
 * TypeScript 7 project, a cancelled call, and the long-list and cut labels.
 * The golden snapshot pins the bytes of every other text; lsp.test.ts words
 * the not-installed failures.
 */
import { describe, expect, it } from "vitest";
import { lsp } from "../../profile/text/lsp/index.ts";

describe("One Code's language-server text", () => {
	it("words a server that fails after it started", () => {
		expect(lsp.failure({ kind: "spawnFailed", command: "gopls", osMessage: "EACCES" })).toBe("Could not start gopls: EACCES");
		expect(lsp.failure({ kind: "stoppedInput", command: "gopls", osMessage: "EPIPE" })).toBe("gopls stopped accepting input: EPIPE");
		expect(lsp.failure({ kind: "exited", command: "gopls", code: 2, detail: "panic" })).toBe("gopls exited (code 2): panic");
		expect(lsp.failure({ kind: "exited", command: "gopls", signal: "SIGKILL" })).toBe("gopls exited (SIGKILL)");
		expect(lsp.failure({ kind: "timedOut", method: "initialize", ms: 10000 })).toBe("initialize timed out after 10000ms");
		expect(lsp.failure({ kind: "gaveUp", restarts: 2 })).toBe("language server stopped unexpectedly (gave up after 2 restarts)");
		expect(lsp.failure({ kind: "gaveUp", reason: { kind: "exitedQuietly" }, restarts: 2 })).toBe("language server exited (gave up after 2 restarts)");
	});

	it("words a TypeScript 7 project and a project-code server's reason", () => {
		expect(lsp.failure({ kind: "noTsserver", install: "npm install -D typescript@5" })).toBe(
			"The project's TypeScript has no lib/tsserver.js (TypeScript 7's native compiler removed it), so typescript-language-server cannot analyse this project. Run `npm install -D typescript@5` for LSP diagnostics.",
		);
		expect(lsp.projectCodeReason("jdtls")).toBe("runs this project's Gradle or Maven build to import it");
		expect(lsp.projectCodeReason("other")).toBe("runs this project's code");
	});

	it("words the tool's other outcomes", () => {
		expect(lsp.cancelled).toBe("Diagnostics cancelled because the turn was stopped.");
		expect(lsp.noServer({ languageId: "go", command: "gopls", installHint: "go install golang.org/x/tools/gopls@latest" })).toBe(
			"No language server available for go. Install it with: go install golang.org/x/tools/gopls@latest",
		);
		expect(lsp.noServer({ languageId: "zig", command: "zls" })).toBe("No language server available for zig. Install zls.");
		expect(lsp.diagnostics.summary({ errors: 0, warnings: 0, total: 3 })).toBe("3 diagnostics");
	});

	it("labels what the new-diagnostics block leaves out", () => {
		expect(lsp.newDiagnostics.more(4)).toBe("… 4 more");
		expect(lsp.newDiagnostics.cut("head")).toBe("head…[truncated]");
		expect(lsp.newDiagnostics.entry({ line: 1, column: 2, severity: "hint", message: "m" })).toBe("  ★ [Line 1:2] m");
	});
});
