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
 * that server's diagnostics (tools/lsp/fix-hints.ts) in the words of the
 * profile's `text.lsp.fixHints`.
 */

/** The longest fix hint, in characters: a hint is one line of advice. */
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

/** What is wrong with a server's fix hints: an empty key, or a hint that is empty, longer than a line or spans lines. */
function fixHintProblems(name: string, hints: ProductFixHints | undefined): string[] {
	if (!hints) return [];
	const problems: string[] = [];
	const check = (where: string, key: unknown, hint: unknown) => {
		if (typeof key !== "string" || key.trim() === "") problems.push(`language server "${name}" has a fix hint ${where} with an empty key`);
		if (typeof hint !== "string" || hint.trim() === "") problems.push(`language server "${name}" has an empty fix hint ${where} for ${JSON.stringify(key)}`);
		else if (/[\r\n]/.test(hint)) problems.push(`language server "${name}" has a fix hint ${where} for ${JSON.stringify(key)} on more than one line`);
		else if (hint.length > MAX_FIX_HINT_LENGTH) problems.push(`language server "${name}" has a fix hint ${where} for ${JSON.stringify(key)} longer than ${MAX_FIX_HINT_LENGTH} characters`);
	};
	for (const [code, hint] of Object.entries(hints.byCode ?? {})) check("by code", code, hint);
	for (const entry of hints.byMessage ?? []) check("by message", entry?.[0], entry?.[1]);
	return problems;
}

/** Whether any server declares a fix hint: the profile's text must then word the trailer. */
export function declaresFixHints(servers: Readonly<Record<string, ProductLanguageServer>>): string[] {
	return Object.entries(servers)
		.filter(([, server]) => Object.keys(server.fixHints?.byCode ?? {}).length > 0 || (server.fixHints?.byMessage ?? []).length > 0)
		.map(([name]) => name);
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
		...(declaresFixHints({ [name]: server }).length > 0
			? { fixHints: { byCode: new Map(Object.entries(server.fixHints?.byCode ?? {})), byMessage: (server.fixHints?.byMessage ?? []).map(([substring, hint]) => [substring, hint] as const) } }
			: {}),
	}));
}
