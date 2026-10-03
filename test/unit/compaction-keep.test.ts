import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoctorReport } from "../../extensions/doctor/build.ts";
import { renderDoctorText } from "../../extensions/doctor/report.ts";
import { compactionKeepView, keepWindowFix, withCompactionKeepBackfilled } from "../../extensions/lib/compaction-keep.mjs";

describe("withCompactionKeepBackfilled", () => {
	it("sets 0 when the user has not set a keep window, keeping their other keys", () => {
		expect(withCompactionKeepBackfilled({ theme: "onecode" })).toEqual({ settings: { theme: "onecode", compaction: { keepRecentTokens: 0 } }, changed: true });
		expect(withCompactionKeepBackfilled({ compaction: { enabled: false } }).settings).toEqual({ compaction: { enabled: false, keepRecentTokens: 0 } });
	});

	it("never rewrites an explicit value or a malformed compaction field", () => {
		const explicit = { compaction: { keepRecentTokens: 20000 } };
		expect(withCompactionKeepBackfilled(explicit)).toEqual({ settings: explicit, changed: false });
		const malformed = { compaction: "off" };
		expect(withCompactionKeepBackfilled(malformed)).toEqual({ settings: malformed, changed: false });
	});
});

describe("compactionKeepView", () => {
	it("follows pi's merge: project over user over the default", () => {
		expect(compactionKeepView({}, {})).toEqual({ value: 20000, source: "default" });
		expect(compactionKeepView({ compaction: { keepRecentTokens: 0 } }, {})).toEqual({ value: 0, source: "user" });
		expect(compactionKeepView({ compaction: { keepRecentTokens: 0 } }, { compaction: { keepRecentTokens: 5000 } })).toEqual({ value: 5000, source: "project" });
		expect(keepWindowFix("/p/.pi/settings.json")).toBe('Set "compaction": { "keepRecentTokens": 0 } in /p/.pi/settings.json, then restart.');
		const overrides = { compaction: { keepRecentTokens: 0, modelOverrides: { "anthropic/claude-opus-5-5": { keepRecentTokens: 30000 } } } };
		expect(compactionKeepView(overrides, {}, "anthropic/claude-opus-5-5")).toEqual({ value: 30000, source: "user", model: "anthropic/claude-opus-5-5" });
		expect(compactionKeepView(overrides, {}, "openai/gpt-6.1-sol")).toEqual({ value: 0, source: "user" });
		expect(keepWindowFix("~/s.json", "anthropic/claude-opus-5-5")).toContain('"modelOverrides": { "anthropic/claude-opus-5-5": { "keepRecentTokens": 0 } }');
	});
});

describe("/doctor's keep-window line", () => {
	const report = (compactionKeep: { value: number; source: "default" | "user" | "project" }) => {
		const home = mkdtempSync(join(tmpdir(), "onecode-keep-"));
		try {
			return renderDoctorText(
				buildDoctorReport({
					env: {
						cwd: home,
						home,
						agentDir: join(home, ".pi", "agent"),
						stateDir: join(home, ".onecode"),
						configMode: "claude-compatible",
						env: { PATH: join(home, "empty-bin"), HOME: home },
						platform: "darwin",
						arch: "arm64",
						nodeVersion: "26.3.1",
						oneCodeVersion: "0.5.0",
						install: "pi-package",
						piVersion: "0.99.2",
						compactionKeep: { ...compactionKeep, paths: { user: join(home, ".pi", "agent", "settings.json"), project: join(home, ".pi", "settings.json") } },
					},
					registry: { all: [], available: [], authOf: () => undefined } as never,
					session: { modelSource: "none" },
				}),
				200,
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	};

	it("is quiet at 0 and names the fix above it", () => {
		expect(report({ value: 0, source: "user" })).toContain("pi's compaction keep window: 0");
		const warned = report({ value: 20000, source: "default" });
		expect(warned).toContain("pi's compaction keep window: 20000 tokens (pi's default)");
		expect(warned).toContain(`"keepRecentTokens": 0 } in ~/.pi/agent/settings.json`);
	});
});
