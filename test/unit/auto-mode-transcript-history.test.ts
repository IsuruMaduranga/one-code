import { describe, expect, it } from "vitest";
import { renderTranscript, type TranscriptEntry } from "../../extensions/auto-mode/transcript.ts";

// A cleanup later in the same session needs the calls that created its targets.
// Claude Code serializes the supplied history, not a 60 KB suffix.
describe("classifier creation history", () => {
	it.each(["read", "grep", "find", "lsp_diagnostics", "tool_search", "list_mcp_resources", "read_mcp_resource", "read_mcp_resource_dir"])("omits historical %s calls but keeps that tool as the current action", (tool) => {
		const read: TranscriptEntry = { kind: "tool", tool, input: { path: "OLD_READ_MARKER", query: "lookup" } };
		expect(renderTranscript([read, { kind: "tool", tool: "bash", input: { command: "rm probe.*" } }])).not.toContain("OLD_READ_MARKER");
		expect(renderTranscript([read])).toContain("OLD_READ_MARKER");
	});

	it("retains a historical remote-host read rather than hiding its destination", () => {
		expect(renderTranscript([
			{ kind: "tool", tool: "read", input: { path: "/secret", _host: "other-machine" } },
			{ kind: "tool", tool: "bash", input: { command: "echo done" } },
		])).toContain("other-machine");
	});

	it("retains early creation calls after seventy ordinary source writes", () => {
		const entries: TranscriptEntry[] = [
			{ kind: "user", text: "Investigate the RPC behavior in this scratch project." },
			{ kind: "tool", tool: "bash", input: { command: "cp -R seed .rpc-baseline" } },
			{ kind: "tool", tool: "write", input: { path: "test/unit/rpc-import-probe.test.ts", content: "export {};\n" } },
			{ kind: "tool", tool: "bash", input: { command: "printf '0\\n' > .rpc-cache.exit" } },
			...Array.from({ length: 70 }, (_, i): TranscriptEntry => ({
				kind: "tool", tool: "write", input: { path: `src/probe-${i}.ts`, content: "// source fixture\n".repeat(120) },
			})),
			{ kind: "tool", tool: "bash", input: { command: "rm -rf .rpc-baseline; rm test/unit/rpc-import-probe.test.ts .rpc-cache.exit" } },
		];
		const rendered = renderTranscript(entries);
		expect(rendered).toContain('{"Bash":"cp -R seed .rpc-baseline"}');
		expect(rendered).toContain('{"Write":{"path":"test/unit/rpc-import-probe.test.ts"');
		expect(rendered).toContain("printf '0");
		expect(rendered).not.toContain("omitted for length");
	});

	it("retains the redirect at the end of an earlier long shell command", () => {
		const command = `printf '%s' '${"fixture data ".repeat(200)}' > .rpc-ui-inventory.txt`;
		const rendered = renderTranscript([
			{ kind: "tool", tool: "bash", input: { command } },
			{ kind: "tool", tool: "bash", input: { command: "rm .rpc-ui-inventory.txt" } },
		]);
		expect(rendered).toContain(JSON.stringify({ Bash: command }));
		expect(rendered).not.toContain("truncated");
	});
});
