import { beforeAll, beforeEach } from "vitest";
import { emptyCatalogSources, setCatalogSourcesForTest } from "../extensions/lib/model-catalog-data.ts";
import { setModelTierOverridesForTest } from "../extensions/lib/model-tier.ts";
import { bashParserReady } from "../extensions/lib/bash-parser.ts";
import { resetConfigModeForTest } from "../extensions/lib/config-mode.ts";
import { shareShippedProfileForTest } from "../extensions/lib/profile.ts";
import { profile } from "../profile/index.ts";
import { INSTRUCTION_PROVIDER } from "../profile/claude-code/index.ts";
import { shareModuleForTest } from "../extensions/lib/shared-module.ts";

// The shipped profile through the test run's own module graph (lib/profile.ts
// loads it on demand under jiti, where vitest's import is not the one used).
shareShippedProfileForTest(profile);
// One Code's instruction provider loads on first use (profile/claude-code/index.ts).
// Imported here once the test file is, so the lib/ modules it pulls in load
// under the file's own vi.mock calls; set again for each file.
beforeAll(async () => shareModuleForTest(INSTRUCTION_PROVIDER, await import("../profile/claude-code/instructions.ts")));

// Hermetic by default: an empty model catalog (see vitest.config.ts), so every
// model takes the no-catalog rules unless a test pins sources with
// `setCatalogSourcesForTest` (test/unit/catalog-fixture.ts builds them); the
// catalog-wide snapshot test reads the bundled copy. Reset before each test.
setCatalogSourcesForTest(emptyCatalogSources());
beforeEach(() => setCatalogSourcesForTest(emptyCatalogSources()));

// Likewise no `modelTiers` from the machine's ~/.onecode/settings.json.
setModelTierOverridesForTest({});
beforeEach(() => setModelTierOverridesForTest({}));

// Claude-compatible mode regardless of the machine's ~/.onecode/settings.json;
// a test of independent mode pins it with resetConfigModeForTest("independent").
resetConfigModeForTest("claude-compatible");
beforeEach(() => resetConfigModeForTest("claude-compatible"));

// ~/.claude paths follow each test's own home, whatever the shell says: CLAUDE_CONFIG_DIR inherited
// from the environment (a probe harness, a user's own setup) moved every
// ~/.claude path and failed 71 tests. A test that wants it stubs it.
delete process.env.CLAUDE_CONFIG_DIR;

// Likewise the live permission mode One Code publishes to child processes:
// run from a One Code shell, the suite inherited CC_PERMISSION_MODE=auto and
// 16 permission-gate and workflow tests failed. A test that wants it stubs it.
delete process.env.CC_PERMISSION_MODE;

// The bash grammar loads asynchronously; every shell parse after this is
// synchronous, as it is once a session's hooks have awaited it.
await bashParserReady();
