/**
 * PowerShell's own parser as a service: one long-lived parse server per
 * process, run on the PowerShell the tool itself runs, so the gate reads a
 * line exactly as it will execute (decisions/windows.md "The PowerShell
 * pre-gate reads PowerShell's own parse"; the tree-sitter grammars it replaces
 * are measured in findings §41).
 *
 * {@link PowerShellParser.parse} never rejects. Anything short of a clean
 * answer, whether the server could not start, timed out, crashed, runs in
 * Constrained Language Mode or stopped for good after too many crashes,
 * resolves to `{ ok: false, reason }`, and the caller treats the line as
 * unparsed (the classifier decides). A parse with errors is still `ok: true`:
 * the tree and its `errors` are PowerShell's answer; judging them is the
 * caller's job.
 *
 * Lifecycle. The server starts on the first request and stops after
 * `idleMs` without one; the next request starts it again. A crash, or a
 * request that times out (the server is then killed), counts toward
 * `maxRestarts`; past it the parser stays unavailable for the life of the
 * process. The child, its pipes and every timer are unref'd, so an idle
 * server never holds a finished one-shot run open; a caller that awaits a
 * parse in one holds its own ref (`withKeepAlive`). The server also exits on
 * its own when this process ends, because its stdin closes.
 *
 * Pure: no pi imports. The caller supplies `spawnServer`, which starts the
 * right executable with the bootstrap after `-Command`, so the BI fork can use
 * its own launcher.
 */

import type { ChildProcess } from "node:child_process";
import { POWERSHELL_PARSE_BOOTSTRAP, POWERSHELL_PARSE_WALKER } from "./powershell-parse-script.ts";
import { unrefHandle } from "./process-tree.ts";

/** One syntax-tree node, as the walker reports it (powershell-parse-script.ts). */
export interface PowerShellAstNode {
	/** The .NET type name: `CommandAst`, `StringConstantExpressionAst`, … */
	type: string;
	/** Index of the parent node in `nodes`; -1 for the root. */
	parent: number;
	/** Extent as UTF-16 offsets into the command (JS string indices). */
	start: number;
	end: number;
	/** CommandAst: the static command name (null when not static). CommandParameterAst: the parameter. VariableExpressionAst: the variable path. Type nodes: the type's full name. */
	name?: string | null;
	/** String and constant nodes: the value PowerShell resolved (quotes and escapes applied). */
	value?: string | null;
	/** String nodes: `BareWord`, `SingleQuoted`, `DoubleQuoted`, `SingleQuotedHereString`, `DoubleQuotedHereString`. */
	kind?: string;
	/** CommandAst: the invocation operator (`Unknown`, `Ampersand`, `Dot`). Operator nodes: the operator. */
	operator?: string;
	/** VariableExpressionAst: `@name` splatting. */
	splatted?: boolean;
	/** Redirections: the stream redirected (`Output`, `Error`, `All`, …) and, for a merge, where to. */
	from?: string;
	to?: string;
	/** FileRedirectionAst: `>>`. */
	append?: boolean;
	/** Pipelines and pipeline chains: a trailing `&` (PowerShell 7). */
	background?: boolean;
	/** Member access: `::`. */
	static?: boolean;
	/** CommandAst with a static name that resolves in this PowerShell: the resolved command's type (`Cmdlet`, `Application`, `Function`, …), after an alias. */
	commandType?: string;
	/** CommandAst: the name was an alias. */
	alias?: boolean;
	/** CommandAst: the resolved cmdlet's name, or an application's full path. */
	resolvedName?: string;
	/** CommandAst: the resolved command's module (empty for an application). */
	module?: string;
	/**
	 * CommandAst of a cmdlet: PowerShell's static parameter binding. `value` is
	 * the bound argument's node index, -1 for a switch given alone, and -2 for a
	 * value the binder built itself: the arguments a remaining-arguments
	 * parameter collects (`Write-Output a b`), whose node indices are
	 * `elements` (-1 for one that matched no argument).
	 */
	bindings?: Array<{ parameter: string; value: number; elements?: number[] }>;
	/** CommandAst of a cmdlet: the arguments or parameters the binder could not bind (an unknown or ambiguous name, a surplus positional, a repeat). */
	bindingErrors?: string[];
	/** CommandAst of a cmdlet: the static binder is missing or threw. */
	bindingUnavailable?: boolean;
}

export interface PowerShellParse {
	/** The tree in pre-order, root first. */
	nodes: PowerShellAstNode[];
	/** Each parse error's ErrorId. PowerShell runs nothing from a line that has one. */
	errors: string[];
}

