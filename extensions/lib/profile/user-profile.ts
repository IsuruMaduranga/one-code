/**
 * A user's own profile: a saved, named set of choices over the product's
 * profile, chosen at launch (`--profile <name>`, lib/profile/brand.mjs). It is
 * data, never code, in one folder of the user's own:
 *
 *   <shared state dir>/profiles/<name>/
 *     profile.json               the switches (all optional):
 *                                  { "description": "…", "base": "<product profile id>",
 *                                    "tools": { "off": [], "deferred": [], "eager": [] },
 *                                    "features": { "off": [] } }
 *     system-prompt.md           replaces the system prompt
 *     append-system-prompt.md    is added after it
 *     tools/<tool>.md            replaces that tool's description
 *     tools/<tool>.append.md     is added after it
 *
 * It can only narrow what the product's profile allows: it turns tools and
 * optional features off (never a guard feature, never a pinned tool), moves a
 * tool behind tool_search or out from behind it, and words what the model
 * reads about the session's tools. It never reaches the permission gate, the
 * hooks or the classifier's ruleset, and it is never read from a project
 * (`resolveProfile` applies and checks it, lib/profile/profile.ts).
 *
 * Pure apart from reading the folder; no pi imports.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { productProfileId, PROFILE_NAME, userProfileFile } from "./brand.mjs";
import { dirname } from "node:path";
import { isPlainObject } from "../core/plain-object.ts";

/** A user's wording for one tool: its description replaced, added to, or both. */
export interface ToolWording {
	replace?: string;
	append?: string;
}

export interface UserProfile {
	name: string;
	/** The profile's folder. */
	dir: string;
	description?: string;
	/** The product profile it sits on, as written; absent: the default one. */
	base?: string;
	toolsOff: readonly string[];
	toolsDeferred: readonly string[];
	toolsEager: readonly string[];
	featuresOff: readonly string[];
	/** The text that replaces the system prompt. */
	systemPrompt?: string;
	/** The text added after the system prompt. */
	appendSystemPrompt?: string;
	toolWording: ReadonlyMap<string, ToolWording>;
	/** A short hash of everything above: a session records it, so a profile edited between runs is rendered again. */
	hash: string;
}

const FIELDS = new Set(["description", "base", "tools", "features"]);
const TOOL_LISTS = ["off", "deferred", "eager"] as const;
const APPEND_SUFFIX = ".append.md";

/** The names of `value[key]`, a list of strings; a problem when it is anything else. */
function names(value: unknown, where: string, problems: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		problems.push(`${where} must be a list of names`);
		return [];
	}
	return value.map((item: string) => item.trim());
}

/** A text file's content without its final newline, or undefined when the file is absent; an empty one is a problem. */
function textFile(path: string, problems: string[]): string | undefined {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
	if (text.trim() === "") {
		problems.push(`${path} is empty: delete it, or write the text`);
		return undefined;
	}
	return text;
}

/**
 * Read the profile `name` from `dir`. Every problem is one sentence that
 * names the file; a profile with problems is not returned, so a launch that
 * asked for it stops instead of running without it.
 */
