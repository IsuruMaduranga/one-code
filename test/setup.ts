import { beforeEach } from "vitest";
import { setCapabilitySnapshotForTest } from "../extensions/lib/capability-index.ts";
import { setModelFactsForTest } from "../extensions/lib/model-facts.ts";
import { bashParserReady } from "../extensions/lib/bash-parser.ts";
import { resetConfigModeForTest } from "../extensions/lib/config-mode.ts";

// Hermetic by default: no bundled model facts (see vitest.config.ts). A test
// that wants the real table calls `setModelFactsForTest(undefined)` itself and
// gets reset before the next test.
setModelFactsForTest({});
beforeEach(() => setModelFactsForTest({}));

// Likewise no Artificial Analysis snapshot: every capability verdict is
// "unscored" unless a test pins one with setCapabilitySnapshotForTest.
setCapabilitySnapshotForTest(undefined);
beforeEach(() => setCapabilitySnapshotForTest(undefined));

// Claude-compatible mode regardless of the machine's ~/.onecode/settings.json;
// a test of independent mode pins it with resetConfigModeForTest("independent").
resetConfigModeForTest("claude-compatible");
beforeEach(() => resetConfigModeForTest("claude-compatible"));

// The bash grammar loads asynchronously; every shell parse after this is
// synchronous, as it is once a session's hooks have awaited it.
await bashParserReady();
