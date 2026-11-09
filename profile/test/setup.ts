/**
 * One Code's part of the unit-test setup, run after the base's test/setup.ts
 * (vitest.config.ts adds it when the profile in force has one).
 */
import { beforeAll, beforeEach } from "vitest";
import { join } from "node:path";
import { PROFILE_DIR, profileModuleKey } from "../../extensions/lib/profile.ts";
import { shareModuleForTest } from "../../extensions/lib/shared-module.ts";
import { profile } from "../index.ts";

// One Code's source provider loads on first use (lib/profile.ts sourceProvider).
// Imported here once the test file is, so the lib/ modules it pulls in load
// under the file's own vi.mock calls; set again for each file. The config mode
// is part of the provider and is imported the same way, for the same reason.
if (!profile.sources) throw new Error("One Code's profile names its source provider");
const sourcesModule = join(PROFILE_DIR, profile.sources);
let resetConfigMode: (typeof import("../claude-code/mode.ts"))["resetConfigModeForTest"];
beforeAll(async () => {
	shareModuleForTest(profileModuleKey(sourcesModule), await import("../claude-code/sources.ts"));
	resetConfigMode = (await import("../claude-code/mode.ts")).resetConfigModeForTest;
});

// Claude-compatible mode regardless of the machine's ~/.onecode/settings.json;
// a test of independent mode pins it with resetConfigModeForTest("independent").
beforeEach(() => resetConfigMode("claude-compatible"));
