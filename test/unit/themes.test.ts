import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * pi requires all 51 colour tokens; a missing or misspelled one is rejected at
 * load time with no visual clue which theme broke, so assert the shape here.
 */
const REQUIRED = `accent border borderAccent borderMuted success error warning muted dim text
thinkingText selectedBg userMessageBg userMessageText customMessageBg customMessageText
customMessageLabel toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput mdHeading
mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet
toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction
syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation
thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode`
	.split(/\s+/)
	.filter(Boolean);

const themesDir = join(import.meta.dirname, "..", "..", "themes");
const themeFiles = readdirSync(themesDir).filter((f) => f.endsWith(".json"));

describe("bundled themes", () => {
	it("ships at least one theme", () => {
		expect(themeFiles.length).toBeGreaterThan(0);
		expect(REQUIRED).toHaveLength(51);
	});

	for (const file of themeFiles) {
		describe(file, () => {
			const theme = JSON.parse(readFileSync(join(themesDir, file), "utf-8")) as {
				name?: string;
				vars?: Record<string, string | number>;
				colors?: Record<string, string | number>;
			};

			it("has a name matching its filename and no slash", () => {
				expect(theme.name).toBe(file.replace(/\.json$/, ""));
				expect(theme.name).not.toContain("/");
			});

			it("defines every required colour token", () => {
				const missing = REQUIRED.filter((token) => !(token in (theme.colors ?? {})));
				expect(missing, `missing tokens in ${file}`).toEqual([]);
			});

			it("defines no unknown tokens beyond the optional two", () => {
				const allowed = new Set([...REQUIRED, "thinkingMax", "scrollbarThumb"]);
				const unknown = Object.keys(theme.colors ?? {}).filter((k) => !allowed.has(k));
				expect(unknown, `unknown tokens in ${file}`).toEqual([]);
			});

			it("resolves every var reference", () => {
				const vars = new Set(Object.keys(theme.vars ?? {}));
				const unresolved = Object.entries(theme.colors ?? {})
					.filter(([, value]) => typeof value === "string" && value !== "" && !value.startsWith("#"))
					.filter(([, value]) => !vars.has(value as string))
					.map(([token, value]) => `${token}=${value}`);
				expect(unresolved, `unresolved var references in ${file}`).toEqual([]);
			});

			it("uses only hex colours or ANSI indexes in vars", () => {
				for (const [name, value] of Object.entries(theme.vars ?? {})) {
					if (typeof value === "number") expect(value, name).toBeLessThanOrEqual(255);
					else expect(value, name).toMatch(/^#[0-9a-fA-F]{6}$/);
				}
			});
		});
	}
});
