import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THREADED_API, threadlessAnthropicProvider, withoutMessageThreads } from "../../extensions/lib/request/message-threads.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

describe("withoutMessageThreads", () => {
	it("turns threads off on an anthropic-messages model, without touching the original", () => {
		const model = { id: "claude-sonnet-5", api: THREADED_API, provider: "anthropic", compat: { supportsMidConvoEffort: true } };
		const copy = withoutMessageThreads(model);
		expect(copy).not.toBe(model);
		expect(copy.compat).toEqual({ supportsMidConvoEffort: true, supportsMessageThreads: false });
		expect(model.compat).toEqual({ supportsMidConvoEffort: true });
		expect(copy.id).toBe("claude-sonnet-5");
	});

	it("overrides a model that turns threads on, and adds compat to a model without one", () => {
		expect(withoutMessageThreads({ api: THREADED_API, compat: { supportsMessageThreads: true } }).compat).toEqual({ supportsMessageThreads: false });
		expect(withoutMessageThreads<{ api: string; compat?: unknown }>({ api: THREADED_API }).compat).toEqual({ supportsMessageThreads: false });
	});

	it("returns the model itself on other APIs and when threads are already off", () => {
		const responses = { api: "openai-responses", compat: { supportsMessageThreads: true } };
		expect(withoutMessageThreads(responses)).toBe(responses);
		const off = { api: THREADED_API, compat: { supportsMessageThreads: false } };
		expect(withoutMessageThreads(off)).toBe(off);
	});
});

describe("threadlessAnthropicProvider", () => {
	it("registers for anthropic-messages and hands the stream a threadless model with the context and options unchanged", () => {
		const calls: unknown[][] = [];
		const config = threadlessAnthropicProvider((model: { api: string; compat?: unknown }, context: string, options?: { sessionId: string }) => {
			calls.push([model, context, options]);
			return "stream";
		});
		expect(config.api).toBe("anthropic-messages");
		const model = { api: THREADED_API, compat: {} };
		expect(config.streamSimple(model, "ctx", { sessionId: "s" })).toBe("stream");
		expect(calls).toEqual([[{ api: THREADED_API, compat: { supportsMessageThreads: false } }, "ctx", { sessionId: "s" }]]);
	});
});

describe("side calls", () => {
	// A side call goes straight to pi-ai, past the provider registration, so it
	// must turn threads off itself and must not take pi-ai compat's key from the
	// environment: lib/request/anthropic-stream.ts completeThreadless does both.
	// No other file under extensions/ or profile/ may call a pi-ai stream entry.
	const STREAM_ENTRY = /\b(complete|completeSimple|stream|streamSimple)\b/;
	const PI_AI_IMPORT = /import\s+(?!type\b)(\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+["']@earendil-works\/pi-ai(?:\/[^"']*)?["']/g;
	const OWNER = join("extensions", "lib", "request", "anthropic-stream.ts");

	it("only anthropic-stream.ts imports pi-ai's stream entries or the whole module's compat view", () => {
		const offenders: string[] = [];
		for (const root of ["extensions", "profile"]) {
			for (const file of sourceFiles(join(repo, root))) {
				const path = relative(repo, file);
				if (path === OWNER || path.split(/[\\/]/).includes("test")) continue;
				for (const match of readFileSync(file, "utf8").matchAll(PI_AI_IMPORT)) {
					const names = match[1].replace(/\btype\s+\w+/g, "");
					const wholeCompat = match[1].startsWith("*") && /pi-ai\/compat/.test(match[0]);
					if (STREAM_ENTRY.test(names) || wholeCompat) offenders.push(`${path}: ${match[0]}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the side calls reach pi-ai through completeThreadless", () => {
		const callers = sourceFiles(join(repo, "extensions")).filter((file) => /\bcompleteThreadless\(/.test(readFileSync(file, "utf8")));
		expect(callers.length).toBeGreaterThanOrEqual(6);
	});
});
