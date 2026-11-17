/**
 * Language servers a profile declares (pure; working-docs/decisions/bi-fork.md).
 * The base's language-server feature (tools/lsp) routes a file to one by its
 * extension, ahead of the base's own table and behind an installed plugin's
 * server, and starts it without a trust prompt: the profile is trusted
 * product configuration. Diagnostics then reach the model as for any server.
 *
 * `${PROFILE_DIR}` in the command, an argument or an environment value is the
 * profile's folder, so a product can ship its server next to its profile.
 *
 * A server may carry fix hints: one line of advice per diagnostic code, or
 * per plain message substring for diagnostics without a code, shown after
 * that server's diagnostics (tools/lsp/fix-hints.ts). The profile supplies
 * only the hints; the base frames them.
 */

/** The longest fix hint, and the longest code or substring one is keyed by, in characters: a hint is one line of advice. */
export const MAX_FIX_HINT_LENGTH = 200;

/** A server's fix hints as the profile declares them. */
export interface ProductFixHints {
	/** By the diagnostic's code (`"BCE2066"`; a numeric code by its decimal spelling). */
	byCode?: Readonly<Record<string, string>>;
	/** By a plain substring of the message, in order, first match wins: for diagnostics with no code, or no hint for theirs. Never a pattern. */
	byMessage?: readonly (readonly [string, string])[];
}

/** A server's fix hints as the base looks them up. */
export interface ResolvedFixHints {
	byCode: ReadonlyMap<string, string>;
	byMessage: readonly (readonly [string, string])[];
}

export interface ProductLanguageServer {
	command: string;
	args?: readonly string[];
	/** File extension (`.smp`) to LSP language id (`sample`). */
	extensions: Readonly<Record<string, string>>;
	/** Files that mark a project root, nearest ancestor first; the session's directory when none is found. */
	rootMarkers?: readonly string[];
	/** Merged over the process environment at spawn. */
	env?: Readonly<Record<string, string>>;
	/** Sent in the `initialize` request. */
	initializationOptions?: unknown;
	startupTimeoutMs?: number;
	/** Advice shown after this server's diagnostics, by code or message substring. */
	fixHints?: ProductFixHints;
}

export interface ResolvedLanguageServer {
	name: string;
	command: string;
	args: string[];
	/** Normalized: lowercase, leading dot. */
	languageByExtension: Readonly<Record<string, string>>;
	rootMarkers: string[];
	env: Record<string, string>;
	initializationOptions?: unknown;
	startupTimeoutMs?: number;
	fixHints?: ResolvedFixHints;
}