export function loadUserProfile(name: string, dir: string, productProfiles: readonly string[] = []): { profile?: UserProfile; problems: string[] } {
	const problems: string[] = [];
	if (name === "") return { problems: ["--profile needs a name: the profile's folder name, or one of the product's profiles"] };
	if (!PROFILE_NAME.test(name)) return { problems: [`"${name}" is not a profile name (letters, digits, ".", "_", "-")`] };
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		const known = productProfiles.length > 0 ? ` (the product's own profiles: ${productProfiles.join(", ")})` : "";
		return { problems: [`no profile is named "${name}": create the folder ${dir} with a profile.json, system-prompt.md, append-system-prompt.md or tools/<tool>.md in it${known}`] };
	}
	// The same file and the same id rule the brand reads the profile's `base` by (lib/profile/brand.mjs).
	const file = userProfileFile(dirname(dir), name);
	let data: Record<string, unknown> = {};
	if (existsSync(file)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!isPlainObject(parsed)) problems.push(`${file} must hold a JSON object`);
			else data = parsed;
		} catch (error) {
			problems.push(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	for (const key of Object.keys(data)) if (!FIELDS.has(key)) problems.push(`${file}: unknown field "${key}" (known: ${[...FIELDS].join(", ")})`);
	if (data.description !== undefined && typeof data.description !== "string") problems.push(`${file}: "description" must be text`);
	let base: string | undefined;
	if (data.base !== undefined) {
		const match = typeof data.base === "string" ? productProfileId(productProfiles, data.base) : undefined;
		if (match === undefined) problems.push(`${file}: "base" must name one of the product's profiles (${productProfiles.join(", ") || "this product has only its default one, so leave it out"})`);
		else base = match;
	}
	const tools = data.tools ?? {};
	const lists: Record<(typeof TOOL_LISTS)[number], string[]> = { off: [], deferred: [], eager: [] };
	if (!isPlainObject(tools)) problems.push(`${file}: "tools" must be an object with ${TOOL_LISTS.join(", ")}`);
	else {
		for (const key of Object.keys(tools)) if (!(TOOL_LISTS as readonly string[]).includes(key)) problems.push(`${file}: unknown field "tools.${key}" (known: ${TOOL_LISTS.join(", ")})`);
		for (const key of TOOL_LISTS) lists[key] = names(tools[key], `${file}: "tools.${key}"`, problems);
		for (const tool of lists.deferred) if (lists.eager.includes(tool)) problems.push(`${file}: "${tool}" is in both "tools.deferred" and "tools.eager"`);
	}
	const features = data.features ?? {};
	let featuresOff: string[] = [];
	if (!isPlainObject(features)) problems.push(`${file}: "features" must be an object with "off"`);
	else {
		for (const key of Object.keys(features)) if (key !== "off") problems.push(`${file}: unknown field "features.${key}" (a user's profile can only turn features off)`);
		featuresOff = names(features.off, `${file}: "features.off"`, problems);
	}
	const systemPrompt = textFile(join(dir, "system-prompt.md"), problems);
	const appendSystemPrompt = textFile(join(dir, "append-system-prompt.md"), problems);
	const toolWording = new Map<string, ToolWording>();
	const toolsDir = join(dir, "tools");
	if (existsSync(toolsDir)) {
		for (const entry of readdirSync(toolsDir).sort()) {
			if (entry.startsWith(".")) continue;
			const path = join(toolsDir, entry);
			if (!entry.endsWith(".md")) {
				problems.push(`${path}: a tool's wording is <tool>.md (its description) or <tool>${APPEND_SUFFIX} (added after it)`);
				continue;
			}
			const append = entry.endsWith(APPEND_SUFFIX);
			const tool = entry.slice(0, -(append ? APPEND_SUFFIX.length : ".md".length));
			const text = textFile(path, problems);
			if (text === undefined) continue;
			toolWording.set(tool, { ...toolWording.get(tool), ...(append ? { append: text } : { replace: text }) });
		}
	}
	if (problems.length > 0) return { problems };
	const hash = createHash("sha256")
		.update(JSON.stringify([base, lists, featuresOff, systemPrompt, appendSystemPrompt, [...toolWording]]))
		.digest("hex")
		.slice(0, 12);
	return {
		problems,
		profile: {
			name,
			dir,
			...(typeof data.description === "string" ? { description: data.description } : {}),
			...(base !== undefined ? { base } : {}),
			toolsOff: lists.off,
			toolsDeferred: lists.deferred,
			toolsEager: lists.eager,
			featuresOff,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
			...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
			toolWording,
			hash,
		},
	};
}

/** What the profile changes, in one line for /doctor: "2 tools off (a, b); system prompt added to; descriptions of bash, read". */
export function describeUserProfile(user: UserProfile): string {
	const list = (label: string, items: readonly string[]) => (items.length > 0 ? [`${items.length} ${label} (${items.join(", ")})`] : []);
	const parts = [
		...list(user.toolsOff.length === 1 ? "tool off" : "tools off", user.toolsOff),
		...list(user.featuresOff.length === 1 ? "feature off" : "features off", user.featuresOff),
		...list("behind tool_search", user.toolsDeferred),
		...list("loaded up front", user.toolsEager),
		...(user.systemPrompt !== undefined ? ["system prompt replaced"] : []),
		...(user.appendSystemPrompt !== undefined ? ["system prompt added to"] : []),
		...(user.toolWording.size > 0 ? [`its own wording for ${[...user.toolWording.keys()].join(", ")}`] : []),
	];
	return parts.length > 0 ? parts.join("; ") : "no changes";
}

/** `description` as the user's profile words the tool `name`: replaced, added to, or as it was. */
export function wordedByUser(user: Pick<UserProfile, "toolWording"> | undefined, name: string, description: string): string {
	const wording = user?.toolWording.get(name);
	if (!wording) return description;
	return [wording.replace ?? description, wording.append].filter((part) => part !== undefined).join("\n\n");
}
