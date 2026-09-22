import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDoctorCliReport, runDoctorCli } from "../../extensions/doctor/cli.ts";
import { piRoot, repoRoot } from "./helpers/pi-install.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "onecode-doctor-cli-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const options = () => ({
	agentDir: join(home, "agent"),
	cwd: join(home, "project"),
	home,
	env: { HOME: home, PATH: "" } as NodeJS.ProcessEnv,
	version: "0.2.1",
	install: "app" as const,
	piVersion: "0.85.1",
	network: false,
	columns: 100,
});

describe("onecode doctor (headless)", () => {
	it("builds the report from pi's own auth/model files with no session and no network", async () => {
		mkdirSync(join(home, "project"), { recursive: true });
		mkdirSync(join(home, "agent"), { recursive: true });
		writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5", defaultThinkingLevel: "high" }));
		const report = await collectDoctorCliReport(options());
		// No credentials anywhere: the saved default cannot be used, so nothing is ready.
		expect(report.ready).toBe(false);
		expect(report.findings.some((f) => f.level === "error" && f.text.includes("No model provider is configured"))).toBe(true);
		const text = report.sections.flatMap((s) => s.lines.map((l) => l.text));
		expect(text.some((t) => t.startsWith("Running: the bundled onecode app 0.2.1 · pi 0.85.1"))).toBe(true);
		expect(text.some((t) => t.includes("known providers"))).toBe(true);
	});

	it("prints the report with the in-session hint and exits 1 when nothing is ready", async () => {
		mkdirSync(join(home, "project"), { recursive: true });
		const chunks: string[] = [];
		const code = await runDoctorCli(options(), (text) => chunks.push(text));
		const out = chunks.join("");
		expect(code).toBe(1);
		expect(out.startsWith("One Code doctor\n")).toBe(true);
		expect(out).toContain("For a full setup checkup that can also fix issues, run /doctor inside an onecode session.");
		expect(out).toContain("/doctor report shows this report alone");
		expect(out.split("\n").every((line) => line.length <= 100)).toBe(true);
	});
});

describe("app/bin.mjs doctor routing (pin against the installed pi)", () => {
	it("can reach jiti from pi's own dependency tree, the way bin.mjs resolves it", () => {
		const piRequire = createRequire(join(piRoot, "dist", "index.js"));
		expect(piRequire.resolve("jiti")).toMatch(/jiti[\\/]lib[\\/]jiti\.cjs$/);
	});

	it("routes `onecode doctor` before pi is imported", () => {
		const source = readFileSync(join(repoRoot, "app", "bin.mjs"), "utf8");
		const doctorAt = source.indexOf('argv[0] === "doctor"');
		const piImportAt = source.indexOf('await import("@earendil-works/pi-coding-agent")');
		expect(doctorAt).toBeGreaterThan(0);
		expect(piImportAt).toBeGreaterThan(doctorAt);
		expect(source).toContain('join(corePath, "extensions", "doctor", "cli.ts")');
	});

	it("publishes the install method before the doctor fast path exits", () => {
		// The doctor's update lookup reads ONECODE_INSTALL_METHOD (Homebrew waits a
		// day for a release); set after `process.exit()` in the doctor branch it
		// would never be seen by `onecode doctor`.
		const source = readFileSync(join(repoRoot, "app", "bin.mjs"), "utf8");
		const methodAt = source.indexOf("process.env.ONECODE_INSTALL_METHOD ||=");
		const doctorRunAt = source.indexOf("if (runDoctor) {");
		expect(methodAt).toBeGreaterThan(0);
		expect(doctorRunAt).toBeGreaterThan(methodAt);
	});
});