const NAME = /^[a-z][a-z0-9_-]*$/;
/** A file extension as the routing tables key it: lowercase, with its leading dot. */
export const normalizeExtension = (extension: string) => (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase();

/** The problems in a profile's language servers, for the resolver to report with the rest. */
export function languageServerProblems(servers: Readonly<Record<string, ProductLanguageServer>>): string[] {
	const problems: string[] = [];
	const owner = new Map<string, string>();
	for (const [name, server] of Object.entries(servers)) {
		if (!NAME.test(name)) problems.push(`language server "${name}" must have a bare lowercase name`);
		if (typeof server.command !== "string" || server.command.trim() === "") problems.push(`language server "${name}" has no command`);
		const extensions = Object.entries(server.extensions ?? {});
		if (extensions.length === 0) problems.push(`language server "${name}" lists no file extension`);
		for (const [extension, languageId] of extensions) {
			const key = normalizeExtension(extension);
			if (typeof languageId !== "string" || languageId === "") problems.push(`language server "${name}" gives ${key} no language id`);
			const other = owner.get(key);
			if (other && other !== name) problems.push(`language servers "${other}" and "${name}" both claim ${key}`);
			owner.set(key, name);
		}
		problems.push(...fixHintProblems(name, server.fixHints));
	}
	return problems;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Why `value` is not one line of advice (a hint, or the code or substring it is keyed by), or undefined. */
function lineProblem(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return "empty";
	if (/[\r\n]/.test(value)) return "on more than one line";
	if (value.length > MAX_FIX_HINT_LENGTH) return `longer than ${MAX_FIX_HINT_LENGTH} characters`;
	return undefined;
}

/**
 * What is wrong with a server's fix hints: a shape the base cannot read
 * (a field other than `byCode` and `byMessage`, `byCode` not a plain object,
 * `byMessage` not a list of pairs, holes included), or a key or
 * hint that is empty, spans lines or is longer than a line of advice.
 */
function fixHintProblems(name: string, hints: unknown): string[] {
	if (hints === undefined) return [];
	const at = `language server "${name}"`;
	if (!isPlainObject(hints)) return [`${at} has fix hints that are not an object of byCode and byMessage`];
	const problems: string[] = [];
	const check = (where: string, key: unknown, hint: unknown) => {
		const keyProblem = lineProblem(key);
		if (keyProblem === "empty") problems.push(`${at} has a fix hint ${where} with an empty key`);
		else if (keyProblem) problems.push(`${at} has a fix hint ${where} whose key ${JSON.stringify(key)} is ${keyProblem}`);
		const hintProblem = lineProblem(hint);
		if (hintProblem === "empty") problems.push(`${at} has an empty fix hint ${where} for ${JSON.stringify(key)}`);
		else if (hintProblem) problems.push(`${at} has a fix hint ${where} for ${JSON.stringify(key)} ${hintProblem}`);
	};
	for (const field of Object.keys(hints)) {
		if (field !== "byCode" && field !== "byMessage") problems.push(`${at} has fix hints with an unknown field ${JSON.stringify(field)}: only byCode and byMessage are read`);
	}
	const { byCode, byMessage } = hints;
	if (byCode !== undefined && !isPlainObject(byCode)) problems.push(`${at} has fix hints whose byCode is not an object of code to hint`);
	else for (const [code, hint] of Object.entries(byCode ?? {})) check("by code", code, hint);
	if (byMessage !== undefined && !Array.isArray(byMessage)) problems.push(`${at} has fix hints whose byMessage is not a list of [substring, hint] pairs`);
	else {
		// By index, not forEach: a hole in a sparse list is a problem too.
		const entries: unknown[] = byMessage ?? [];
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (!Array.isArray(entry) || entry.length !== 2) problems.push(`${at} has a fix hint by message at position ${index} that is not a [substring, hint] pair`);
			else check("by message", entry[0], entry[1]);
		}
	}
	return problems;
}

/** Whether a server declares at least one fix hint. */
export function hasFixHints(server: ProductLanguageServer): boolean {
	return Object.keys(server.fixHints?.byCode ?? {}).length > 0 || (server.fixHints?.byMessage ?? []).length > 0;
}

/** Each server with `${PROFILE_DIR}` filled in and its extensions normalized. */
export function resolveLanguageServers(servers: Readonly<Record<string, ProductLanguageServer>>, profileDir: string): ResolvedLanguageServer[] {
	const fill = (value: string) => value.replaceAll("${PROFILE_DIR}", profileDir);
	return Object.entries(servers).map(([name, server]) => ({
		name,
		command: fill(server.command),
		args: (server.args ?? []).map(fill),
		languageByExtension: Object.fromEntries(Object.entries(server.extensions).map(([extension, languageId]) => [normalizeExtension(extension), languageId])),
		rootMarkers: [...(server.rootMarkers ?? [])],
		env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, fill(value)])),
		initializationOptions: server.initializationOptions,
		startupTimeoutMs: server.startupTimeoutMs,
		...(hasFixHints(server)
			? { fixHints: { byCode: new Map(Object.entries(server.fixHints?.byCode ?? {})), byMessage: (server.fixHints?.byMessage ?? []).map(([substring, hint]) => [substring, hint] as const) } }
			: {}),
	}));
}
