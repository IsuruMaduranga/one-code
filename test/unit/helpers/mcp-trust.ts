/**
 * The setup of the MCP project-server approval tests (mcp-trust and its One
 * Code sibling): a project and a home under one temp root, servers in the
 * shape config.ts loads, and the dialog stand-ins `approveMcpServers` takes.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "../../../extensions/tools/mcp/config.ts";
import { CHOICE_THIS, resetMcpTrustSessionState } from "../../../extensions/tools/mcp/trust.ts";

export interface McpTrustDirs {
	/** The temp root holding everything; remove it after the test. */
	root: string;
	cwd: string;
	home: string;
	/** Where approvals persist. */
	storePath: string;
}

/** Makes a project and a home under a fresh temp root, and forgets the session's answers. */
export function makeMcpTrustDirs(): McpTrustDirs {
	const root = mkdtempSync(join(tmpdir(), "cc-mcp-trust-"));
	const cwd = join(root, "project");
	const home = join(root, "home");
	for (const dir of [cwd, home]) mkdirSync(dir, { recursive: true });
	resetMcpTrustSessionState();
	return { root, cwd, home, storePath: join(root, "state", "mcp", "project-approvals.json") };
}

/** A stdio server defined in `source`. */
export const stdio = (name: string, source: string, command = "npx", args = ["-y", `${name}-server`]): McpServer => ({
	kind: "stdio",
	name,
	command,
	args,
	source,
});

/**
 * The dialog stand-ins for `approveMcpServers`, and what they saw: the select
 * answers `choose` (the first choice by default; `undefined` is Escape).
 */
export function trustDeps(storePath: string, opts: { choose?: string | undefined; hasUI?: boolean } = {}) {
	const notices: string[] = [];
	const disabled: string[] = [];
	const selections: string[] = [];
	const choose = "choose" in opts ? opts.choose : CHOICE_THIS;
	return {
		notices,
		disabled,
		selections,
		deps: {
			hasUI: opts.hasUI ?? true,
			select: async (title: string) => {
				selections.push(title);
				return choose;
			},
			notify: (m: string) => {
				notices.push(m);
			},
			disable: (s: McpServer) => {
				disabled.push(s.name);
			},
			storePath,
		},
	};
}
