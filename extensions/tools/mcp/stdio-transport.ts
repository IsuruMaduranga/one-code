/**
 * The stdio transport for MCP servers: the SDK's `StdioClientTransport`
 * protocol (newline-delimited JSON-RPC over the child's stdin and stdout, the
 * SDK's own `ReadBuffer` and `serializeMessage`), with the child's lifetime
 * owned the way every long-lived child of One Code is
 * (lib/shell-run/process-tree.ts).
 *
 * The SDK spawns the server in pi's own process group and its `close()`
 * signals the leader's pid alone. A server is often a launcher in front of the
 * real process (a shell script, `npx`, a `.cmd` shim), and such servers can
 * ignore a closed stdin: closing reached only the launcher, and a crash or a
 * signal (pi exits without `session_shutdown`) never reached the server at all,
 * which then lived on, reparented to init (the exit probe, test/e2e/exit-probe.mjs,
 * measured both). Here the server is an owned tree (`spawnOwnedTree`): its own
 * group, remembered from spawn, so the process's exit and termination-signal
 * hooks end it; `close()` ends the whole group; and a launcher that exits by
 * itself takes the rest of its group with it, as a language server's does
 * (tools/lsp/client.ts).
 *
 * The close sequence keeps the SDK's shape: end stdin, give the server
 * `KILL_GRACE_MS` (2 s, the SDK's wait) to exit, then SIGTERM the group and
 * SIGKILL it after `KILL_GRACE_MS` more. On Windows the kill is `taskkill /T`
 * while the leader lives (process-tree.ts).
 */

import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { commandLaunch } from "../../lib/shell-run/command-launch.ts";
import { endTreeMaxMs, KILL_GRACE_MS, type OwnedTree, spawnOwnedTree } from "../../lib/shell-run/process-tree.ts";

export interface StdioServerParams {
	command: string;
	args?: string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
}

/** The SDK's framing, passed in so this module does not load the SDK eagerly (client.ts loads it on first connect). */
export interface StdioFraming {
	ReadBuffer: new () => { append(chunk: Buffer): void; readMessage(): JSONRPCMessage | null; clear(): void };
	serializeMessage(message: JSONRPCMessage): string;
}

/** The longest `close()` takes: the stdin grace, then the TERM grace and the SIGKILL's settling. */
export const STDIO_CLOSE_MAX_MS = endTreeMaxMs(KILL_GRACE_MS, KILL_GRACE_MS);

export class ProcessGroupStdioTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: <T extends JSONRPCMessage>(message: T) => void;

	/** The server's stderr, readable before `start()` so its first bytes are not lost. */
	readonly stderr = new PassThrough();
	private tree?: OwnedTree;
	private readonly readBuffer;

	constructor(
		private readonly params: StdioServerParams,
		private readonly framing: StdioFraming,
	) {
		this.readBuffer = new framing.ReadBuffer();
	}

	start(): Promise<void> {
		if (this.tree) throw new Error("ProcessGroupStdioTransport already started");
		return new Promise((resolve, reject) => {
			// On Windows an npm-installed server is a .cmd shim, started through cmd.exe (lib/shell-run/command-launch.ts).
			const launch = commandLaunch(this.params.command, this.params.args ?? [], this.params.env);
			// A launcher can exit, on close or by itself, and leave the server it started: its exit ends the rest of its group.
			const tree = spawnOwnedTree(
				(detached) =>
					spawn(launch.command, launch.args, {
						env: this.params.env,
						cwd: this.params.cwd,
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
						windowsVerbatimArguments: launch.windowsVerbatimArguments,
						...detached,
					}),
				{ endGroupWithLauncher: true },
			);
			this.tree = tree;
			const child = tree.child;
			child.on("error", (error) => {
				reject(error);
				this.onerror?.(error);
			});
			child.on("spawn", () => resolve());
			child.on("close", () => {
				if (this.tree === tree) this.tree = undefined;
				this.onclose?.();
			});
			child.stdin?.on("error", (error) => this.onerror?.(error));
			child.stdout?.on("data", (chunk: Buffer) => {
				this.readBuffer.append(chunk);
				this.drain();
			});
			child.stdout?.on("error", (error) => this.onerror?.(error));
			child.stderr?.pipe(this.stderr);
		});
	}

	private drain(): void {
		for (;;) {
			let message: JSONRPCMessage | null;
			try {
				message = this.readBuffer.readMessage();
			} catch (error) {
				this.onerror?.(error as Error);
				continue;
			}
			if (message === null) return;
			this.onmessage?.(message);
		}
	}

	send(message: JSONRPCMessage): Promise<void> {
		return new Promise((resolve) => {
			const stdin = this.tree?.child.stdin;
			if (!stdin) throw new Error("Not connected");
			if (stdin.write(this.framing.serializeMessage(message))) resolve();
			else stdin.once("drain", resolve);
		});
	}

	async close(): Promise<void> {
		const tree = this.tree;
		this.tree = undefined;
		if (tree) {
			try {
				tree.child.stdin?.end();
			} catch {
				// Already closed.
			}
			// A server that exits on the closed stdin within the grace ends politely; then the group
			// is TERMed, KILLed after the grace, and waited for, not only the leader. A launcher that
			// exited during the wait already started that stop (endGroupWithLauncher), which is kept.
			await tree.end(KILL_GRACE_MS, KILL_GRACE_MS);
		}
		this.readBuffer.clear();
	}
}
