/**
 * One Code's part of the unit-test setup, run after the base's test/setup.ts
 * (vitest.config.ts adds it when the profile in force has one).
 */
import { beforeAll, beforeEach } from "vitest";
import { join } from "node:path";
import { resetConfigModeForTest } from "../claude-code/mode.ts";
import { PROFILE_DIR, profileModuleKey } from "../../extensions/lib/profile.ts";
import { shareModuleForTest } from "../../extensions/lib/shared-module.ts";
import { profile } from "../index.ts";

// One Code's source provider loads on first use (lib/profile.ts sourceProvider).
// Imported here once the test file is, so the lib/ modules it pulls in load
// under the file's own vi.mock calls; set again for each file.
const sourcesModule = join(PROFILE_DIR, profile.sources ?? "");
beforeAll(async () => shareModuleForTest(profileModuleKey(sourcesModule), await import("../claude-code/sources.ts")));

// Claude-compatible mode regardless of the machine's ~/.onecode/settings.json;
// a test of independent mode pins it with resetConfigModeForTest("independent").
resetConfigModeForTest("claude-compatible");
beforeEach(() => resetConfigModeForTest("claude-compatible"));
