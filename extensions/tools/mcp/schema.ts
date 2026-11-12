/**
 * Tool naming and JSON Schema → TypeBox conversion (pure).
 *
 * MCP servers describe their tools with plain JSON Schema. pi expects TypeBox
 * schemas, so rather than relying on a raw schema object happening to satisfy
 * TypeBox's runtime checks, the common subset is converted explicitly and
 * anything exotic degrades to a permissive object that passes arguments through.
 */

import { crc32 } from "node:zlib";
import { type TSchema, Type } from "typebox";
import { type ImageProblem, mcpResultText } from "./text.ts";

/**
 * Claude Code's namespacing: `mcp__<server>__<tool>`. Hyphens are KEPT (CC's
 * captures show `mcp__plugin_context7_context7__query-docs`), so a user's
 * existing `mcp__…` permission rules and hook matchers keep matching; anything
 * else outside `[A-Za-z0-9_-]` (a plugin server's `plugin:x:y` colons, dots)
 * becomes `_`, as in CC.
 */
export function namespacedToolName(server: string, tool: string): string {
	const clean = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `mcp__${clean(server)}__${clean(tool)}`;
}

/** CC's name for a plugin-provided server: `plugin:<plugin>:<server>`, so two plugins' `github` servers cannot collide with each other or with the user's. */
export function pluginServerName(pluginName: string, serverName: string): string {
	return `plugin:${pluginName}:${serverName}`;
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

/**
 * A server's tool and parameter descriptions ride every request as
 * deferred-definition bytes with no bound; a malicious or careless server can
 * make each one arbitrarily large. Cap them at registration with a labelled
 * marker (review L2). 4 KB is far more than any real
 * description needs.
 */
export const DESCRIPTION_CAP = 4096;
export function capDescription(text: string | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	return text.length > DESCRIPTION_CAP ? mcpResultText.tool.descriptionCut({ head: text.slice(0, DESCRIPTION_CAP), chars: text.length }) : text;
}

/** TypeBox options carrying a (capped) description, or none. */
function descriptionOptions(schema: JsonSchema): Record<string, unknown> {
	const capped = capDescription(schema.description);
	return capped ? { description: capped } : {};
}

function convertLeaf(schema: JsonSchema): TSchema | undefined {
	const options = descriptionOptions(schema);

	switch (schema.type) {
		case "string":
			return Type.String(options);
		case "number":
			return Type.Number(options);
		case "integer":
			return Type.Integer(options);
		case "boolean":
			return Type.Boolean(options);
		case "null":
			return Type.Null(options);
		case "array":
			return Type.Array(schema.items ? jsonSchemaToTypeBox(schema.items) : Type.Unknown(), options);
		default:
			return undefined;
	}
}

/**
 * Converts a JSON Schema to a TypeBox schema. Enums become literal unions;
 * unrecognised constructs become `Unknown`, which validates anything, so an
 * unusual server schema degrades to passing arguments through rather than
 * rejecting every call. Descriptions past the cap are cut with a label (`capDescription`).
 */
export function jsonSchemaToTypeBox(schema: JsonSchema | undefined): TSchema {
	if (!schema || typeof schema !== "object") return Type.Unknown();

	const options = descriptionOptions(schema);

	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const literals = schema.enum
			.filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value))
			.map((value) => Type.Literal(value));
		if (literals.length === schema.enum.length) {
			return literals.length === 1 ? literals[0] : Type.Union(literals, options);
		}
		return Type.Unknown();
	}

	if (Array.isArray(schema.type) && schema.type.length > 0) {
		if (schema.type.length === 1) return jsonSchemaToTypeBox({ ...schema, type: schema.type[0] });
		// TypeBox emits anyOf, which pi's provider converters understand. Keep
		// the description on the union, not on each of its generated branches.
		return Type.Union(
			schema.type.map((type) => jsonSchemaToTypeBox({ ...schema, type, description: undefined })),
			options,
		);
	}

	if (schema.type === "object" || (schema.type === undefined && schema.properties)) {
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
			parts.push(mcpResultText.content.binaryResource({ uri: entry.uri, mimeType: entry.mimeType, kb: size }));
		}
	}
	return parts.join("\n").trim();
}

