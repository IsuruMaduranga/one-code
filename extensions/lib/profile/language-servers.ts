/**
 * Language servers a profile declares (pure; working-docs/decisions/bi-fork.md).
 * The base's language-server feature (tools/lsp) routes a file to one by its
 * extension, ahead of the base's own table and behind an installed plugin's
 * server, and starts it without a trust prompt: the profile is trusted
 * product configuration. Diagnostics then reach the model as for any server.
 *
 * `${PROFILE_DIR}` in the command, an argument or an environment value is the
 * profile's folder, so a product can ship its server next to its profile.
 */

export interface ProductLanguageServer {
	command: string;
	args?: readonly string[];
	/** File extension (`.bal`) to LSP language id (`ballerina`). */
	extensions: Readonly<Record<string, string>>;
	/** Files that mark a project root, nearest ancestor first; the session's directory when none is found. */
	rootMarkers?: readonly string[];
	/** Merged over the process environment at spawn. */
	env?: Readonly<Record<string, string>>;
	/** Sent in the `initialize` request. */
	initializationOptions?: unknown;
	startupTimeoutMs?: number;
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
}

const NAME = /^[a-z][a-z0-9_-]*$/;
const normalizeExtension = (extension: string) => (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase();

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
	}
	return problems;
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
		...(server.initializationOptions !== undefined ? { initializationOptions: server.initializationOptions } : {}),
		...(server.startupTimeoutMs !== undefined ? { startupTimeoutMs: server.startupTimeoutMs } : {}),
	}));
}
