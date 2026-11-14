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
 * - A change made on disk by something else reaches the server only when a
 *   caller reports it (`applyDiskChanges`) or asks for a refresh of the open
 *   files (`refreshOpenFiles`); the client watches no files itself.
 * - `waitForDiagnostics` awaits the next publish for that document instead of
 *   sleeping a fixed interval, with a timeout and a last-known fallback.
 * - Child handles are unref'd and shut down explicitly, so a one-shot `pi -p`
 *   run still exits.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, type Stats, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LspFailureError, LspResponseError } from "./failure.ts";
import type { LspDiagnostic } from "./format.ts";
import type { LspFailure } from "./text.ts";
import { childProcessEnv } from "../../lib/app/app-launch.mjs";
import { commandLaunch } from "../../lib/shell-run/command-launch.ts";
import { killProcessTree, unrefHandle } from "../../lib/shell-run/process-tree.ts";
import { createReaderState, encodeMessage, type JsonRpcMessage, readMessages } from "./protocol.ts";

const INITIALIZE_TIMEOUT_MS = 15_000;
const DIAGNOSTICS_TIMEOUT_MS = 6_000;

/** What a client actually needs to spawn — the built-in table's ServerConfig satisfies it. */
export interface SpawnConfig {
	command: string;
	args: string[];
}

/** Per-server extras a plugin config can carry (built-in servers pass none). */
export interface LspClientOptions {
	/** Merged over process.env at spawn. */
	env?: Record<string, string>;
	/** Sent in the `initialize` request. */
	initializationOptions?: unknown;
	/** Answers the server's workspace/configuration requests. */
	settings?: unknown;
	startupTimeoutMs?: number;
}

export function pathToUri(path: string): string {
	return pathToFileURL(path).toString();
}

/**
 * The reply to a server's workspace/configuration request: one settings object
 * per requested item (LSP 3.6 shape), `{}` when none are configured.
 */
export function configurationResponse(settings: unknown, params: unknown): unknown[] {
	const items = (params as { items?: unknown[] } | undefined)?.items;
	const count = Array.isArray(items) && items.length > 0 ? items.length : 1;
	return Array.from({ length: count }, () => settings ?? {});
}

interface OpenDocument {
	path: string;
	languageId: string;
	version: number;
	text: string;
	/** The file's stat when `text` was read, so a later look can tell it moved without reading it. */
	mtimeMs: number;
	size: number;
}

/**
 * A file that changed on disk without the session's own edit tools (a shell
 * command, a build tool, the user's editor). `type` is what happened when the
 * caller knows; the disk decides whether the file is gone.
 */
export interface DiskChange {
	path: string;
	type?: "created" | "changed" | "deleted";
}

/** The LSP `FileChangeType` values of `workspace/didChangeWatchedFiles`. */
const FILE_CHANGE_TYPE = { created: 1, changed: 2, deleted: 3 } as const;

