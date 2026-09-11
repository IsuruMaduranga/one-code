import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDoctorReport, summarizeProviders } from "../../extensions/doctor/build.ts";
import { collectModelFacts, modelsSection } from "../../extensions/doctor/models.ts";
import { type DoctorEnvironment, type Finding, type RegistryView, renderDoctorReport, renderDoctorText } from "../../extensions/doctor/report.ts";
import { setCapabilitySnapshotForTest, snapshotFromResponse } from "../../extensions/lib/capability-index.ts";
import { setModelFactsForTest } from "../../extensions/lib/model-facts.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Minimal structural stand-in; the checks read provider/id/api/cost/contextWindow only. */
const model = (provider: string, id: string, input?: number, api = "anthropic-messages") =>
	({ provider, id, name: id, api, cost: input === undefined ? undefined : { input, output: input * 5 }, contextWindow: 200_000 }) as any;

const anthropic = [model("anthropic", "claude-opus-5", 5), model("anthropic", "claude-sonnet-5", 3), model("anthropic", "claude-haiku-4-5", 1)];
const openai = [model("openai", "gpt-5.1", 1.25, "openai-responses"), model("openai", "gpt-5-mini", 0.25, "openai-responses")];

function registry(available: any[], all = [...anthropic, ...openai, model("groq", "llama-3.3-70b", 0.5, "openai-completions")]): RegistryView {
	const ready = new Set(available.map((m) => m.provider));
	return {
		all,
		available,
		authStatus: (provider) => (ready.has(provider) ? { configured: true, source: "stored" } : { configured: false }),
		displayName: (provider) => provider.toUpperCase(),
	};
}

