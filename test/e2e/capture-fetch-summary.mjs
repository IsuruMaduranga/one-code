#!/usr/bin/env node
/**
 * One line per request in a capture-fetch.mjs file: when, host, path, status,
 * model, approximate request size and the cache fields the request carried.
 *
 *   node test/e2e/capture-fetch-summary.mjs /tmp/fetch.jsonl [more.jsonl ...]
 *
 * Columns: index, time (HH:MM:SS.mmm), method host path, status, model, size
 * (the body's bytes, as B, KB or MB), then `cache`:
 *   cc=N      cache_control markers anywhere in the body (Anthropic and
 *             Anthropic-shaped OpenRouter breakpoints); `cc=N+top` when one
 *             of them is at the top level of the body
 *   key=...   prompt_cache_key (first 12 characters)
 *   ret=...   prompt_cache_retention
 * A request with none of them shows `cache -`. The record has no response,
 * so cached-token counts come from the session's usage, not from here.
 * Exits 2 on a missing argument and 1 when a file cannot be read.
 */
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: capture-fetch-summary.mjs <fetch.jsonl>...");
	process.exit(2);
}

/** The count of `cache_control` keys at any depth of a parsed body. */
function countCacheControl(value) {
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countCacheControl(item), 0);
	if (value && typeof value === "object") {
		return Object.entries(value).reduce((sum, [key, item]) => sum + (key === "cache_control" ? 1 : 0) + countCacheControl(item), 0);
	}
	return 0;
}

const size = (bytes) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1_000 ? `${(bytes / 1_000).toFixed(1)} KB` : `${bytes} B`);

function cacheFields(body) {
	if (!body || typeof body !== "object") return "-";
	const parts = [];
	const markers = countCacheControl(body);
	if (markers) parts.push(`cc=${markers}${body.cache_control ? "+top" : ""}`);
	if (typeof body.prompt_cache_key === "string") parts.push(`key=${body.prompt_cache_key.slice(0, 12)}`);
	if (typeof body.prompt_cache_retention === "string") parts.push(`ret=${body.prompt_cache_retention}`);
	return parts.join(" ") || "-";
}

let failed = 0;
let index = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		console.error(`cannot read ${file}: ${error instanceof Error ? error.message : error}`);
		failed = 1;
		continue;
	}
	for (const line of text.split("\n").filter(Boolean)) {
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			console.error(`${file}: skipped a line that is not JSON`);
			continue;
		}
		const model = row.body && typeof row.body === "object" && typeof row.body.model === "string" ? row.body.model : "-";
		console.log(
			`${String(++index).padStart(3)}  ${String(row.ts).slice(11, 23)}  ${row.method} ${row.host}${row.path}  ${row.status}  model=${model}  ${size(row.bytes ?? 0)}  cache ${cacheFields(row.body)}`,
		);
	}
}
// Not process.exit: output still queued for a pipe its reader has not drained would be lost.
process.exitCode = failed;