/** Decoded size a single image block may occupy before it is refused. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * A server names an image's `mimeType`, but the provider decodes the bytes: an
 * undecodable block (a truncated PNG, a base64 string with a wrong `mimeType`)
 * makes the provider answer 400 "Could not process image" on that request and
 * on every later one, since the block stays in the history. So the bytes are
 * checked against a small magic-number allow-list here and `mimeType` is
 * derived from them, never trusted; a block that fails becomes a text note.
 * A valid signature is not enough: a PNG signature followed by garbage passed
 * the sniff and still poisoned the session. So the container is walked to its
 * end too (`wholeImageProblem`): PNG chunks with their CRCs from IHDR to IEND,
 * JPEG segments to the scan and the end-of-image marker, the GIF trailer, the
 * WebP RIFF length. It is not a pixel decode, so a crafted image with a valid
 * container can still fail at the provider; a corrupt or truncated one cannot.
 */
/** Base64 length that decodes to just over the byte ceiling (4 base64 chars per 3 bytes). */
const MAX_IMAGE_BASE64_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3);

export function validateImageData(
	data: string,
	claimedMime: string | undefined,
): { ok: true; mimeType: string } | { ok: false; problem: ImageProblem; bytes: number } {
	// Bound and sniff from the base64 string itself: decoding the whole payload
	// (up to ~6.7 MB) just to read a 12-byte magic number and a length is pure
	// waste — the block ships as the original base64 string regardless. Cap on
	// the string length, then decode only a 24-char (4-aligned) prefix to sniff.
	if (data.length === 0) return { ok: false, problem: { kind: "empty" }, bytes: 0 };
	const approxBytes = Math.floor((data.length * 3) / 4);
	if (data.length > MAX_IMAGE_BASE64_LENGTH) {
		return { ok: false, problem: { kind: "tooLarge", bytes: approxBytes, limit: MAX_IMAGE_BYTES }, bytes: approxBytes };
	}
	const head = Buffer.from(data.slice(0, 24), "base64");
	if (head.length === 0) return { ok: false, problem: { kind: "emptyAfterDecode" }, bytes: 0 };
	const mime = sniffImageMime(head);
	if (!mime) return { ok: false, problem: { kind: "unrecognised", claimed: claimedMime }, bytes: approxBytes };
	const bytes = Buffer.from(data, "base64");
	const problem = wholeImageProblem(bytes, mime);
	if (problem) return { ok: false, problem, bytes: bytes.length };
	return { ok: true, mimeType: mime };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A JPEG end-of-image marker. */
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

/** The end of `buf` with trailing zero padding dropped (some encoders pad after the end marker). */
function paddedEnd(buf: Buffer): number {
	let end = buf.length;
	while (end > 0 && buf[end - 1] === 0x00) end--;
	return end;
}

/** Why the image's container is not whole, or undefined when it is. Pure. */
export function wholeImageProblem(buf: Buffer, mime: string): ImageProblem | undefined {
	const png = (defect: Extract<ImageProblem, { kind: "png" }>["defect"], chunk?: string): ImageProblem => ({ kind: "png", defect, ...(chunk === undefined ? {} : { chunk }) });
	const jpeg = (defect: Extract<ImageProblem, { kind: "jpeg" }>["defect"]): ImageProblem => ({ kind: "jpeg", defect });
	const gif = (defect: Extract<ImageProblem, { kind: "gif" }>["defect"]): ImageProblem => ({ kind: "gif", defect });
	const webp = (defect: Extract<ImageProblem, { kind: "webp" }>["defect"]): ImageProblem => ({ kind: "webp", defect });
	if (mime === "image/png") {
		if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return png("signature");
		let offset = 8;
		let first = true;
		let sawData = false;
		for (;;) {
			if (offset + 12 > buf.length) return png("noEnd");
			const length = buf.readUInt32BE(offset);
			const type = buf.toString("latin1", offset + 4, offset + 8);
			if (offset + 12 + length > buf.length) return png("chunkPastData", type);
			if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== buf.readUInt32BE(offset + 8 + length)) return png("checksum", type);
			if (first) {
				if (type !== "IHDR" || length !== 13) return png("headerNotFirst");
				if (buf.readUInt32BE(offset + 8) === 0 || buf.readUInt32BE(offset + 12) === 0) return png("zeroSize");
				first = false;
			}
			if (type === "IDAT") sawData = true;
			offset += 12 + length;
			if (type === "IEND") return sawData ? undefined : png("noData");
		}
	}
	if (mime === "image/jpeg") {
		let offset = 2;
		for (;;) {
			if (offset + 2 > buf.length) return jpeg("noScan");
			if (buf[offset] !== 0xff) return jpeg("badMarker");
			const marker = buf[offset + 1];
			if (marker === 0xff) {
				offset++; // fill byte
				continue;
			}
			if (marker === 0xda) break; // start of scan: entropy-coded data follows
			if (marker === 0xd9) return jpeg("endsBeforeScan");
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				offset += 2;
				continue;
			}
			if (offset + 4 > buf.length) return jpeg("truncated");
			const length = buf.readUInt16BE(offset + 2);
			if (length < 2 || offset + 2 + length > buf.length) return jpeg("segmentPastData");
			offset += 2 + length;
		}
		// The EOI marker anywhere after the scan: scan data escapes every 0xFF, and
		// bytes after EOI (a vendor trailer, a Motion Photo payload) are allowed.
		return buf.indexOf(JPEG_EOI, offset + 2) !== -1 ? undefined : jpeg("noEnd");
	}
	if (mime === "image/gif") {
		const header = buf.toString("latin1", 0, 6);
		if (header !== "GIF87a" && header !== "GIF89a") return gif("header");
		if (buf.length < 14) return gif("truncated");
		if (buf.readUInt16LE(6) === 0 || buf.readUInt16LE(8) === 0) return gif("zeroSize");
		const end = paddedEnd(buf);
		return buf[end - 1] === 0x3b ? undefined : gif("noTrailer");
	}
	if (mime === "image/webp") {
		if (buf.length < 20) return webp("truncated");
		const riffEnd = buf.readUInt32LE(4) + 8;
		if (riffEnd > buf.length) return webp("shorterThanRiff");
		const chunk = buf.toString("latin1", 12, 16);
		if (chunk !== "VP8 " && chunk !== "VP8L" && chunk !== "VP8X") return webp("noImage");
		if (20 + buf.readUInt32LE(16) > riffEnd) return webp("chunkPastData");
		return undefined;
	}
	return { kind: "unsupported", mime };
}

/** Magic-number sniff for the formats Anthropic accepts. Returns undefined for anything else. */
function sniffImageMime(buf: Buffer): string | undefined {
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
	if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return undefined;
}

export function describeContent(
	blocks: McpContentBlock[] | undefined,
	serverName?: string,
): {
	text: string;
	images: Array<{ data: string; mimeType: string }>;
} {
	const texts: string[] = [];
	const images: Array<{ data: string; mimeType: string }> = [];

	for (const block of blocks ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			texts.push(block.text);
		} else if (block.type === "image" && block.data) {
			const checked = validateImageData(block.data, block.mimeType);
			if (checked.ok) images.push({ data: block.data, mimeType: checked.mimeType });
			else texts.push(mcpResultText.content.imageUndecodable({ server: serverName, problem: checked.problem, bytes: checked.bytes }));
		} else if (block.type === "resource" && block.resource) {
			texts.push(block.resource.text ?? mcpResultText.content.resource(block.resource.uri));
		} else {
			texts.push(mcpResultText.content.other(block.type));
		}
	}

	return { text: texts.join("\n").trim(), images };
}