export type PowerShellParseOutcome = { ok: true; parse: PowerShellParse } | { ok: false; reason: string };

export interface PowerShellParserOptions {
	/** Start the server: the PowerShell executable with `bootstrap` as the argument after `-Command`, stdio all piped. */
	spawnServer: (bootstrap: string) => ChildProcess;
	/** How long the first request waits while the server starts. */
	startTimeoutMs?: number;
	/** How long a request waits once the server is ready. */
	requestTimeoutMs?: number;
	/** Crashes and timeouts tolerated before the parser stays unavailable. */
	maxRestarts?: number;
	/** Stop the server after this long without a request. */
	idleMs?: number;
}

export const POWERSHELL_PARSE_START_TIMEOUT_MS = 5_000;
export const POWERSHELL_PARSE_REQUEST_TIMEOUT_MS = 2_000;
export const POWERSHELL_PARSE_MAX_RESTARTS = 3;
export const POWERSHELL_PARSE_IDLE_MS = 10 * 60_000;

interface Pending {
	resolve: (outcome: PowerShellParseOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Server {
	child: ChildProcess;
	ready: boolean;
	/** Set once the server is gone or being stopped; its late output and exit are ignored. */
	stopped: boolean;
	/** Why it stopped. */
	reason?: string;
	buffer: string;
	pending: Map<number, Pending>;
}

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

export class PowerShellParser {
	private readonly options: Required<PowerShellParserOptions>;
	private server: Server | undefined;
	private nextId = 1;
	private failures = 0;
	/** Why the parser is unavailable for good; set past `maxRestarts`, or when the server runs in a restricted language mode. */
	private disabled: string | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: PowerShellParserOptions) {
		this.options = {
			startTimeoutMs: POWERSHELL_PARSE_START_TIMEOUT_MS,
			requestTimeoutMs: POWERSHELL_PARSE_REQUEST_TIMEOUT_MS,
			maxRestarts: POWERSHELL_PARSE_MAX_RESTARTS,
			idleMs: POWERSHELL_PARSE_IDLE_MS,
			...options,
		};
	}

	/** Why the parser cannot answer at all, or undefined while it can (or can still start). */
	unavailable(): string | undefined {
		return this.disabled;
	}

	/** Parse `command` with PowerShell's own parser. Never rejects. */
	parse(command: string): Promise<PowerShellParseOutcome> {
		if (this.disabled) return Promise.resolve({ ok: false, reason: this.disabled });
		let server: Server;
		try {
			server = this.server ?? this.start();
		} catch (error) {
			return Promise.resolve({ ok: false, reason: this.fail(`PowerShell could not start: ${message(error)}`) });
		}
		// A server can fail while it starts (a spawn error, a restricted language
		// mode) before this request is registered with it.
		if (server.stopped) return Promise.resolve({ ok: false, reason: this.disabled ?? server.reason ?? "the PowerShell parser stopped" });
		this.touch();
		const id = this.nextId++;
		return new Promise((resolve) => {
			const timeoutMs = server.ready ? this.options.requestTimeoutMs : this.options.startTimeoutMs;
			const timer = setTimeout(() => {
				server.pending.delete(id);
				resolve({ ok: false, reason: `the PowerShell parser did not answer within ${timeoutMs} ms` });
				this.crashed(server, `the PowerShell parser timed out after ${timeoutMs} ms`);
			}, timeoutMs);
			unrefHandle(timer);
			server.pending.set(id, { resolve, timer });
			server.child.stdin?.write(`${id} ${encode(command)}\n`);
		});
	}

	/** Stop the server. The next request starts a new one. */
	stop(): void {
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		this.clearIdle();
		this.settleAll(server, "the PowerShell parser was stopped");
		server.stopped = true;
		server.child.stdin?.end();
		server.child.kill();
	}

	private start(): Server {
		const child = this.options.spawnServer(POWERSHELL_PARSE_BOOTSTRAP);
		const server: Server = { child, ready: false, stopped: false, buffer: "", pending: new Map() };
		this.server = server;
		child.stdin?.on("error", () => {});
		child.stdout?.setEncoding("ascii");
		child.stdout?.on("data", (chunk: string) => this.receive(server, chunk));
		// PowerShell's own error output is not part of the protocol; drain it so
		// the pipe never fills.
		child.stderr?.on("data", () => {});
		child.on("error", (error) => this.crashed(server, `PowerShell could not start: ${message(error)}`));
		child.on("exit", (code, signal) => this.crashed(server, `the PowerShell parser exited (${signal ?? `code ${code}`})`));
		unrefHandle(child);
		unrefHandle(child.stdin);
		unrefHandle(child.stdout);
		unrefHandle(child.stderr);
		child.stdin?.write(`${encode(POWERSHELL_PARSE_WALKER)}\n`);
		return server;
	}

	private receive(server: Server, chunk: string): void {
		if (server.stopped) return;
		server.buffer += chunk;
		for (let newline = server.buffer.indexOf("\n"); newline >= 0; newline = server.buffer.indexOf("\n")) {
			const line = server.buffer.slice(0, newline).trim();
			server.buffer = server.buffer.slice(newline + 1);
			if (line) this.record(server, line);
			if (server.stopped) return;
		}
	}

	private record(server: Server, line: string): void {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(Buffer.from(line, "base64").toString("utf8")) as Record<string, unknown>;
		} catch {
			this.crashed(server, "the PowerShell parser wrote a line that is not part of its protocol");
			return;
		}
		if (record.id === 0) {
			if (record.language !== "FullLanguage") {
				// Constrained Language Mode (or stricter) is a machine policy, so a
				// restart cannot change it.
				this.disabled = `PowerShell runs in ${String(record.language)} mode, where the parser is not available`;
				this.crashed(server, this.disabled);
				return;
			}
			// Failures are not reset here: a line that hangs the walker would
			// otherwise restart it forever.
			server.ready = true;
			return;
		}
		const pending = typeof record.id === "number" ? server.pending.get(record.id) : undefined;
		if (!pending) return;
		server.pending.delete(record.id as number);
		clearTimeout(pending.timer);
		if (typeof record.failure === "string") {
			pending.resolve({ ok: false, reason: `the PowerShell parser failed: ${record.failure}` });
			return;
		}
		pending.resolve({ ok: true, parse: { nodes: asArray(record.nodes).map(normalizeNode), errors: asArray(record.errors).map(String) } });
	}

