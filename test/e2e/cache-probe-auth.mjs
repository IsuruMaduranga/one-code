#!/usr/bin/env node
// Check which credential a cache probe's requests went out with, and on which
// model: reads the WIRE_AUTH_DUMP lines dump-requests.ts writes (whether each
// request carried `Authorization: Bearer` and `x-api-key`, never a value).
//
//   node test/e2e/cache-probe-auth.mjs <auth.jsonl>... --auth login|key --model <id>
//
// `login` (an Anthropic login): every request bearer, none with x-api-key.
// `key`: every request with x-api-key, none bearer. `--model`: every request
// on that model id, so a classifier, title or subagent call that went to
// another model fails the probe. Exits non-zero on any failure, on no requests,
// and on a passed file that cannot be read (named on stderr).
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const files = [];
let auth;
let model;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--auth") auth = args[++i];
	else if (args[i] === "--model") {
		if (i + 1 >= args.length) {
			console.error("--model needs a value: a model id");
			process.exit(2);
		}
		model = args[++i];
	}
	else files.push(args[i]);
}
if (!["login", "key"].includes(auth) || files.length === 0) {
	console.error("usage: cache-probe-auth.mjs <auth.jsonl>... --auth login|key [--model <id>]");
	process.exit(2);
}

let failed = 0;
const rows = files.flatMap((file) => {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		console.error(`cannot read ${file}: ${error instanceof Error ? error.message : error}`);
		failed++;
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
});

const fail = (message) => {
	console.log(`FAIL  ${message}`);
	failed++;
};
if (rows.length === 0) fail("no request recorded its credential (is dump-requests.ts loaded with WIRE_AUTH_DUMP?)");
const wrongAuth = rows.filter((row) => (auth === "login" ? !row.bearer || row.apiKey : !row.apiKey || row.bearer));
if (rows.length > 0 && wrongAuth.length === 0) {
	console.log(`PASS  ${rows.length} requests used the ${auth === "login" ? "login (Authorization: Bearer, no x-api-key)" : "API key (x-api-key, no bearer)"}`);
} else if (wrongAuth.length > 0) {
	fail(`${wrongAuth.length} of ${rows.length} requests did not use the ${auth}: ${JSON.stringify(wrongAuth[0])}`);
}
if (model !== undefined) {
	const others = [...new Set(rows.filter((row) => row.model !== model).map((row) => row.model))];
	if (others.length === 0 && rows.length > 0) console.log(`PASS  every request went to ${model}`);
	else if (others.length > 0) fail(`requests went to ${others.join(", ")}, not only ${model}`);
}
process.exit(failed > 0 ? 1 : 0);
