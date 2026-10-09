/**
 * The `{"meta":{"resolvedPaths":…}}` transcript line
 * (auto-mode/resolved-paths-meta.ts): an in-project name that a symlink takes
 * outside the working directory is reported with where it lands, for bash,
 * PowerShell and the file tools; everything else gets no line.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { actionResolvedPaths, bashPathCandidates, RESOLVED_PATHS_NOTE, resolvedPathFacts } from "../../extensions/auto-mode/resolved-paths-meta.ts";
import { renderTranscript } from "../../extensions/auto-mode/transcript.ts";
import { HAVE_POWERSHELL, POWERSHELL_TEST_TIMEOUT, psParse } from "./helpers/powershell-parse.ts";

// The real spelling (macOS tmpdir is under a symlinked /var): the line reports the filesystem's own case.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "resolved-paths-")));
const cwd = join(root, "project");
const outside = join(root, "outside");
const extra = join(root, "extra");
for (const dir of [join(cwd, "src"), outside, extra]) mkdirSync(dir, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "s\n");
writeFileSync(join(cwd, "src", "a.txt"), "a\n");
symlinkSync(join(outside, "secret.txt"), join(cwd, " leading.txt"));
symlinkSync(join(outside, "secret.txt"), join(cwd, "link`name.txt"));
symlinkSync(outside, join(cwd, "out"));
symlinkSync(join(cwd, "src"), join(cwd, "inner")); // a link that stays inside
symlinkSync(extra, join(cwd, "ws")); // a link into a workspace directory
afterAll(() => rmSync(root, { recursive: true, force: true }));

const opts = { cwd, home: root, roots: [cwd, extra] };
const secret = join(outside, "secret.txt");

describe("resolvedPathFacts", () => {
	it("reports an in-project name, or a path under an in-project link, that resolves outside", () => {
		expect(resolvedPathFacts([" leading.txt", "out/new.txt"], opts)).toEqual([
			{ path: " leading.txt", resolvesTo: secret },
			{ path: "out/new.txt", resolvesTo: join(outside, "new.txt") },
		]);
	});

	it("reports a path spelled through the alias the working directory was given as", () => {
		const alias = join(root, "alias");
		symlinkSync(cwd, alias);
		const aliased = { cwd: alias, home: root, roots: [alias] };
		expect(resolvedPathFacts([join(alias, " leading.txt"), " leading.txt"], aliased)).toEqual([
			{ path: join(alias, " leading.txt"), resolvesTo: secret },
			{ path: " leading.txt", resolvesTo: secret },
		]);
	});

	it("reports nothing for paths that stay inside, lead into a workspace directory, or are outside as spelled", () => {
		expect(resolvedPathFacts(["src/a.txt", "inner/a.txt", "ws/x.txt", "missing.txt", "-Value", secret, "../outside/secret.txt", ""], opts)).toBeUndefined();
	});
});

describe("actionResolvedPaths per tool", () => {
	it("bash: every constant word, redirect target and --opt=value", () => {
		expect(bashPathCandidates("cat ' leading.txt' --file=out/x > out/y")).toEqual(expect.arrayContaining([" leading.txt", "out/x", "out/y"]));
		expect(actionResolvedPaths("bash", "echo hi > ' leading.txt'", undefined, opts)).toEqual([{ path: " leading.txt", resolvesTo: secret }]);
		expect(actionResolvedPaths("bash", "cat src/a.txt | grep a", undefined, opts)).toBeUndefined();
	});

	it("a path tool: its path argument; any other tool: nothing", () => {
		expect(actionResolvedPaths("write", "out/evil.sh", undefined, opts)).toEqual([{ path: "out/evil.sh", resolvesTo: join(outside, "evil.sh") }]);
		expect(actionResolvedPaths("write", "src/b.txt", undefined, opts)).toBeUndefined();
		expect(actionResolvedPaths("web_fetch", "out/evil.sh", undefined, opts)).toBeUndefined();
	});

	it("powershell without a parse reports nothing", () => {
		expect(actionResolvedPaths("powershell", "Set-Content ' leading.txt' x", undefined, opts)).toBeUndefined();
	});
});

describe.skipIf(!HAVE_POWERSHELL)("actionResolvedPaths on PowerShell's parse", { timeout: POWERSHELL_TEST_TIMEOUT }, () => {
	it("reports PowerShell's own value, and the spelling -Path unescapes", async () => {
		const at = async (command: string) => actionResolvedPaths("powershell", command, await psParse(command), opts);
		expect(await at("Set-Content -LiteralPath ' leading.txt' -Value x")).toEqual([{ path: " leading.txt", resolvesTo: secret }]);
		expect(await at("Set-Content -Path 'link``name.txt' -Value x")).toEqual([{ path: "link`name.txt", resolvesTo: secret }]);
		expect(await at("Set-Content out\\x.txt y")).toEqual([{ path: "out\\x.txt", resolvesTo: join(outside, "x.txt") }]);
		expect(await at("Get-Content src/a.txt")).toBeUndefined();
	});
});

describe("the rendered line", () => {
	it("sits above the action with its explanation", () => {
		const text = renderTranscript([
			{ kind: "resolved-paths", resolvedPaths: [{ path: " leading.txt", resolvesTo: secret }] },
			{ kind: "tool", tool: "powershell", input: { command: "Set-Content ' leading.txt' x" } },
		]);
		expect(text.split("\n")).toEqual([
			"<transcript>",
			JSON.stringify({ meta: { resolvedPaths: [{ path: " leading.txt", resolvesTo: secret }], note: RESOLVED_PATHS_NOTE } }),
			'{"PowerShell":"Set-Content \' leading.txt\' x"}',
			"</transcript>",
		]);
	});
});

describe("the line's bounds", () => {
	it("stays adjacent to a large action without dropping older entries", () => {
		const big = `echo ${"x".repeat(70_000)} >> ' leading.txt'`;
		const lines = renderTranscript([
			{ kind: "user", text: "older" },
			{ kind: "meta", gitStatus: { clean: true } },
			{ kind: "resolved-paths", resolvedPaths: [{ path: " leading.txt", resolvesTo: secret }] },
			{ kind: "tool", tool: "bash", input: { command: big } },
		]).split("\n");
		expect(lines[1]).toBe('{"user":"older"}');
		expect(lines[2]).toBe('{"meta":{"gitStatus":{"clean":true}}}');
		expect(lines[3]).toContain('"resolvedPaths"');
		expect(lines[4]).toContain(big);
	});

	it("reports at most 16 paths", () => {
		const many = Array.from({ length: 40 }, (_, i) => `out/f${i}.txt`);
		expect(resolvedPathFacts(many, opts)).toHaveLength(16);
	});
});
