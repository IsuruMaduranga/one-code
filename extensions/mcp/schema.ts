/**
 * Tool naming and JSON Schema → TypeBox conversion (pure).
 *
 * MCP servers describe their tools with plain JSON Schema. pi expects TypeBox
 * schemas, so rather than relying on a raw schema object happening to satisfy
 * TypeBox's runtime checks, the common subset is converted explicitly and
 * anything exotic degrades to a permissive object that passes arguments through.
 */

import { type TSchema, Type } from "typebox";

/** Claude Code's namespacing: mcp__<server>__<tool>, sanitised for tool-name rules. */
export function namespacedToolName(server: string, tool: string): string {
	const clean = (part: string) => part.replace(/[^a-zA-Z0-9_]/g, "_");
	return `mcp__${clean(server)}__${clean(tool)}`;
}

export function parseNamespacedToolName(name: string): { server: string; tool: string } | undefined {
	if (!name.startsWith("mcp__")) return undefined;
	const rest = name.slice("mcp__".length);
	const separator = rest.indexOf("__");
	if (separator === -1) return undefined;
	return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

interface JsonSchema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	const?: unknown;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	[key: string]: unknown;
}

function convertLeaf(schema: JsonSchema): TSchema | undefined {
	const options = schema.description ? { description: schema.description } : {};
	const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;

	switch (type) {
		case "string":
			return Type.String(options);
		case "number":
			return Type.Number(options);
		case "integer":
			return Type.Integer(options);
		case "boolean":
			return Type.Boolean(options);
		case "array":
			return Type.Array(schema.items ? jsonSchemaToTypeBox(schema.items) : Type.Unknown(), options);
		case "object":
			return jsonSchemaToTypeBox(schema);
		default:
			return undefined;
	}
}

/**
 * Converts a JSON Schema to a TypeBox schema. Enums become literal unions;
 * unrecognised constructs become `Unknown`, which validates anything, so an
 * unusual server schema degrades to passing arguments through rather than
 * rejecting every call.
 */
export function jsonSchemaToTypeBox(schema: JsonSchema | undefined): TSchema {
	if (!schema || typeof schema !== "object") return Type.Unknown();

	const options = schema.description ? { description: schema.description } : {};

	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const literals = schema.enum
			.filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value))
			.map((value) => Type.Literal(value));
		if (literals.length === schema.enum.length) {
			return literals.length === 1 ? literals[0] : Type.Union(literals, options);
		}
		return Type.Unknown();
	}

	if (schema.properties || schema.type === "object") {
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		const properties: Record<string, TSchema> = {};
		for (const [key, value] of Object.entries(schema.properties ?? {})) {
			const converted = jsonSchemaToTypeBox(value);
			properties[key] = required.has(key) ? converted : Type.Optional(converted);
		}
		// additionalProperties stays open: servers commonly accept more than they declare.
		return Type.Object(properties, { ...options, additionalProperties: true });
	}

	const leaf = convertLeaf(schema);
	if (leaf) return leaf;

	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants) && variants.length > 0) {
		const converted = variants.map((variant) => jsonSchemaToTypeBox(variant));
		return converted.length === 1 ? converted[0] : Type.Union(converted, options);
	}

	return Type.Unknown();
}

/** MCP tool results carry typed content blocks; map the ones pi can display. */
export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { text?: string; uri?: string };
}

/**
 * `resources/read` returns resource *contents*, not typed content blocks: each
 * entry carries `text` or base64 `blob` plus `uri`/`mimeType`, with no `type`
 * field. They need their own formatter — running them through describeContent
 * yields "[undefined content]".
 */
export interface McpResourceContents {
	uri?: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

export function describeResourceContents(contents: McpResourceContents[] | undefined): string {
	const parts: string[] = [];
	for (const entry of contents ?? []) {
		if (typeof entry.text === "string") {
			parts.push(entry.text);
		} else if (typeof entry.blob === "string") {
			const size = Math.round((entry.blob.length * 3) / 4 / 1024);
			parts.push(`[binary resource ${entry.uri ?? ""} ${entry.mimeType ?? "unknown type"}, ~${size} KB]`);
		}
	}
	return parts.join("\n").trim();
}

export function describeContent(blocks: McpContentBlock[] | undefined): {
	text: string;
	images: Array<{ data: string; mimeType: string }>;
} {
	const texts: string[] = [];
	const images: Array<{ data: string; mimeType: string }> = [];

	for (const block of blocks ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			texts.push(block.text);
		} else if (block.type === "image" && block.data) {
			images.push({ data: block.data, mimeType: block.mimeType ?? "image/png" });
		} else if (block.type === "resource" && block.resource) {
			const { text, uri } = block.resource;
			texts.push(text ?? `[resource ${uri ?? "(no uri)"}]`);
		} else {
			texts.push(`[${block.type} content]`);
		}
	}

	return { text: texts.join("\n").trim(), images };
}