let home: string;
let cwd: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "onecode-doctor-home-"));
	cwd = mkdtempSync(join(tmpdir(), "onecode-doctor-cwd-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

function environment(overrides: Partial<DoctorEnvironment> = {}): DoctorEnvironment {
	return {
		cwd,
		home,
		agentDir: join(home, ".onecode", "agent"),
		stateDir: join(home, ".onecode"),
		// A clean env: no provider keys, no CLAUDE_CONFIG_DIR, a PATH with nothing on it.
		env: { PATH: join(home, "empty-bin"), HOME: home },
		platform: "darwin",
		arch: "arm64",
		nodeVersion: "26.3.1",
		oneCodeVersion: "0.2.1",
		install: "app",
		piVersion: "0.85.1",
		...overrides,
	};
}

describe("summarizeProviders", () => {
	it("marks providers with credentials ready, sorted ready-first", () => {
		const summary = summarizeProviders(registry(anthropic));
		expect(summary[0]).toMatchObject({ provider: "anthropic", ready: true, source: "key saved by /login", models: 3, available: 3 });
		expect(summary.filter((p) => p.ready)).toHaveLength(1);
		expect(summary.map((p) => p.provider)).toEqual(["anthropic", "groq", "openai"]);
	});
});

describe("buildDoctorReport", () => {
	it("is not ready when no provider has credentials, and says how to fix it", () => {
		const report = buildDoctorReport({ env: environment(), registry: registry([]), session: { modelSource: "none" } });
		expect(report.ready).toBe(false);
		expect(report.summary).toMatch(/^Not ready: no model provider has credentials/);
		const problem = report.findings.find((f) => f.level === "error");
		expect(problem?.text).toContain("No model provider is configured");
		expect(problem?.fix).toContain("/login");
		expect(renderDoctorText(report)).toContain("Main: none");
	});

	it("reports every role's model with its source on a ready setup", () => {
		const report = buildDoctorReport({
			env: environment({ latest: { status: "current", version: "0.2.1" } }),
			registry: registry(anthropic),
			session: { model: anthropic[0], modelSource: "session", thinkingLevel: "high", permission: { mode: "auto", classifier: "anthropic/claude-sonnet-5", pinned: true } },
		});
		expect(report.ready).toBe(true);
		const text = renderDoctorText(report, 200);
		expect(text).toContain("Main: anthropic/claude-opus-5 — $5/M in · $25/M out · 200k context · this session");
		expect(text).toContain("frontier tier");
		expect(text).toContain("Effort: high");
		// Automatic subagent pick: cheapest capable strictly cheaper model on the same provider.
		expect(text).toContain("Subagents and workflow agents: anthropic/claude-sonnet-5 — automatic");
		// Classifier: workhorse floor on a frontier session → Sonnet, and the live pin is shown.
		expect(text).toContain("Auto-mode classifier: anthropic/claude-sonnet-5");
		expect(text).toContain("screening this session on anthropic/claude-sonnet-5");
		expect(text).toContain("Permission mode: auto");
		expect(text).toContain("Updates: up to date (0.2.1 is the latest release)");
		expect(text).toContain("ANTHROPIC (anthropic): ready — key saved by /login · 3 models");
		expect(text).toContain("2 more providers without credentials");
		expect(report.summary).toMatch(/^Ready\. Main model anthropic\/claude-opus-5, subagents on anthropic\/claude-sonnet-5, auto-mode classifier anthropic\/claude-sonnet-5\./);
	});

	it("warns when the hosting pi is outside the tested range", () => {
		const report = buildDoctorReport({ env: environment({ install: "pi-package", piVersion: "0.90.0" }), registry: registry(anthropic), session: { model: anthropic[1], modelSource: "session" } });
		expect(report.findings.some((f) => f.text.includes("tested against pi"))).toBe(true);
		expect(renderDoctorText(report, 200)).toContain("Running: one-code-extension 0.2.1 on your own pi · pi 0.90.0");
	});

	it("shows the newer version and the upgrade command when behind", () => {
		const report = buildDoctorReport({ env: environment({ latest: { status: "behind", version: "0.3.0" } }), registry: registry(anthropic), session: { model: anthropic[1], modelSource: "session" } });
		expect(renderDoctorText(report, 200)).toContain("Updates: 0.3.0 is available (you have 0.2.1) — npm install -g @one-ai/one-code");
	});

	it("flags a tiny-tier main model and an unpriced one", () => {
		const tiny = model("groq", "llama-3.3-8b", 0.05, "openai-completions");
		const report = buildDoctorReport({ env: environment(), registry: registry([tiny]), session: { model: tiny, modelSource: "session" } });
		expect(report.findings.some((f) => f.text.includes("tiny-tier"))).toBe(true);
		const unpriced = model("ollama", "local-model", undefined, "openai-completions");
		const facts = collectModelFacts([unpriced], { model: unpriced, modelSource: "session" }, home, {});
		const section = modelsSection(facts, { model: unpriced, modelSource: "session" }, []);
		expect(section.lines.some((l) => l.text.includes("carries no price"))).toBe(true);
	});

	it("explains the capability floor: a key hint without a snapshot, the measured verdicts with one", () => {
		// No key, no snapshot → a warning finding with the advice.
		const findings: Finding[] = [];
		const facts = collectModelFacts(anthropic, { model: anthropic[0], modelSource: "session" }, home, {});
		expect(facts.capability).toMatchObject({ keyConfigured: false, snapshot: undefined });
		const section = modelsSection(facts, { model: anthropic[0], modelSource: "session" }, findings);
		expect(section.lines.some((l) => l.text.startsWith("Capability scores: none"))).toBe(true);
		expect(findings.some((f) => f.text.includes("No Artificial Analysis key") && f.fix?.includes("AA_API_KEY"))).toBe(true);

		// Key configured, snapshot not fetched yet → a dim explanation, no warning.
		mkdirSync(join(home, ".onecode"), { recursive: true });
		writeFileSync(join(home, ".onecode", "settings.json"), JSON.stringify({ capabilityIndex: { artificialAnalysisApiKey: "aa_x" } }));
		const pending = collectModelFacts(anthropic, { model: anthropic[0], modelSource: "session" }, home, {});
		expect(pending.capability.keyConfigured).toBe(true);
		expect(modelsSection(pending, { model: anthropic[0], modelSource: "session" }, []).lines.some((l) => l.text.includes("snapshot not fetched yet"))).toBe(true);

		// A snapshot with confirmed scores → the verdict each automatic pick was judged on, with attribution.
		setModelFactsForTest({ "zai/glm-5.3": { releaseDate: "2026-08-14" }, "zai/glm-5.3-flash": { releaseDate: "2026-08-26" } });
		setCapabilitySnapshotForTest(
			snapshotFromResponse(JSON.parse(readFileSync(join(FIXTURES, "artificial-analysis-sample.json"), "utf8")), new Date("2026-09-10T12:00:00Z")),
		);
		const zai = [model("zai", "glm-5.3", 1.4, "openai-completions"), model("zai", "glm-5.3-flash", 0.075, "openai-completions")];
		const measured = collectModelFacts(zai, { model: zai[0], modelSource: "session" }, home, {});
		expect(measured.classifier.model?.id).toBe("glm-5.3-flash");
		expect(measured.capability.classifier).toMatchObject({ verdict: "pass", floor: 71.5 });
		expect(measured.capability.subagent).toMatchObject({ verdict: "pass" });
		const text = modelsSection(measured, { model: zai[0], modelSource: "session" }, []).lines.map((l) => l.text);
		expect(text.some((t) => t.startsWith("Capability scores: Artificial Analysis snapshot, 25 models"))).toBe(true);
		expect(text.some((t) => t.startsWith("Classifier pick: coding index 71.5 vs floor 71.5"))).toBe(true);
		expect(text).toContain("Scores: Artificial Analysis (https://artificialanalysis.ai)");
	});

	it("reads the subagent and classifier settings from One Code's own file", () => {
		mkdirSync(join(home, ".onecode"), { recursive: true });
		writeFileSync(
			join(home, ".onecode", "settings.json"),
			JSON.stringify({ subagentModel: "inherit", autoMode: { classifierModel: "anthropic/claude-haiku-4-5", classifierModelSetFor: "anthropic" } }),
		);
		const facts = collectModelFacts(anthropic, { model: anthropic[0], modelSource: "session" }, home, {});
		expect(facts.subagent.source).toBe("session");
		expect(facts.subagentConfigured?.spec).toBe("inherit");
		expect(facts.classifier.model?.id).toBe("claude-haiku-4-5");
		expect(facts.classifier.description).toContain("from autoMode.classifierModel");
	});
});

describe("renderDoctorReport", () => {
	it("wraps long values under their bullet and never exceeds the width", () => {
		const lines = renderDoctorReport(
			{
				title: "One Code doctor",
				summary: "s",
				sections: [{ title: "T", lines: [{ text: "x".repeat(150), level: "ok" }, { text: "sub", indent: 1, level: "dim" }] }],
				findings: [{ level: "warn", text: "w".repeat(90), fix: "run the install command and then start One Code again from the same shell" }],
				ready: true,
			},
			{ width: 60 },
		);
		expect(lines.every((line) => line.length <= 60)).toBe(true);
		expect(lines).toContain("└ ✔ " + "x".repeat(56));
		expect(lines).toContain("    " + "x".repeat(56));
		expect(lines).toContain("  └ sub");
		expect(lines.some((line) => line.startsWith("Issues (1 warning)"))).toBe(true);
		expect(lines.some((line) => line.startsWith("  Fix: "))).toBe(true);
	});

	it("closes with the all-clear line when there are no findings", () => {
		const lines = renderDoctorReport({ title: "t", summary: "s", sections: [], findings: [], ready: true });
		expect(lines.at(-1)).toBe("No setup issues found.");
	});
});

describe("shortenHome", () => {
	it("folds only paths under home, never a sibling directory sharing the prefix", async () => {
		const { shortenHome } = await import("../../extensions/doctor/report.ts");
		expect(shortenHome("/Users/bob/.claude/settings.json", "/Users/bob")).toBe("~/.claude/settings.json");
		expect(shortenHome("/Users/bobby/.claude/settings.json", "/Users/bob")).toBe("/Users/bobby/.claude/settings.json");
		expect(shortenHome("/Users/bob", "/Users/bob")).toBe("~");
	});
});
