/**
 * /doctor's imported-configuration section on a profile with no source
 * provider: it reads no other tool's files, so it names none. A sentence
 * about a provider's files takes the provider's name
 * (lib/profile/sources.ts `sourceName`; One Code's: profile/test/doctor-compat.test.ts).
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCompat, importedConfigSection } from "../../extensions/commands/doctor/compat.ts";
import { brand } from "../../extensions/lib/profile/brand.mjs";
import { setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { sourceName } from "../../extensions/lib/profile/sources.ts";
import { rulesetOwner } from "../../extensions/safety/permissions/auto-mode/classifier-prompt.ts";
import { useProfile } from "./helpers/profile.ts";
import { tempHome } from "./helpers/temp-home.ts";

afterEach(() => setActiveProfileForTest(undefined));

describe("a profile with no source provider", () => {
	it("names no other tool in /doctor's imported configuration", () => {
		useProfile({});
		const { home, cwd } = tempHome("doctor-no-provider-");
		expect(sourceName(home)).toBeUndefined();
		const compat = collectCompat({ cwd, home, agentDir: join(home, brand.stateDir, "agent"), env: { HOME: home, PATH: "" } as NodeJS.ProcessEnv });
		const section = importedConfigSection(compat, home);
		expect(section.subtitle).toBe(`what ${brand.name} reads from your ${brand.name} files`);
		const text = section.lines.map((line) => line.text).join("\n");
		expect(text).toContain(`Plugins: 0/0 installed by ${brand.name}`);
		expect(text).toContain(`Instruction files: none (no AGENTS.md or ${brand.productFile} from here to the repository root)`);
		expect(text).not.toMatch(/shared with|-installed enabled/);
	});

	it("says whose the built-in ruleset is only when the profile's text does", () => {
		const owner = rulesetOwner();
		expect(owner === undefined || owner.endsWith("'s")).toBe(true);
	});
});