function statOf(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

export class LspClient {
	private child?: ChildProcess;
	private reader = createReaderState();
	private nextId = 1;
	private pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private diagnostics = new Map<string, LspDiagnostic[]>();
	private waiters = new Map<string, Array<() => void>>();
	private open = new Map<string, OpenDocument>();
	private ready = false;
	private failure?: LspFailure;
	private publishes = 0;

	constructor(
		private readonly config: SpawnConfig,
		private readonly root: string,
		private readonly options: LspClientOptions = {},
	) {}

	get isRunning(): boolean {
		return this.ready && !!this.child && this.child.exitCode === null;
	}

	get error(): LspFailure | undefined {
		return this.failure;
	}

	get diagnosticsCount(): number {
		let total = 0;
		for (const list of this.diagnostics.values()) total += list.length;
		return total;
	}

	async start(): Promise<void> {
		if (this.child) return;

		// The user's own environment under the bundled app (lib/app/app-launch.mjs).
		const base = childProcessEnv(process.env);
		const env = this.options.env ? { ...base, ...this.options.env } : base;
		// On Windows an npm-installed server is a .cmd shim, which a bare spawn
		// cannot start (lib/shell-run/command-launch.ts); failure messages keep naming the command.
		const launch = commandLaunch(this.config.command, this.config.args, env);
		const child = spawn(launch.command, launch.args, {
			cwd: this.root,
			stdio: ["pipe", "pipe", "pipe"],
			env,
			windowsHide: true,
			windowsVerbatimArguments: launch.windowsVerbatimArguments,
		});
		this.child = child;

		// Don't hold the event loop open once the agent is done. The stdio pipes
		// are sockets at runtime, so they carry unref() even though the stream
		// types don't declare it.
		child.unref();
		unrefHandle(child.stdout);
		unrefHandle(child.stderr);
		unrefHandle(child.stdin);

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-2000);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			for (const message of readMessages(this.reader, chunk)) this.handle(message);
		});
		child.on("error", (error) => {
			this.failure = { kind: "spawnFailed", command: this.config.command, osMessage: error.message };
			this.rejectAll(new LspFailureError(this.failure));
		});
		// A write to a dead server's stdin is an EPIPE on the stream; without a
		// listener that is an unhandled 'error' event, i.e. a crash (review T10).
		child.stdin?.on("error", (error) => {
			this.failure ??= { kind: "stoppedInput", command: this.config.command, osMessage: error.message };
			this.ready = false;
		});
		child.on("exit", (code, signal) => {
			this.ready = false;
			if (!this.failure && code !== 0) {
				const detail = stderr.trim().split("\n").slice(-3).join(" ");
				this.failure = { kind: "exited", command: this.config.command, ...(signal ? { signal } : { code }), ...(detail ? { detail } : {}) };
			}
			this.rejectAll(new LspFailureError(this.failure ?? { kind: "exitedQuietly" }));
		});

		await this.request(
			"initialize",
			{
				processId: process.pid,
				rootUri: pathToUri(this.root),
				workspaceFolders: [{ uri: pathToUri(this.root), name: "workspace" }],
				initializationOptions: this.options.initializationOptions,
				capabilities: {
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: false },
						publishDiagnostics: { relatedInformation: false },
					},
					// Static support only: a server that sees dynamic registration
					// may hand its file watching to the client, and this client
					// watches nothing (it sends what `applyDiskChanges` is told).
					workspace: { workspaceFolders: true, configuration: true, didChangeWatchedFiles: { dynamicRegistration: false } },
				},
			},
			this.options.startupTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
		);

		this.notify("initialized", {});
		this.ready = true;
	}

	private handle(message: JsonRpcMessage): void {
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri: string; diagnostics: LspDiagnostic[] };
			this.publishes++;
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
			const result =
				message.method === "workspace/configuration"
					? configurationResponse(this.options.settings, message.params)
					: null;
			this.send({ id: message.id, result });
			return;
		}

		if (message.id !== undefined) {
			const entry = this.pending.get(Number(message.id));
			if (!entry) return;
			this.pending.delete(Number(message.id));
			if (message.error) entry.reject(new LspResponseError(entry.method, message.error.code, message.error.message, message.error.data));
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
				reject(new LspFailureError({ kind: "timedOut", method, ms: timeoutMs }));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				method,
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

	/**
	 * Push the file's current on-disk content and return its uri. `languageId`
	 * is per-document: one plugin server process can map different extensions to
	 * different language ids.
	 */
	syncFile(path: string, languageId: string): string {
		this.push(path, languageId);
		return pathToUri(path);
	}

	/** `didOpen` or `didChange` from disk; true when either was sent. An unreadable file sends nothing. */
	private push(path: string, languageId: string): boolean {
		const uri = pathToUri(path);
		// Stat before the read: a write between the two leaves a stat older
		// than the text, so the next look reads again instead of missing it.
		const stat = statOf(path);
		let text: string;
		try {
			text = readFileSync(path, "utf-8");
		} catch {
			return false;
		}
		const seen = { mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? -1 };

		const existing = this.open.get(uri);
		if (!existing) {
			this.open.set(uri, { path, languageId, version: 1, text, ...seen });
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text },
			});
			return true;
		}
		if (existing.text === text) {
			this.open.set(uri, { ...existing, ...seen });
			return false;
		}
		const version = existing.version + 1;
		this.open.set(uri, { ...existing, version, text, ...seen });
		this.notify("textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
		return true;
	}

	/**
	 * Tell the server about files that changed on disk, without opening any.
	 * A file the server holds open gets `didChange` from disk (an open copy
	 * wins over the disk on the server, so nothing else reaches it), or
	 * `didClose` when it is gone; every other file goes in one
	 * `workspace/didChangeWatchedFiles`. Returns the uris whose open copy
	 * changed or closed.
	 */
	applyDiskChanges(changes: readonly DiskChange[]): string[] {
		const updated: string[] = [];
		const watched: Array<{ uri: string; type: number }> = [];
		for (const change of changes) {
			const uri = pathToUri(change.path);
			const gone = statOf(change.path) === undefined;
			const document = this.open.get(uri);
			if (document) {
				if (!gone) {
					if (this.push(document.path, document.languageId)) updated.push(uri);
					continue;
				}
				// Its diagnostics go with it: a server need not publish an empty
				// list on close, and a read of the dead path must not answer from them.
				this.open.delete(uri);
				this.diagnostics.delete(uri);
				updated.push(uri);
				this.notify("textDocument/didClose", { textDocument: { uri } });
			}
			const type = gone ? "deleted" : change.type === "created" ? "created" : "changed";
			watched.push({ uri, type: FILE_CHANGE_TYPE[type] });
		}
		if (watched.length > 0) this.notify("workspace/didChangeWatchedFiles", { changes: watched });
		return updated;
	}

	/**
	 * Bring every open file whose stat moved since it was sent up to date
	 * (`applyDiskChanges`), except `skip`, which the caller syncs itself.
	 * Cheap when nothing moved: one stat per open file, no reads.
	 */
	refreshOpenFiles(skip?: string): string[] {
		const skipUri = skip === undefined ? undefined : pathToUri(skip);
		const moved: DiskChange[] = [];
		for (const [uri, document] of this.open) {
			if (uri === skipUri) continue;
			const stat = statOf(document.path);
			if (!stat || stat.mtimeMs !== document.mtimeMs || stat.size !== document.size) moved.push({ path: document.path });
		}
		return moved.length > 0 ? this.applyDiskChanges(moved) : [];
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
	async getDiagnostics(path: string, languageId: string, timeoutMs = DIAGNOSTICS_TIMEOUT_MS): Promise<LspDiagnostic[]> {
		const uri = pathToUri(path);
		if (this.push(path, languageId) || !this.diagnostics.has(uri)) {
			await this.waitForPublish(uri, timeoutMs);
		}
		return this.diagnostics.get(uri) ?? [];
	}

	/** Everything the server has published, per document uri (for the watcher). */
	allDiagnostics(): Map<string, LspDiagnostic[]> {
		return new Map(this.diagnostics);
	}

	/**
	 * Monotonic count of publishDiagnostics received — the watcher's cheap
	 * "anything new since last look?" check, so the per-tool-round delta scan
	 * only runs when a server actually republished.
	 */
	get publishCount(): number {
		return this.publishes;
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.ready = false;
		try {
			// Send while this.child is still set — send() writes through it.
			this.send({ id: this.nextId++, method: "shutdown", params: null });
			this.notify("exit", null);
		} catch {
			// Server may already be gone.
		}
		this.child = undefined;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				// The tree, not the leader: on Windows a .cmd-shimmed server runs
				// under the cmd.exe `commandLaunch` started, and killing cmd.exe
				// alone would orphan the server on the inherited pipes.
				killProcessTree(child, "SIGKILL");
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
