import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import artifactsExtension from "../../extensions/artifacts/index.ts";
import { artifactsRoot, getArtifact, publishArtifact } from "../../extensions/artifacts/store.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rpc-artifacts-"));
	vi.stubEnv("ONECODE_STATE_DIR", dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function setup(confirm: (...args: any[]) => Promise<boolean>, signal?: AbortSignal) {
	const fake = createFakePi();
	artifactsExtension(fake.pi as never);
	const { meta } = publishArtifact(artifactsRoot(), {
		sourcePath: join(dir, "page.html"), html: "<title>Fixture</title><p>Hello</p>", now: new Date(), suffix: () => "abcdef",
	});
	const ctx = createFakeCtx({ cwd: dir, hasUI: true, mode: "rpc", signal, ui: { confirm } });
	const remove = () => fake.tools.get("artifact")!.execute("delete", { action: "delete", id: meta.id }, signal, undefined, ctx);
	return { remove, exists: () => getArtifact(artifactsRoot(), meta.id) !== undefined };
}

describe("RPC artifact deletion confirmation", () => {
	it("dismisses the confirmation on tool abort and preserves the artifact", async () => {
		const abort = new AbortController();
		let shown!: () => void;
		const opened = new Promise<void>((resolve) => { shown = resolve; });
		const t = setup((_title, _message, options?: { signal?: AbortSignal }) => new Promise((resolve) => {
			shown();
			if (options?.signal?.aborted) resolve(false);
			else options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
		}), abort.signal);
		const work = t.remove();
		await opened;
		abort.abort();
		expect(await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve("hung"), 100))])).toMatchObject({ isError: true });
		expect(t.exists()).toBe(true);
	});

	it("does not delete after an approval races with abort", async () => {
		const abort = new AbortController();
		const t = setup(async () => { abort.abort(); return true; }, abort.signal);
		expect(await t.remove()).toMatchObject({ isError: true });
		expect(t.exists()).toBe(true);
	});

	it("requires a literal affirmative confirmation from the client", async () => {
		const t = setup(async () => "false" as unknown as boolean);
		expect(await t.remove()).toMatchObject({ isError: true });
		expect(t.exists()).toBe(true);
	});

	it("still deletes after an affirmative answer when the tool is active", async () => {
		const t = setup(async () => true);
		expect(await t.remove()).not.toHaveProperty("isError", true);
		expect(t.exists()).toBe(false);
	});
});
