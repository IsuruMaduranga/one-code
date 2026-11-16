/**
 * Which tools pi's launch flags keep registered: `--tools`/`-t`,
 * `--exclude-tools`/`-xt` and `--no-tools`/`-nt`. pi leaves a tool these
 * flags filter out of its registry, so the live tool set
 * (lib/profile/live-tools.ts) leaves it out too, and no text names it.
 *
 * A copy of pi's rules (pi-coding-agent 1.5.2: `cli/args.js` parseArgs,
 * `core/sdk.js` createAgentSession, `core/agent-session.js` `_isAllowedTool`,
 * `core/mcp-servers.js` createToolNameMatcher and isMcpToolName,
 * `core/settings-manager.js` applyToolModifiers and getToolListError). pi
 * exports `parseArgs`, but this module sits under the profile's source
 * provider, which must import no pi package as a value
 * (`shared-module-graph.test.ts`). `pi-tool-flags.test.ts` checks the copy
 * against pi: the flags against pi's `parseArgs` for every flag pi's parser
 * names, and the filter against the registry real pi sessions build under
 * each flag form, so a pi bump that changes the rules fails there.
 *
 * Registered, not active: `--tools +name,-name` and `--no-builtin-tools`
 * change only which tools start active, so they change nothing here, as
 * deferral changes nothing.
 */

/**
 * pi's flags that take the next argument whatever it is. Every other flag
 * takes a value only when it does not start with "-" (or takes none), and
 * the tool flags all start with "-", so only these can hide one.
 */
const VALUE_FLAGS = new Set([
	"--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--session", "--session-id", "--fork",
	"--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--export", "--extension", "-e", "--skill",
	"--prompt-template", "--theme",
]);

const toolList = (value: string) => value.split(",").map((s) => s.trim()).filter((name) => name.length > 0);

/** The tool flags in `args` (the arguments after the command), as pi's `parseArgs` reads them: the last of each wins, nothing after `--` counts. */
export function parseToolFlags(args: readonly string[]): ParsedToolFlags {
	const flags: ParsedToolFlags = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === "--no-tools" || arg === "-nt") flags.noTools = true;
		else if (VALUE_FLAGS.has(arg) && i + 1 < args.length) {
			const value = args[++i];
			if (arg === "--tools" || arg === "-t") {
				// pi refuses a list that mixes names with +/- entries, or a +/- entry with a pattern, and keeps no list.
				const tools = toolList(value);
				const modifiers = tools.filter(isModifier);
				if (modifiers.length === 0 || (modifiers.length === tools.length && !modifiers.some((entry) => entry.includes("*")))) flags.tools = tools;
			} else if (arg === "--exclude-tools" || arg === "-xt") flags.excludeTools = toolList(value);
		}
	}
	return flags;
}

/** The tool flags, as pi's `parseArgs` returns them. */
export interface ParsedToolFlags {
	tools?: string[];
	noTools?: boolean;
	excludeTools?: string[];
}

/** The registry filter pi builds from the flags: its allowlist and denylist, each tool names or `*` patterns. */
export interface PiToolFilter {
	allowed?: readonly string[];
	excluded?: readonly string[];
}

const isModifier = (entry: string) => entry.startsWith("+") || entry.startsWith("-");

/** The filter the flags make, or undefined when they filter nothing (pi's main.js and sdk.js). */
export function piToolFilter(flags: ParsedToolFlags): PiToolFilter | undefined {
	const modifiers = flags.tools?.some(isModifier) ? flags.tools : undefined;
	// A `+name`/`-name` list changes the starting selection; only under --no-tools, whose selection starts empty, is it the allowlist.
	const allowed = modifiers ? (flags.noTools ? withModifiers(modifiers) : undefined) : (flags.tools ?? (flags.noTools ? [] : undefined));
	// An empty denylist matches nothing.
	const excluded = flags.excludeTools?.length ? flags.excludeTools : undefined;
	if (allowed === undefined && excluded === undefined) return undefined;
	return { ...(allowed !== undefined ? { allowed } : {}), ...(excluded !== undefined ? { excluded } : {}) };
}

/** pi's applyToolModifiers on an empty selection. */
function withModifiers(entries: readonly string[]): string[] {
	const tools: string[] = [];
	for (const entry of entries) {
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}

/** Whether `name` is one of `entries`: an exact name, or a pattern where `*` matches any characters. */
function matches(entries: readonly string[], name: string): boolean {
	return entries.some((entry) => (entry.includes("*") ? patternRegExp(entry).test(name) : entry === name));
}

function patternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

/** Whether pi keeps `name` registered under `filter`. An allowlist keeps MCP tools it does not name, unless it is empty or names an `mcp__` entry. */
export function piRegisters(filter: PiToolFilter | undefined, name: string): boolean {
	if (!filter) return true;
	if (filter.excluded && matches(filter.excluded, name)) return false;
	const { allowed } = filter;
	if (!allowed || matches(allowed, name)) return true;
	const filtersMcp = allowed.length === 0 || allowed.some((entry) => entry.startsWith("mcp__"));
	return !filtersMcp && (name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name));
}

/** The filter as a session records it (lib/profile/profile.ts `profileKey`): a resume under other flags renders again. */
export function piToolFilterKey(filter: PiToolFilter | undefined): string | undefined {
	if (!filter) return undefined;
	const list = (entries: readonly string[] | undefined) => (entries === undefined ? "" : [...entries].sort().join(","));
	return `pi-tools:${filter.allowed === undefined ? "*" : list(filter.allowed)}|${list(filter.excluded)}`;
}
