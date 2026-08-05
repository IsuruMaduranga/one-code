/**
 * Minimal LSP client: spawn a server, sync file contents, collect diagnostics.
 *
 * Deliberately small — this exists to answer one question ("what does the
 * language server say about this file right now?"), not to expose LSP.
 *
 * Design points that address the fragility of the package this replaces:
 * - No dependencies, so no transitive protocol-version conflicts.
 * - Content is pushed with didOpen/didChange before every diagnostics read, so
 *   the answer reflects the file on disk even if the edit was the session's
 *   first action.
 * - `waitForDiagnostics` awaits the next publish for that document instead of
 *   sleeping a fixed interval, with a timeout and a last-known fallback.
 * - Child handles are unref'd and shut down explicitly, so a one-shot `pi -p`
 *   run still exits.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { LspDiagnostic } from "./format.ts";
import { createReaderState, encodeMessage, type JsonRpcMessage, readMessages } from "./protocol.ts";
import type { ServerConfig } from "./servers.ts";

const INITIALIZE_TIMEOUT_MS = 15_000;
const DIAGNOSTICS_TIMEOUT_MS = 6_000;

export function pathToUri(path: string): string {
	return pathToFileURL(path).toString();
}

function unrefStream(stream: unknown): void {
	(stream as { unref?: () => void } | null | undefined)?.unref?.();
}

interface OpenDocument {
	version: number;
	text: string;
}

export class LspClient {
	private child?: ChildProcess;
	private reader = createReaderState();
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private diagnostics = new Map<string, LspDiagnostic[]>();
	private waiters = new Map<string, Array<() => void>>();
	private open = new Map<string, OpenDocument>();
	private ready = false;
	private failure?: string;

	constructor(
		readonly languageId: string,
		private readonly config: ServerConfig,
		private readonly root: string,
	) {}

	get isRunning(): boolean {
		return this.ready && !!this.child && this.child.exitCode === null;
	}

	get error(): string | undefined {
		return this.failure;
	}

	get diagnosticsCount(): number {
		let total = 0;
		for (const list of this.diagnostics.values()) total += list.length;
		return total;
	}

	async start(): Promise<void> {
		if (this.child) return;

		const child = spawn(this.config.command, this.config.args, {
			cwd: this.root,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		this.child = child;

		// Don't hold the event loop open once the agent is done. The stdio pipes
		// are sockets at runtime, so they carry unref() even though the stream
		// types don't declare it.
		child.unref();
		unrefStream(child.stdout);
		unrefStream(child.stderr);
		unrefStream(child.stdin);

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-2000);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			for (const message of readMessages(this.reader, chunk)) this.handle(message);
		});
		child.on("error", (error) => {
			this.failure = `Could not start ${this.config.command}: ${error.message}`;
			this.rejectAll(new Error(this.failure));
		});
		child.on("exit", (code, signal) => {
			this.ready = false;
			if (!this.failure && code !== 0) {
				const detail = stderr.trim().split("\n").slice(-3).join(" ");
				this.failure = `${this.config.command} exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ""}`;
			}
			this.rejectAll(new Error(this.failure ?? "language server exited"));
		});

		await this.request(
			"initialize",
			{
				processId: process.pid,
				rootUri: pathToUri(this.root),
				workspaceFolders: [{ uri: pathToUri(this.root), name: "workspace" }],
				capabilities: {
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: false },
						publishDiagnostics: { relatedInformation: false },
					},
					workspace: { workspaceFolders: true, configuration: true },
				},
			},
			INITIALIZE_TIMEOUT_MS,
		);

		this.notify("initialized", {});
		this.ready = true;
	}

	private handle(message: JsonRpcMessage): void {
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri: string; diagnostics: LspDiagnostic[] };
			this.diagnostics.set(params.uri, params.diagnostics ?? []);
			const waiting = this.waiters.get(params.uri);
			if (waiting) {
				this.waiters.delete(params.uri);
				for (const resolve of waiting) resolve();
			}
			return;
		}

		// Requests from the server: answer the ones that block startup.
		if (message.id !== undefined && message.method) {
			const result = message.method === "workspace/configuration" ? [{}] : null;
			this.send({ id: message.id, result });
			return;
		}

		if (message.id !== undefined) {
			const entry = this.pending.get(Number(message.id));
			if (!entry) return;
			this.pending.delete(Number(message.id));
			if (message.error) entry.reject(new Error(message.error.message));
			else entry.resolve(message.result);
		}
	}

	private send(payload: Record<string, unknown>): void {
		this.child?.stdin?.write(encodeMessage(payload));
	}

	private notify(method: string, params: unknown): void {
		this.send({ method, params });
	}

	request(method: string, params: unknown, timeoutMs = DIAGNOSTICS_TIMEOUT_MS): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.send({ id, method, params });
		});
	}

	private rejectAll(error: Error): void {
		for (const [, entry] of this.pending) entry.reject(error);
		this.pending.clear();
		for (const [, waiting] of this.waiters) for (const resolve of waiting) resolve();
		this.waiters.clear();
	}

	/** Push the file's current on-disk content and return its uri. */
	syncFile(path: string): string {
		const uri = pathToUri(path);
		let text: string;
		try {
			text = readFileSync(path, "utf-8");
		} catch {
			return uri;
		}

		const existing = this.open.get(uri);
		if (!existing) {
			this.open.set(uri, { version: 1, text });
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: this.languageId, version: 1, text },
			});
		} else if (existing.text !== text) {
			const version = existing.version + 1;
			this.open.set(uri, { version, text });
			this.notify("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text }],
			});
		}
		return uri;
	}

	/** Wait for the next publish for `uri`; resolves early if one already arrived. */
	private waitForPublish(uri: string, timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(), timeoutMs);
			timer.unref?.();
			const list = this.waiters.get(uri) ?? [];
			list.push(() => {
				clearTimeout(timer);
				resolve();
			});
			this.waiters.set(uri, list);
		});
	}

	/**
	 * Syncs the file, waits for the server's next diagnostics publication, and
	 * returns what it reported. Servers publish asynchronously and some republish
	 * nothing when a file is unchanged, hence the timeout plus last-known
	 * fallback.
	 */
	async getDiagnostics(path: string, timeoutMs = DIAGNOSTICS_TIMEOUT_MS): Promise<LspDiagnostic[]> {
		const uri = pathToUri(path);
		const hadContent = this.open.get(uri)?.text;
		const synced = this.syncFile(path);
		const changed = this.open.get(uri)?.text !== hadContent;

		if (changed || !this.diagnostics.has(synced)) {
			await this.waitForPublish(synced, timeoutMs);
		}
		return this.diagnostics.get(synced) ?? [];
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		this.ready = false;
		try {
			this.send({ id: this.nextId++, method: "shutdown", params: null });
			this.notify("exit", null);
		} catch {
			// Server may already be gone.
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 1000);
			timer.unref?.();
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}