	/** The server is gone or unusable: settle what waits on it and count the failure. */
	private crashed(server: Server, reason: string): void {
		if (server.stopped) return;
		server.stopped = true;
		server.reason = reason;
		if (this.server === server) this.server = undefined;
		this.clearIdle();
		this.settleAll(server, reason);
		server.child.stdin?.end();
		server.child.kill();
		this.fail(reason);
	}

	private fail(reason: string): string {
		this.failures++;
		if (!this.disabled && this.failures > this.options.maxRestarts) {
			this.disabled = `the PowerShell parser is off after ${this.failures} failures (last: ${reason})`;
		}
		return reason;
	}

	private settleAll(server: Server, reason: string): void {
		for (const pending of server.pending.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ ok: false, reason });
		}
		server.pending.clear();
	}

	private touch(): void {
		this.clearIdle();
		this.idleTimer = setTimeout(() => this.stop(), this.options.idleMs);
		unrefHandle(this.idleTimer);
	}

	private clearIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}
}

/**
 * A node with its list fields made lists: ConvertTo-Json may write a
 * one-element list as the element. A binding list that is not one after
 * that marks the binding unavailable, which the gate refuses.
 */
function normalizeNode(value: unknown): PowerShellAstNode {
	const node = { ...(value as PowerShellAstNode) };
	if (node.bindingErrors !== undefined) node.bindingErrors = asArray(node.bindingErrors).map(String);
	if (node.bindings !== undefined) {
		const bindings = asArray(node.bindings) as Array<{ parameter?: unknown; value?: unknown; elements?: unknown }>;
		if (bindings.every((b) => b !== null && typeof b === "object" && typeof b.parameter === "string" && typeof b.value === "number")) {
			node.bindings = bindings.map((b) => ({ parameter: b.parameter as string, value: b.value as number, ...(b.elements === undefined ? {} : { elements: asArray(b.elements).map(Number) }) }));
		} else {
			delete node.bindings;
			node.bindingUnavailable = true;
		}
	}
	return node;
}

function asArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	// ConvertTo-Json writes a one-element array as that element on some
	// PowerShell versions, and an empty one as null.
	return value === undefined || value === null ? [] : [value];
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const STATE_KEY = Symbol.for("one-code.powershell-parser");

/**
 * The process-wide parser for one PowerShell executable. It lives on
 * `globalThis`, not in module state: jiti gives each extension, and each
 * in-process child session, its own instance of this module (findings §3), and
 * one server per process is the point.
 */
export function sharedPowerShellParser(executable: string, create: () => PowerShellParser): PowerShellParser {
	const store = globalThis as { [STATE_KEY]?: Map<string, PowerShellParser> };
	const parsers = (store[STATE_KEY] ??= new Map());
	let parser = parsers.get(executable);
	if (!parser) {
		parser = create();
		parsers.set(executable, parser);
	}
	return parser;
}
